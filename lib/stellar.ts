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
import { xlmToStroops } from "@/lib/stroops";

export { xlmToStroops } from "@/lib/stroops";

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

/**
 * Stellar minimum reserve in stroops.
 * A new account with 0 subentries needs 2 × 0.5 XLM = 1 XLM (10_000_000 stroops).
 * This constant is a safe conservative floor; accounts with more subentries have
 * a higher reserve, but most Freighter wallets hold the same minimal trustline set.
 */
const XLM_MIN_RESERVE_STROOPS = 10_000_000n; // 1 XLM

/**
 * Fetch the spendable XLM balance for a Stellar public key.
 *
 * Queries the native XLM Stellar Asset Contract's SEP-41 `balance` method
 * (the RPC server's plain `getAccount` doesn't expose Horizon-style balances),
 * then subtracts the Stellar minimum reserve so callers can compare it against
 * a requested amount without risking a reserve error. Returns 0n if the
 * account has no native balance or does not exist.
 *
 * @param publicKey - Stellar G-address to query.
 */
export async function getWalletXlmBalance(publicKey: string): Promise<bigint> {
  try {
    const val = await simulate(
      "balance",
      [nativeToScVal(publicKey, { type: "address" })],
      publicKey,
      NATIVE_TOKEN
    );
    const stroops = scValToNative(val) as bigint;
    const spendable = stroops > XLM_MIN_RESERVE_STROOPS
      ? stroops - XLM_MIN_RESERVE_STROOPS
      : 0n;
    return spendable;
  } catch {
    return 0n;
  }
}

// ---------- Read ----------

