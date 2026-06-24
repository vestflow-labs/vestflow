import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  rpc as StellarRpc,
  xdr,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  getAddress,
  signTransaction,
  isConnected,
  requestAccess,
} from "@stellar/freighter-api";

export const NETWORK = process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
export const RPC_URL = NETWORK === "mainnet"
  ? "https://mainnet.sorobanrpc.com"
  : "https://soroban-testnet.stellar.org";
export const CONTRACT_ID =
  process.env.NEXT_PUBLIC_CONTRACT_ID ??
  "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX";
export const NATIVE_TOKEN =
  process.env.NEXT_PUBLIC_NATIVE_TOKEN ??
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const server = new StellarRpc.Server(RPC_URL);

// Well-known funded testnet account used as fallback source for read-only simulations.
const FALLBACK_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ---------- Wallet ----------

export async function connectWallet(): Promise<string> {
  const connected = await isConnected();
  if (!connected) throw new Error("Freighter not found. Install from freighter.app");
  await requestAccess();
  const result = await getAddress();
  if (!result?.address) throw new Error("Could not get address from Freighter");
  return result.address;
}

// ---------- Read ----------

async function simulate(method: string, args: xdr.ScVal[], publicKey?: string): Promise<xdr.ScVal> {
  const contract = new Contract(CONTRACT_ID);
  const source = publicKey ?? FALLBACK_ACCOUNT;
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(result)) throw new Error((result as any).error);
  return (result as any).result!.retval;
}

export async function getSchedule(id: number, publicKey?: string): Promise<ScheduleData | null> {
  try {
    const val = await simulate("get_schedule", [nativeToScVal(id, { type: "u64" })], publicKey);
    return parseSchedule(scValToNative(val));
  } catch { return null; }
}

export async function getScheduleCount(): Promise<number> {
  try {
    const val = await simulate("schedule_count", []);
    return Number(scValToNative(val));
  } catch { return 0; }
}

export async function getSchedulesByGrantor(grantor: string): Promise<number[]> {
  try {
    const val = await simulate("get_schedules_by_grantor", [
      nativeToScVal(grantor, { type: "address" }),
    ]);
    return (scValToNative(val) as number[]).map(Number);
  } catch { return []; }
}

export async function getSchedulesByBeneficiary(beneficiary: string): Promise<number[]> {
  try {
    const val = await simulate("get_schedules_by_beneficiary", [
      nativeToScVal(beneficiary, { type: "address" }),
    ]);
    return (scValToNative(val) as number[]).map(Number);
  } catch { return []; }
}

export async function getClaimable(id: number, publicKey?: string): Promise<bigint> {
  try {
    const val = await simulate("claimable", [nativeToScVal(id, { type: "u64" })], publicKey);
    return BigInt(scValToNative(val));
  } catch { return 0n; }
}

/**
 * Fetch claimable amounts for every schedule ID in a single simulation
 * round-trip by calling the `claimable_bulk` contract view function.
 *
 * Returns amounts in the same order as `ids`. Unknown IDs return 0n.
 */
export async function getClaimableBulk(
  ids: number[],
  publicKey?: string
): Promise<bigint[]> {
  if (ids.length === 0) return [];
  try {
    const idsVal = xdr.ScVal.scvVec(
      ids.map((id) => nativeToScVal(id, { type: "u64" }))
    );
    const val = await simulate("claimable_bulk", [idsVal], publicKey);
    const native = scValToNative(val) as bigint[];
    return native.map((v) => BigInt(v));
  } catch {
    // Fallback: return zeros so callers always get a valid array
    return ids.map(() => 0n);
  }
}

export async function getAllSchedules(publicKey?: string): Promise<ScheduleData[]> {
  const count = await getScheduleCount();
  if (count === 0) return [];

  // Fetch all schedule structs in parallel (N calls)
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const [schedules, _claimableAmounts] = await Promise.all([
    Promise.all(ids.map((id) => getSchedule(id, publicKey))),
    getClaimableBulk(ids, publicKey), // single simulation round-trip
  ]);

  return schedules.filter(Boolean) as ScheduleData[];
}

// ---------- Write ----------

async function buildAndSend(publicKey: string, method: string, args: xdr.ScVal[]): Promise<string> {
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(publicKey);
  let tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) throw new Error((simResult as any).error);
  tx = StellarRpc.assembleTransaction(tx, simResult as any).build();

  const signed = await signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
  const xdrStr = typeof signed === "string" ? signed : (signed as any).signedTxXdr;
  const submitted = await server.sendTransaction(
    TransactionBuilder.fromXDR(xdrStr, NETWORK_PASSPHRASE)
  );
  if (submitted.status === "ERROR") throw new Error("Transaction failed");

  let status: any = { status: "PENDING" };
  while (status.status === "PENDING" || status.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    status = await server.getTransaction(submitted.hash);
  }
  return submitted.hash;
}

export async function createSchedule(
  publicKey: string,
  beneficiary: string,
  totalAmountXlm: number,
  startTime: number,
  durationDays: number,
  cliffDays: number,
  kind: "Linear" | "Cliff" | "LinearWithCliff",
  revocable: boolean
): Promise<string> {
  const totalStroops = BigInt(Math.round(totalAmountXlm * 10_000_000));
  const durationSecs = durationDays * 86400;
  const cliffSecs = cliffDays * 86400;

  const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]);

  const args: xdr.ScVal[] = [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(beneficiary, { type: "address" }),
    nativeToScVal(NATIVE_TOKEN, { type: "address" }),
    nativeToScVal(totalStroops, { type: "i128" }),
    nativeToScVal(startTime, { type: "u64" }),
    nativeToScVal(durationSecs, { type: "u64" }),
    nativeToScVal(cliffSecs, { type: "u64" }),
    kindVal,
    nativeToScVal(revocable, { type: "bool" }),
  ];
  return buildAndSend(publicKey, "create_schedule", args);
}

