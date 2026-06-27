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
 * Preview how many tokens will be claimable at an arbitrary future timestamp.
 *
 * Calls the `claimable_at_timestamp` contract view, which projects the
 * current schedule state forward to `ts`. Accurate for future timestamps;
 * for past timestamps the result may differ from what was historically
 * claimable because it uses the current claimed_amount.
 *
 * Returns 0n for unknown schedule IDs.
 */
export async function getClaimableAtTimestamp(
  id: number,
  ts: number,
  publicKey?: string
): Promise<bigint> {
  try {
    const val = await simulate(
      "claimable_at_timestamp",
      [nativeToScVal(id, { type: "u64" }), nativeToScVal(ts, { type: "u64" })],
      publicKey
    );
    return BigInt(scValToNative(val));
  } catch {
    return 0n;
  }
}

/**
 * Fetch multiple schedules in a single simulation round-trip by calling
 * the `get_schedule_batch` contract view.
 *
 * Returns results in the same order as `ids`. Unknown IDs return null.
 * Replaces the Promise.all(getSchedule) N-call pattern, reducing N RPC
 * calls to 1.
 */
export async function getScheduleBatch(
  ids: number[],
  publicKey?: string
): Promise<(ScheduleData | null)[]> {
  if (ids.length === 0) return [];
  try {
    const idsVal = xdr.ScVal.scvVec(
      ids.map((id) => nativeToScVal(id, { type: "u64" }))
    );
    const val = await simulate("get_schedule_batch", [idsVal], publicKey);
    // scValToNative decodes Option<VestingSchedule> as a raw JS object or
    // null/undefined. We must run parseSchedule on each non-null item so
    // Soroban field names (claimed_amount, duration_seconds) are mapped to
    // the ScheduleData interface fields (claimed, duration).
    const rawItems = scValToNative(val) as any[];
    return rawItems.map((raw: any) => (raw == null ? null : parseSchedule(raw)));
  } catch {
    return ids.map(() => null);
  }
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
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  // Single batch call replaces the former Promise.all(getSchedule) N-call pattern.
  const schedules = await getScheduleBatch(ids, publicKey);
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

export function xlmToStroops(amountXlm: string): bigint {
  const normalized = amountXlm.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error("Invalid amount");
  }

  const [whole, fraction = ""] = normalized.split(".");
  const fractionPadded = (fraction + "0000000").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fractionPadded);
}