async function simulate(
  method: string,
  args: xdr.ScVal[],
  publicKey?: string,
  contractId: string = CONTRACT_ID
): Promise<xdr.ScVal> {
  const contract = new Contract(contractId);
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

export async function isRevoked(id: number, publicKey?: string): Promise<boolean> {
  try {
    const val = await simulate("is_revoked", [nativeToScVal(id, { type: "u64" })], publicKey);
    return Boolean(scValToNative(val));
  } catch { return false; }
}

export async function getContractVersion(): Promise<number> {
  try {
    const val = await simulate("version", []);
    return Number(scValToNative(val));
  } catch {
    return 1;
  }
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

export async function getGrantorScheduleIds(grantor: string): Promise<number[]> {
  try {
    const val = await simulate("grantor_schedule_ids", [
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

export async function getBeneficiaryScheduleIds(beneficiary: string): Promise<number[]> {
  try {
    const val = await simulate("beneficiary_schedule_ids", [
      nativeToScVal(beneficiary, { type: "address" }),
    ]);
    return (scValToNative(val) as number[]).map(Number);
  } catch { return []; }
}

export async function getClaimableAt(id: number, now: number, publicKey?: string): Promise<bigint> {
  try {
    const val = await simulate(
      "claimable_amount",
      [
        nativeToScVal(id, { type: "u64" }),
        nativeToScVal(now, { type: "u64" }),
      ],
      publicKey
    );
    return BigInt(scValToNative(val));
  } catch { return 0n; }
}

export async function getClaimable(id: number, publicKey?: string): Promise<bigint> {
  try {
    const val = await simulate("claimable", [nativeToScVal(id, { type: "u64" })], publicKey);
    return BigInt(scValToNative(val));
  } catch { return 0n; }
}

export async function getVestedAmountAt(id: number, now: number, publicKey?: string): Promise<bigint> {
  try {
    const val = await simulate(
      "vested_amount",
      [
        nativeToScVal(id, { type: "u64" }),
        nativeToScVal(now, { type: "u64" }),
      ],
      publicKey
    );
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

/**
 * Fetch total vested amounts (earned, including already-claimed) for multiple
 * schedule IDs in a single simulation round-trip using the vested_amount_bulk
 * contract view.
 *
 * Returns amounts in the same order as `ids`. Unknown IDs return 0n.
 */
export async function getVestedAmountBulk(
  ids: number[],
  publicKey?: string
): Promise<bigint[]> {
  if (ids.length === 0) return [];
  try {
    const idsVal = xdr.ScVal.scvVec(
      ids.map((id) => nativeToScVal(id, { type: "u64" }))
    );
    const val = await simulate("vested_amount_bulk", [idsVal], publicKey);
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

export interface DripsStreamData {
  funder: string;
  list_id: number;
  member: string;
  token: string;
  amt_per_sec: bigint;
  start_time: number;
}

export async function getDripsStream(
  listId: number,
  member: string,
  publicKey?: string,
): Promise<DripsStreamData | null> {
  try {
    const val = await simulate("get_drips_stream", [
      nativeToScVal(listId, { type: "u64" }),
      nativeToScVal(member, { type: "address" }),
    ], publicKey);
    const stream = scValToNative(val) as any;
    if (!stream) return null;
    return {
      funder: String(stream.funder),
      list_id: Number(stream.list_id),
      member: String(stream.member),
      token: String(stream.token),
      amt_per_sec: BigInt(stream.amt_per_sec ?? 0),
      start_time: Number(stream.start_time ?? 0),
    };
  } catch {
    return null;
  }
}

// ---------- Write ----------

async function sendOp(
  publicKey: string,
  method: string,
  args: xdr.ScVal[]
): Promise<{ hash: string; status: any }> {
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
  return { hash: submitted.hash, status };
}

async function buildAndSend(publicKey: string, method: string, args: xdr.ScVal[]): Promise<string> {
  const { hash } = await sendOp(publicKey, method, args);
  return hash;
}

/**
 * Like `buildAndSend`, but also decodes the invocation's on-chain return
 * value from the confirmed transaction's `returnValue` — needed for
 * `commit_schedule_batch`, whose caller must know the assigned `batch_id`
 * to hand beneficiaries their claim instructions.
 */
async function buildSendAndDecode<T>(
  publicKey: string,
  method: string,
  args: xdr.ScVal[]
): Promise<{ hash: string; value: T }> {
  const { hash, status } = await sendOp(publicKey, method, args);
  if (status.status !== "SUCCESS" || !status.returnValue) {
    throw new Error(`Transaction ${hash} did not return a value (status: ${status.status})`);
  }
  return { hash, value: scValToNative(status.returnValue) as T };
}

export async function createDripsList(publicKey: string, name: string): Promise<string> {
  return buildAndSend(publicKey, "create_drips_list", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(name, { type: "string" }),
  ]);
}

export async function addToDripsList(
  publicKey: string,
  listId: number,
  member: string,
): Promise<string> {
  return buildAndSend(publicKey, "add_to_drips_list", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(listId, { type: "u64" }),
    nativeToScVal(member, { type: "address" }),
  ]);
}

export async function removeFromDripsList(
  publicKey: string,
  listId: number,
  member: string,
): Promise<string> {
  return buildAndSend(publicKey, "remove_from_drips_list", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(listId, { type: "u64" }),
    nativeToScVal(member, { type: "address" }),
  ]);
}

function buildCreateScheduleArgs(
  publicKey: string,
  beneficiary: string,
  totalAmountXlm: string,
  tokenAddress: string,
  startTime: number,
  durationDays: number,
  cliffDays: number,
  kind: "Linear" | "Cliff" | "LinearWithCliff",
  revocable: boolean,
  lockupDays: number = cliffDays
): xdr.ScVal[] {
  const totalStroops = xlmToStroops(totalAmountXlm);
  const durationSecs = durationDays * 86400;
  const cliffSecs = cliffDays * 86400;
  const lockupSecs = lockupDays * 86400;

  const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]);

  return [
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
  revocable: boolean,
  lockupDays: number = cliffDays
): Promise<string> {
  const args = buildCreateScheduleArgs(
    publicKey,
    beneficiary,
    totalAmountXlm,
    tokenAddress,
    startTime,
    durationDays,
    cliffDays,
    kind,
    revocable,
    lockupDays
  );
  return buildAndSend(publicKey, "create_schedule", args);
}

/**
 * Simulates a single `create_schedule` invocation and returns its total
 * estimated fee in stroops (inclusion + Soroban resource fee), without
 * signing or submitting anything. Used to preview costs before a bulk
 * submission — Soroban only allows one invokeHostFunction op per
 * transaction, so this is a per-schedule (not per-batch) estimate.
 */
export async function estimateCreateScheduleFee(
  publicKey: string,
  beneficiary: string,
  totalAmountXlm: string,
  tokenAddress: string,
  startTime: number,
  durationDays: number,
  cliffDays: number,
  kind: "Linear" | "Cliff" | "LinearWithCliff",
  revocable: boolean,
  lockupDays: number = cliffDays
): Promise<bigint> {
  const args = buildCreateScheduleArgs(
    publicKey,
    beneficiary,
    totalAmountXlm,
    tokenAddress,
    startTime,
    durationDays,
    cliffDays,
    kind,
    revocable,
    lockupDays
  );
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("create_schedule", ...args))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(simResult)) throw new Error((simResult as any).error);
  const assembled = StellarRpc.assembleTransaction(tx, simResult as any).build();
  return BigInt(assembled.fee);
}

// ---------- Merkle batch (commit_schedule_batch / claim_schedule_slot) ----------

/** A single beneficiary's proof, as produced by `scripts/merkle-batch.ts` / the `/api/bulk-create/merkle-root` route. */
export interface MerkleBatchBeneficiary {
  rowIndex: number;
  beneficiary: string;
  totalAmountStroops: string;
  durationSecs: number;
  cliffSecs: number;
  startTime: number;
  kind: "Linear" | "Cliff" | "LinearWithCliff" | "Graded";
  revocable: boolean;
  leaf: string;
  proof: string[];
}

export interface MerkleBatch {
  root: string;
  token: string;
  totalStroops: string;
  expiryLedger: number;
  beneficiaries: MerkleBatchBeneficiary[];
}

function bytesArg(hex: string): xdr.ScVal {
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}

/**
 * Commit a Merkle batch: the grantor signs once, depositing `batch.totalStroops`
 * of `batch.token` and locking in `batch.root`. Each beneficiary later calls
 * `claimScheduleSlot` themselves with their own proof from `batch.beneficiaries`.
 */
export async function commitScheduleBatch(
  publicKey: string,
  batch: Pick<MerkleBatch, "token" | "totalStroops" | "root" | "expiryLedger">
): Promise<{ hash: string; batchId: number }> {
  const { hash, value } = await buildSendAndDecode<bigint>(publicKey, "commit_schedule_batch", [
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(batch.token, { type: "address" }),
    nativeToScVal(BigInt(batch.totalStroops), { type: "i128" }),
    bytesArg(batch.root),
    nativeToScVal(batch.expiryLedger, { type: "u32" }),
  ]);
  return { hash, batchId: Number(value) };
}

/**
 * Beneficiary self-service claim: proves inclusion in a committed batch's
 * Merkle tree and creates the corresponding vesting schedule, funded from
 * the batch's deposit. No further grantor signature is required.
 */
export async function claimScheduleSlot(
  publicKey: string,
  batchId: number,
  slot: Pick<
    MerkleBatchBeneficiary,
    "totalAmountStroops" | "durationSecs" | "cliffSecs" | "startTime" | "kind" | "revocable" | "proof"
  >
): Promise<string> {
  const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(slot.kind)]);
  return buildAndSend(publicKey, "claim_schedule_slot", [
    nativeToScVal(batchId, { type: "u64" }),
    nativeToScVal(publicKey, { type: "address" }),
    nativeToScVal(BigInt(slot.totalAmountStroops), { type: "i128" }),
    nativeToScVal(slot.durationSecs, { type: "u64" }),
    nativeToScVal(slot.cliffSecs, { type: "u64" }),
    nativeToScVal(slot.startTime, { type: "u64" }),
    kindVal,
    nativeToScVal(slot.revocable, { type: "bool" }),
    xdr.ScVal.scvVec(slot.proof.map(bytesArg)),
  ]);
}

/** Grantor reclaims a batch's unclaimed deposit after `expiryLedger` has passed. */
export async function reclaimBatch(publicKey: string, batchId: number): Promise<string> {
  return buildAndSend(publicKey, "reclaim_batch", [
    nativeToScVal(batchId, { type: "u64" }),
    nativeToScVal(publicKey, { type: "address" }),
  ]);
}

export async function claimVested(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "claim", [nativeToScVal(scheduleId, { type: "u64" })]);
}

export async function revokeSchedule(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "revoke", [nativeToScVal(scheduleId, { type: "u64" })]);
}