export async function claimVested(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "claim", [nativeToScVal(scheduleId, { type: "u64" })]);
}

export async function revokeSchedule(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "revoke", [nativeToScVal(scheduleId, { type: "u64" })]);
}

// ---------- Admin Recovery ----------

export interface RecoveryRequest {
  schedule_id: number;
  new_beneficiary: string;
  requested_by: string;
  requested_at: number;
  executable_at: number;
}

/**
 * Read the pending recovery request for a schedule, if any.
 * Returns null if no request is open.
 */
export async function getRecoveryRequest(
  scheduleId: number,
  publicKey?: string
): Promise<RecoveryRequest | null> {
  try {
    const val = await simulate(
      "recovery_request",
      [nativeToScVal(scheduleId, { type: "u64" })],
      publicKey
    );
    const native = scValToNative(val);
    if (!native) return null;
    return {
      schedule_id: Number(native.schedule_id ?? scheduleId),
      new_beneficiary: native.new_beneficiary?.toString() ?? "",
      requested_by: native.requested_by?.toString() ?? "",
      requested_at: Number(native.requested_at ?? 0),
      executable_at: Number(native.executable_at ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * File an emergency recovery request.
 * Only the grantor of the schedule may call this.
 * Starts a 7-day timelock before the admin can redirect the beneficiary.
 */
export async function requestAdminRecovery(
  publicKey: string,
  scheduleId: number,
  newBeneficiary: string
): Promise<string> {
  return buildAndSend(publicKey, "request_admin_recovery", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(scheduleId, { type: "u64" }),
    nativeToScVal(newBeneficiary, { type: "address" }),
  ]);
}

/**
 * Cancel a pending recovery request.
 * May be called by the grantor who filed it, or by the upgrade authority.
 */
export async function cancelAdminRecovery(
  publicKey: string,
  scheduleId: number
): Promise<string> {
  return buildAndSend(publicKey, "cancel_admin_recovery", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(scheduleId, { type: "u64" }),
  ]);
}

/**
 * Execute a pending recovery after the 7-day timelock.
 * Only callable by the upgrade authority address.
 */
export async function executeAdminRecovery(
  publicKey: string,
  scheduleId: number
): Promise<string> {
  return buildAndSend(publicKey, "execute_admin_recovery", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(scheduleId, { type: "u64" }),
  ]);
}

// ---------- Types ----------

export interface ScheduleData {
  id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: bigint;
  claimed: bigint;
  start_time: number;
  duration: number;
  cliff_duration: number;
  kind: "Linear" | "Cliff" | "LinearWithCliff";
  revocable: boolean;
  revoked: boolean;
}

function parseSchedule(raw: any): ScheduleData {
  return {
    id: Number(raw.id),
    grantor: raw.grantor?.toString() ?? "",
    beneficiary: raw.beneficiary?.toString() ?? "",
    token: raw.token?.toString() ?? "",
    total_amount: BigInt(raw.total_amount ?? 0),
    claimed: BigInt(raw.claimed ?? 0),
    start_time: Number(raw.start_time ?? 0),
    duration: Number(raw.duration ?? 0),
    cliff_duration: Number(raw.cliff_duration ?? 0),
    kind: raw.kind === "Cliff" ? "Cliff" : raw.kind === "LinearWithCliff" ? "LinearWithCliff" : "Linear",
    revocable: Boolean(raw.revocable),
    revoked: Boolean(raw.revoked),
  };
}

// ---------- Helpers ----------

export function stroopsToXlm(s: bigint): string {
  return (Number(s) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function truncate(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (addr.length <= prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}

export function vestingProgress(s: ScheduleData, now: number): number {
  if (now < s.start_time) return 0;
  const elapsed = now - s.start_time;
  return Math.min(100, Math.round((elapsed / s.duration) * 100));
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

export function parseContractError(e: Error): string {
  const msg = e.message;
  if (msg.includes("Nothing to claim yet")) return "No tokens are available to claim yet.";
  if (msg.includes("Schedule is not revocable")) return "This schedule cannot be revoked.";
  if (msg.includes("Already revoked")) return "This schedule has already been revoked.";
  if (msg.includes("Not the grantor")) return "Only the grantor can perform this action.";
  if (msg.includes("Not the beneficiary")) return "Only the beneficiary can claim tokens.";
  if (msg.includes("Schedule not found")) return "Schedule not found.";
  if (msg.includes("Insufficient balance")) return "Insufficient balance to complete this action.";
  if (msg.includes("Schedule has ended")) return "This vesting schedule has already ended.";
  if (msg.includes("Start time in the past")) return "The start time must be in the future.";
  if (msg.includes("Duration too short")) return "The vesting duration is too short.";
  if (msg.includes("Recovery request already pending")) return "A recovery request is already pending for this schedule.";
  if (msg.includes("No pending recovery")) return "No recovery request found for this schedule.";
  if (msg.includes("Recovery timelock still active")) return "The 7-day recovery timelock has not elapsed yet.";
  if (msg.includes("New beneficiary must differ from current")) return "The new beneficiary address must differ from the current one.";
  if (msg.includes("Unauthorized upgrade authority")) return "Only the upgrade authority can execute recoveries.";
  return msg;
}