export async function createSchedule(
  publicKey: string,
  beneficiary: string,
  totalAmountXlm: string,
  tokenAddress: string,
  startTime: number,
  durationDays: number,
  cliffDays: number,
  kind: "Linear" | "Cliff" | "LinearWithCliff",
  revocable: boolean
): Promise<string> {
  const totalStroops = xlmToStroops(totalAmountXlm);
  const durationSecs = durationDays * 86400;
  const cliffSecs = cliffDays * 86400;
  const lockupSecs = cliffSecs;

  const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]);

  const args: xdr.ScVal[] = [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(beneficiary, { type: "address" }),
    nativeToScVal(tokenAddress || NATIVE_TOKEN, { type: "address" }),
    nativeToScVal(totalStroops, { type: "i128" }),
    nativeToScVal(startTime, { type: "u64" }),
    nativeToScVal(durationSecs, { type: "u64" }),
    nativeToScVal(cliffSecs, { type: "u64" }),
    nativeToScVal(lockupSecs, { type: "u64" }),
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

export async function transferGrantor(
  publicKey: string,
  scheduleId: number,
  newGrantor: string
): Promise<string> {
  return buildAndSend(publicKey, "transfer_grantor", [
    nativeToScVal(scheduleId, { type: "u64" }),
    nativeToScVal(newGrantor, { type: "address" }),
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
  lockup_duration: number;
  kind: "Linear" | "Cliff" | "LinearWithCliff" | "Graded";
  revocable: boolean;
  revoked: boolean;
  milestones?: { pct: number; timestamp: number }[];
}

function parseSchedule(raw: any): ScheduleData {
  return {
    id: Number(raw.id),
    grantor: raw.grantor?.toString() ?? "",
    beneficiary: raw.beneficiary?.toString() ?? "",
    token: raw.token?.toString() ?? "",
    total_amount: BigInt(raw.total_amount ?? 0),
    claimed: BigInt(raw.claimed ?? raw.claimed_amount ?? 0),
    start_time: Number(raw.start_time ?? 0),
    duration: Number(raw.duration ?? raw.duration_seconds ?? 0),
    cliff_duration: Number(raw.cliff_duration ?? raw.cliff_seconds ?? 0),
    lockup_duration: Number(raw.lockup_duration ?? raw.lockup_seconds ?? 0),
    kind:
      raw.kind === "Cliff"
        ? "Cliff"
        : raw.kind === "LinearWithCliff"
        ? "LinearWithCliff"
        : raw.kind === "Graded"
        ? "Graded"
        : "Linear",
    revocable: Boolean(raw.revocable),
    revoked: Boolean(raw.revoked),
    milestones: Array.isArray(raw.milestones)
      ? (raw.milestones as any[]).map((m) => ({
          pct: Number(m.pct ?? m.percent ?? 0),
          timestamp: Number(m.timestamp ?? m.ts ?? 0),
        }))
      : undefined,
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
  if (s.kind === "Graded" && s.milestones && s.milestones.length > 0) {
    return Math.min(
      100,
      s.milestones
        .filter((m) => now >= m.timestamp)
        .reduce((sum, m) => sum + m.pct, 0)
    );
  }
  if (now < s.start_time) return 0;
  const elapsed = now - s.start_time;
  return Math.min(100, Math.round((elapsed / s.duration) * 100));
}

export function formatDate(ts: number): string {
  if (!ts || ts <= 0) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/**
 * Format a cliff timestamp for display.
 * Returns "No cliff" when ts is 0 or cliff_duration is 0 (no cliff configured).
 */
export function formatCliffDate(cliffDuration: number, startTime: number): string {
  if (!cliffDuration || cliffDuration <= 0) return "No cliff";
  return formatDate(startTime + cliffDuration);
}

export function parseContractError(e: Error): string {
  const msg = e.message;
  // Map Soroban VestFlowError variants (Error(Contract, #X))
  if (msg.includes("Contract error: 1") || msg.includes("Contract, #1") || msg.includes("Not authorized")) return "Not authorized to perform this action.";
  if (msg.includes("Contract error: 2") || msg.includes("Contract, #2") || msg.includes("Schedule is not revocable")) return "This schedule cannot be revoked.";
  if (msg.includes("Contract error: 3") || msg.includes("Contract, #3") || msg.includes("Already revoked")) return "This schedule has already been revoked.";
  if (msg.includes("Contract error: 4") || msg.includes("Contract, #4") || msg.includes("Nothing to claim yet")) return "No tokens are available to claim yet.";
  if (msg.includes("Contract error: 5") || msg.includes("Contract, #5") || msg.includes("Schedule not found")) return "Schedule not found.";
  if (msg.includes("Contract error: 6") || msg.includes("Contract, #6") || msg.includes("Duration too short")) return "The vesting duration is too short.";
  if (msg.includes("Contract error: 7") || msg.includes("Contract, #7") || msg.includes("Cliff exceeds duration")) return "The cliff duration cannot exceed the total duration.";
  if (msg.includes("Contract error: 8") || msg.includes("Contract, #8") || msg.includes("Schedule has been revoked")) return "This schedule was revoked.";

  if (msg.includes("Not the grantor")) return "Only the grantor can perform this action.";
  if (msg.includes("Not the beneficiary")) return "Only the beneficiary can claim tokens.";
  if (msg.includes("Insufficient balance")) return "Insufficient balance to complete this action.";
  if (msg.includes("Schedule has ended")) return "This vesting schedule has already ended.";
  if (msg.includes("Start time in the past")) return "The start time must be in the future.";
  return msg;
}