export async function topUpSchedule(
  publicKey: string,
  scheduleId: number,
  amountXlm: string,
): Promise<string> {
  const amountStroops = xlmToStroops(amountXlm);
  return buildAndSend(publicKey, "top_up", [
    nativeToScVal(scheduleId, { type: "u64" }),
    nativeToScVal(amountStroops, { type: "i128" }),
  ]);
}

export async function withdrawSchedule(
  publicKey: string,
  scheduleId: number,
  amountXlm: string,
): Promise<string> {
  const amountStroops = xlmToStroops(amountXlm);
  return buildAndSend(publicKey, "withdraw", [
    nativeToScVal(scheduleId, { type: "u64" }),
    nativeToScVal(amountStroops, { type: "i128" }),
  ]);
}

export async function pauseSchedule(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "pause_schedule", [nativeToScVal(scheduleId, { type: "u64" })]);
}

export async function resumeSchedule(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "resume_schedule", [nativeToScVal(scheduleId, { type: "u64" })]);
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

export async function transferBeneficiary(
  publicKey: string,
  scheduleId: number,
  newBeneficiary: string
): Promise<string> {
  return buildAndSend(publicKey, "transfer_beneficiary", [
    nativeToScVal(scheduleId, { type: "u64" }),
    nativeToScVal(newBeneficiary, { type: "address" }),
  ]);
}

/**
 * Squeeze a stream — collect tokens dripped so far in the current (not yet settled) cycle.
 * The receiver can call this to claim accrued tokens without waiting for full stream settlement.
 */
export async function squeezeStream(publicKey: string, scheduleId: number): Promise<string> {
  return buildAndSend(publicKey, "squeeze_streams", [
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
  lockup_duration: number;
  kind: "Linear" | "Cliff" | "LinearWithCliff" | "Graded";
  revocable: boolean;
  revoked: boolean;
  paused: boolean;
  paused_duration: number;
  paused_at: number;
  requires_milestones: boolean;
  vested_at_revoke: bigint;
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
    paused: Boolean(raw.paused),
    paused_duration: Number(raw.paused_duration ?? 0),
    paused_at: Number(raw.paused_at ?? 0),
    requires_milestones: Boolean(raw.requires_milestones),
    vested_at_revoke: BigInt(raw.vested_at_revoke ?? raw.vested_at_revocation ?? 0),
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
  const whole = s / 10_000_000n;
  const frac = s % 10_000_000n;
  const fractional = frac.toString().padStart(7, "0").replace(/0+$/, "") || "0";
  return `${whole}.${fractional}`;
}

export function truncate(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (addr.length <= prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}

export function vestingProgress(s: ScheduleData, now: number): number {
  // Revoked schedules freeze at the progress captured when revocation
  // happened. The contract stores this as `vested_at_revoke`; using the
  // time-based formula below would keep animating past the revocation point,
  // which is misleading next to the "Revoked" badge.
  if (s.revoked) {
    if (s.total_amount <= 0n) return 0;
    return Math.min(
      100,
      Math.round((Number(s.vested_at_revoke) / Number(s.total_amount)) * 100)
    );
  }
  if (s.kind === "Graded" && s.milestones && s.milestones.length > 0) {
    return Math.min(
      100,
      s.milestones
        .filter((m) => now >= m.timestamp)
        .reduce((sum, m) => sum + m.pct, 0)
    );
  }
  if (now < s.start_time) return 0;
  if (s.duration <= 0) return 100;
  const activePauseSeconds =
    s.paused && s.paused_at > 0 ? Math.max(0, now - s.paused_at) : 0;
  const elapsed = Math.max(0, now - s.start_time - s.paused_duration - activePauseSeconds);
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
  if (msg.includes("Contract error: 1") || msg.includes("Contract, #1")) return "Schedule not found.";
  if (msg.includes("Contract error: 2") || msg.includes("Contract, #2") || msg.includes("Schedule is not revocable")) return "This schedule cannot be revoked.";
  if (msg.includes("Contract error: 3") || msg.includes("Contract, #3") || msg.includes("Already revoked")) return "This schedule has already been revoked.";
  if (msg.includes("Contract error: 4") || msg.includes("Contract, #4") || msg.includes("Nothing to claim yet")) return "No tokens are available to claim yet.";
  if (msg.includes("Contract error: 5") || msg.includes("Contract, #5") || msg.includes("AmountZero")) return "Amount must be greater than zero.";
  if (msg.includes("Contract error: 6") || msg.includes("Contract, #6") || msg.includes("DurationZero")) return "Duration must be greater than zero.";
  if (msg.includes("Contract error: 7") || msg.includes("Contract, #7") || msg.includes("Cliff exceeds duration")) return "The cliff duration cannot exceed the total duration.";
  if (msg.includes("Contract error: 8") || msg.includes("Contract, #8") || msg.includes("Schedule has been revoked")) return "This schedule was revoked.";
  if (msg.includes("Contract error: 15") || msg.includes("Contract, #15") || msg.includes("DurationTooShort")) return "Duration must be at least 60 seconds.";
  if (msg.includes("Contract error: 29") || msg.includes("Contract, #29") || msg.includes("SlotAlreadyClaimed")) return "This beneficiary slot has already been claimed.";
  if (msg.includes("Contract error: 30") || msg.includes("Contract, #30") || msg.includes("BatchExpired")) return "This batch's claim window has expired.";
  if (msg.includes("Contract error: 31") || msg.includes("Contract, #31") || msg.includes("InvalidProof")) return "The Merkle proof did not verify against the batch's committed root.";
  if (msg.includes("Contract error: 32") || msg.includes("Contract, #32") || msg.includes("NotExpired")) return "This batch cannot be reclaimed until its expiry ledger has passed.";
  if (msg.includes("Contract error: 33") || msg.includes("Contract, #33") || msg.includes("ProofTooDeep")) return "The Merkle proof is too deep (max 20 levels).";

  if (msg.includes("Schedule not found")) return "Schedule not found.";
  if (msg.includes("Not authorized")) return "Not authorized to perform this action.";
  if (msg.includes("Duration too short")) return "Duration must be at least 60 seconds.";
  if (msg.includes("Not the grantor")) return "Only the grantor can perform this action.";
  if (msg.includes("Not the beneficiary")) return "Only the beneficiary can claim tokens.";
  if (msg.includes("Insufficient balance")) return "Insufficient balance to complete this action.";
  if (msg.includes("Schedule has ended")) return "This vesting schedule has already ended.";
  if (msg.includes("Start time in the past")) return "The start time must be in the future.";
  if (msg.includes("Schedule already paused")) return "This schedule is already paused.";
  if (msg.includes("Schedule not paused")) return "This schedule is not currently paused.";
  if (msg.includes("Cannot pause revoked schedule")) return "Revoked schedules cannot be paused.";
  if (msg.includes("Cannot resume revoked schedule")) return "Revoked schedules cannot be resumed.";
  return msg;
}

// ── Transaction polling helpers ──────────────────────────────────────────

export interface TransactionStatusResult {
  status: string;
  hash?: string;
  ledger?: number;
  error?: string;
}

/**
 * Fetch the current status of a transaction from the RPC server.
 */
export async function getTransactionStatus(
  hash: string
): Promise<TransactionStatusResult> {
  const result = await server.getTransaction(hash);
  return {
    status: result.status,
    hash: (result as any).hash,
    ledger: (result as any).latestLedger,
    error: (result as any).error,
  };
}

/**
 * Poll for a transaction to reach a terminal status (SUCCESS, FAILED, ERROR).
 * Rejects if the timeout elapses while the status is still NOT_FOUND.
 */
export async function waitForTransaction(
  hash: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<TransactionStatusResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  let status = await getTransactionStatus(hash);
  while (status.status === "NOT_FOUND") {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for transaction ${hash} to confirm after ${timeoutMs}ms`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    status = await getTransactionStatus(hash);
  }

  if (status.status === "FAILED" || status.status === "ERROR") {
    throw new Error(`Transaction ${hash} ${status.status.toLowerCase()}: ${status.error ?? "unknown"}`);
  }

  return status;
}
