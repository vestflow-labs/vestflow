// ===========================================================================
// VestFlow SDK — VestflowClient
// Issue #95: @vestflow/sdk
//
// Main client class for interacting with the VestFlow Soroban contract.
// Supports both read-only simulations and write transactions via Freighter.
// ===========================================================================

import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  rpc as StellarRpc,
  xdr,
  nativeToScVal,
  scValToNative,
  StrKey,
} from "@stellar/stellar-sdk";
import type {
  ScheduleData,
  VestflowConfig,
  CreateScheduleParams,
  CreateGradedScheduleParams,
  ProposeScheduleParams,
  ScheduleProposal,
  ProposalState,
  VestingKind,
  ClaimDelegation,
  Stream,
  StreamsHistory,
  CollectResult,
  ReceiveStreamsResult,
  SqueezeStreamsResult,
  TopUpResult,
  WithdrawResult,
  TransactionResult,
  BalanceResult,
  SplitsConfig,
  ProfileSummary,
  GiveRecord,
  GiveHistoryPage,
  GiveHistoryOptions,
  DripsListSummary,
} from "./types";
import { ProfileError } from "./types";
import { xlmToStroops } from "./utils";
import {
  waitForTransaction as waitForTransactionHelper,
  TimeoutError,
} from "./waitForTransaction";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  testnet: {
    contractId: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
    rpcUrl: "https://soroban-testnet.stellar.org",
    nativeToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    indexerUrl: "https://indexer.vestflow.testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    contractId: "",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    nativeToken: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    indexerUrl: "https://indexer.vestflow.stellar.org",
    networkPassphrase: Networks.PUBLIC,
  },
} as const;

// Well-known funded testnet account used as fallback source for read-only
// simulations when no wallet is connected.
const FALLBACK_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ---------------------------------------------------------------------------
// VestflowClient
// ---------------------------------------------------------------------------

/**
 * Client for interacting with the VestFlow vesting contract on Stellar/Soroban.
 *
 * @example
 * ```ts
 * import { VestflowClient } from "@vestflow/sdk";
 *
 * const client = new VestflowClient({ network: "testnet" });
 *
 * // Read a schedule
 * const schedule = await client.getSchedule(1);
 *
 * // Create a schedule (requires Freighter)
 * const hash = await client.createSchedule({
 *   grantor: "G...",
 *   beneficiary: "G...",
 *   totalAmountXlm: "1000",
 *   startTime: Math.floor(Date.now() / 1000),
 *   durationDays: 365,
 *   cliffDays: 90,
 *   kind: "LinearWithCliff",
 *   revocable: true,
 * });
 * ```
 */
export class VestflowClient {
  private readonly server: StellarRpc.Server;
  private readonly contractId: string;
  private readonly nativeToken: string;
  private readonly indexerUrl: string;
  private readonly networkPassphrase: string;
  private readonly network: "testnet" | "mainnet";
  private readonly signTransaction: ((xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>) | null;

  /**
   * Create a new VestflowClient.
   *
   * @param config - Network and connection overrides. Defaults to testnet.
   */
  constructor(config: VestflowConfig = {}) {
    const net = config.network ?? "testnet";
    const defaults = DEFAULTS[net];

    this.contractId = config.contractId ?? defaults.contractId;
    this.nativeToken = config.nativeToken ?? defaults.nativeToken;
    this.indexerUrl = config.indexerUrl ?? defaults.indexerUrl;
    this.networkPassphrase = defaults.networkPassphrase;
    this.network = net;
    this.server = new StellarRpc.Server(config.rpcUrl ?? defaults.rpcUrl);
    this.signTransaction = null;
  }

  // ── Internal: simulate ────────────────────────────────────────────────────

  private async simulate(
    method: string,
    args: xdr.ScVal[],
    publicKey?: string
  ): Promise<xdr.ScVal> {
    const contract = new Contract(this.contractId);
    const source = publicKey ?? FALLBACK_ACCOUNT;
    const account = await this.server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(result)) {
      throw new Error((result as any).error);
    }
    return (result as any).result!.retval;
  }

  // ── Internal: build, send, and wait for settlement ────────────────────────

  private async submitAndSettle(
    publicKey: string,
    method: string,
    args: xdr.ScVal[],
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<TransactionResult> {
    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(publicKey);
    let tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(simResult)) {
      throw new Error((simResult as any).error);
    }
    tx = StellarRpc.assembleTransaction(tx, simResult as any).build();

    const signed = await signer(tx.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const xdrStr = typeof signed === "string" ? signed : (signed as any).signedTxXdr;
    const submitted = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(xdrStr, this.networkPassphrase)
    );
    if (submitted.status === "ERROR") throw new Error("Transaction failed");

    const settled = await this.waitForTransaction(submitted.hash);
    return {
      hash: submitted.hash,
      status: settled.status === "SUCCESS" ? "SUCCESS" : "FAILED",
    };
  }

  // ── Internal: build and send ──────────────────────────────────────────────

  private async buildAndSend(
    publicKey: string,
    method: string,
    args: xdr.ScVal[],
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    const { hash } = await this.submitAndSettle(publicKey, method, args, signer);
    return hash;
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  /**
   * Poll Soroban RPC for a submitted transaction's outcome until it settles,
   * backing off exponentially between polls (1s, 2s, 4s, 8s, ...).
   *
   * Delegates to the standalone {@link waitForTransaction} helper in
   * `./waitForTransaction`, injecting this client's RPC `getTransaction`.
   *
   * @param hash - Transaction hash, e.g. as returned by `createSchedule`
   * @param timeoutMs - Maximum total time to wait before giving up (default 30000ms)
   * @param options - Optional backoff tuning
   * @param options.initialDelayMs - Delay before the first poll retry (default 1000ms)
   * @param options.maxDelayMs - Upper bound on the backoff delay (default 8000ms)
   * @returns The settled transaction response (e.g. status `SUCCESS` or `FAILED`)
   * @throws {TimeoutError} If the transaction is still `NOT_FOUND` after `timeoutMs`
   */
  async waitForTransaction(
    hash: string,
    timeoutMs = 30_000,
    options: { initialDelayMs?: number; maxDelayMs?: number } = {}
  ): Promise<StellarRpc.Api.GetTransactionResponse> {
    return waitForTransactionHelper(hash, {
      timeoutMs,
      initialDelayMs: options.initialDelayMs,
      maxDelayMs: options.maxDelayMs,
      getTransaction: (h) => this.server.getTransaction(h),
    });
  }

  // ── Indexer ────────────────────────────────────────────────────────────────

  /**
   * Query the VestFlow indexer for all active outgoing streams opened by a given
   * account.
   *
   * Hits the indexer's `GET /streams?account=<account>` endpoint and returns
   * typed {@link Stream} objects. Returns an empty array when the account has no
   * streams or the indexer returns an empty list.
   *
   * @param account - Stellar address whose outgoing streams to fetch.
   * @param indexerUrl - Optional indexer base URL override (defaults to the
   *   client's configured `indexerUrl`).
   * @returns Typed `Stream[]`, each with `receiver`, `token`, `ratePerSec`,
   *   and `maxEndTime`.
   */
  async getStreams(account: string, indexerUrl = this.indexerUrl): Promise<Stream[]> {
    const url = `${indexerUrl.replace(/\/$/, "")}/streams?account=${encodeURIComponent(account)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Indexer request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    const raw = Array.isArray(body)
      ? body
      : ((body as { streams?: unknown[] } | null)?.streams ?? []);

    return (raw as Record<string, unknown>[]).map((item) => ({
      sender: String(item.sender ?? account),
      receiver: String(item.receiver ?? ""),
      token: String(item.token ?? ""),
      ratePerSec: BigInt(String(item.ratePerSec ?? item.rate_per_sec ?? 0)),
      maxEndTime: Number(item.maxEndTime ?? item.max_end_time ?? 0),
    }));
  }

  /** Query sent and/or received give history for an account. */
  async getGiveHistory(
    account: string,
    options: GiveHistoryOptions = {}
  ): Promise<GiveHistoryPage> {
    const asSender = options.asSender ?? false;
    const asReceiver = options.asReceiver ?? false;
    const directions = asSender === asReceiver
      ? ["sender", "receiver"]
      : [asSender ? "sender" : "receiver"];
    const pages = await Promise.all(directions.map(async (direction) => {
      const params = new URLSearchParams([[direction, account]]);
      if (options.token) params.set("token", options.token);
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.cursor) params.set("cursor", options.cursor);
      const url = `${this.indexerUrl.replace(/\/$/, "")}/gives?${params}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Indexer request failed: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as {
        gives?: unknown[];
        items?: unknown[];
        nextCursor?: string | null;
        next_cursor?: string | null;
      };
      const raw = Array.isArray(data.gives) ? data.gives : data.items ?? [];
      return {
        items: (raw as Record<string, unknown>[]).map((item) => ({
          id: String(item.id ?? ""),
          sender: String(item.sender ?? ""),
          receiver: String(item.receiver ?? ""),
          token: String(item.token ?? ""),
          amount: BigInt(String(item.amount ?? item.amount_stroops ?? 0)),
          ledger: Number(item.ledger ?? 0),
          timestamp: Number(item.timestamp ?? 0),
        })),
        nextCursor: data.nextCursor ?? data.next_cursor ?? undefined,
      };
    }));
    return {
      items: pages.flatMap((page) => page.items),
      nextCursor: pages.find((page) => page.nextCursor)?.nextCursor,
    };
  }

  // ── Internal: parse schedule ──────────────────────────────────────────────

  private parseSchedule(raw: any): ScheduleData {
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
      kind:
        raw.kind === "Cliff"
          ? "Cliff"
          : raw.kind === "LinearWithCliff"
          ? "LinearWithCliff"
          : "Linear",
      revocable: Boolean(raw.revocable),
      revoked: Boolean(raw.revoked),
      paused: Boolean(raw.paused),
      lockup_duration: Number(raw.lockup_duration ?? raw.lockup_seconds ?? 0),
      requires_milestones: Boolean(raw.requires_milestones),
      vested_at_revoke: BigInt(raw.vested_at_revoke ?? 0),
      paused_duration: Number(raw.paused_duration ?? 0),
      paused_at: Number(raw.paused_at ?? 0),
    };
  }

  // ── Internal: parse delegation ────────────────────────────────────────────

  private parseDelegation(raw: any): ClaimDelegation {
    return {
      delegate: raw.delegate?.toString() ?? "",
      maxAmount: raw.max_amount == null ? null : BigInt(raw.max_amount),
      expiresAtLedger: raw.expires_at_ledger == null ? null : Number(raw.expires_at_ledger),
      claimedSoFar: BigInt(raw.claimed_so_far ?? 0),
      revoked: Boolean(raw.revoked),
    };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Fetch a single vesting schedule by ID.
   * Returns null if the schedule does not exist.
   */
  async getSchedule(id: number, publicKey?: string): Promise<ScheduleData | null> {
    try {
      const val = await this.simulate(
        "get_schedule",
        [nativeToScVal(id, { type: "u64" })],
        publicKey
      );
      return this.parseSchedule(scValToNative(val));
    } catch {
      return null;
    }
  }

  /**
   * Return the total number of schedules ever created.
   */
  async getScheduleCount(): Promise<number> {
    try {
      const val = await this.simulate("schedule_count", []);
      return Number(scValToNative(val));
    } catch {
      return 0;
    }
  }

  /**
   * Return schedule IDs created by a given grantor address.
   */
  async getSchedulesByGrantor(grantor: string): Promise<number[]> {
    try {
      const val = await this.simulate("get_schedules_by_grantor", [
        nativeToScVal(grantor, { type: "address" }),
      ]);
      return (scValToNative(val) as number[]).map(Number);
    } catch {
      return [];
    }
  }

  /**
   * Return all schedule IDs created by a given grantor, combining
   * single-token and multi-token schedules into a single list.
   */
  async getGrantorScheduleIds(grantor: string): Promise<number[]> {
    try {
      const val = await this.simulate("grantor_schedule_ids", [
        nativeToScVal(grantor, { type: "address" }),
      ]);
      return (scValToNative(val) as number[]).map(Number);
    } catch {
      return [];
    }
  }

  /**
   * Return schedule IDs where the given address is the beneficiary.
   */
  async getSchedulesByBeneficiary(beneficiary: string): Promise<number[]> {
    try {
      const val = await this.simulate("get_schedules_by_beneficiary", [
        nativeToScVal(beneficiary, { type: "address" }),
      ]);
      return (scValToNative(val) as number[]).map(Number);
    } catch {
      return [];
    }
  }

  /**
   * Return all schedule IDs where the given address is the beneficiary,
   * combining single-token and multi-token schedules into a single list.
   */
  async getBeneficiaryScheduleIds(beneficiary: string): Promise<number[]> {
    try {
      const val = await this.simulate("beneficiary_schedule_ids", [
        nativeToScVal(beneficiary, { type: "address" }),
      ]);
      return (scValToNative(val) as number[]).map(Number);
    } catch {
      return [];
    }
  }

  /**
   * Return how many tokens are currently claimable for a schedule.
   */
  async getClaimable(id: number, publicKey?: string): Promise<bigint> {
    try {
      const val = await this.simulate(
        "claimable",
        [nativeToScVal(id, { type: "u64" })],
        publicKey
      );
      return BigInt(scValToNative(val));
    } catch {
      return 0n;
    }
  }

  /**
   * Return how many tokens are claimable for a schedule at a specific time.
   */
  async getClaimableAt(id: number, now: number, publicKey?: string): Promise<bigint> {
    try {
      const val = await this.simulate(
        "claimable_amount",
        [
          nativeToScVal(id, { type: "u64" }),
          nativeToScVal(now, { type: "u64" }),
        ],
        publicKey
      );
      return BigInt(scValToNative(val));
    } catch {
      return 0n;
    }
  }

  /**
   * Return how many tokens are vested for a schedule at a specific time.
   */
  async getVestedAmountAt(id: number, now: number, publicKey?: string): Promise<bigint> {
    try {
      const val = await this.simulate(
        "vested_amount",
        [
          nativeToScVal(id, { type: "u64" }),
          nativeToScVal(now, { type: "u64" }),
        ],
        publicKey
      );
      return BigInt(scValToNative(val));
    } catch {
      return 0n;
    }
  }

  /**
   * Fetch claimable amounts for multiple schedule IDs in a single
   * simulation round-trip using the claimable_bulk contract view.
   *
   * Results are in the same order as the input ids.
   * Unknown IDs return 0n.
   */
  async getClaimableBulk(ids: number[], publicKey?: string): Promise<bigint[]> {
    if (ids.length === 0) return [];
    try {
      const idsVal = xdr.ScVal.scvVec(
        ids.map((id) => nativeToScVal(id, { type: "u64" }))
      );
      const val = await this.simulate("claimable_bulk", [idsVal], publicKey);
      const native = scValToNative(val) as bigint[];
      return native.map((v) => BigInt(v));
    } catch {
      return ids.map(() => 0n);
    }
  }

  /**
   * Fetch total vested amounts (earned, including already-claimed) for multiple
   * schedule IDs in a single simulation round-trip using the vested_amount_bulk
   * contract view.
   *
   * Results are in the same order as the input ids.
   * Unknown IDs return 0n.
   */
  async getVestedAmountBulk(ids: number[], publicKey?: string): Promise<bigint[]> {
    if (ids.length === 0) return [];
    try {
      const idsVal = xdr.ScVal.scvVec(
        ids.map((id) => nativeToScVal(id, { type: "u64" }))
      );
      const val = await this.simulate("vested_amount_bulk", [idsVal], publicKey);
      const native = scValToNative(val) as bigint[];
      return native.map((v) => BigInt(v));
    } catch {
      return ids.map(() => 0n);
    }
  }

  /**
   * Fetch multiple schedules in a single simulation round-trip.
   *
   * Returns results in the same order as `ids`. Unknown IDs return null.
   * Replaces the Promise.all(getSchedule) N-call pattern.
   */
  async getScheduleBatch(ids: number[], publicKey?: string): Promise<(ScheduleData | null)[]> {
    if (ids.length === 0) return [];
    try {
      const idsVal = xdr.ScVal.scvVec(
        ids.map((id) => nativeToScVal(id, { type: "u64" }))
      );
      const val = await this.simulate("get_schedule_batch", [idsVal], publicKey);
      const rawItems = scValToNative(val) as any[];
      return rawItems.map((raw: any) => (raw == null ? null : this.parseSchedule(raw)));
    } catch {
      return ids.map(() => null);
    }
  }

  /**
   * Return the unvested remainder for a schedule — the amount a grantor would
   * recover by revoking right now.
   *
   * The contract has no standalone `remaining_unvested` view, so this composes
   * `total_amount` (from `get_schedule`) with the `vested_amount_current` view,
   * mirroring the exact calculation `revoke()` uses on-chain (`total_amount - vested`).
   *
   * Returns 0n if the schedule does not exist.
   */
  async getRemainingUnvested(scheduleId: number, publicKey?: string): Promise<bigint> {
    const schedule = await this.getSchedule(scheduleId, publicKey);
    if (schedule === null) return 0n;
    const vested = await this.getVestedAmountCurrent(scheduleId, publicKey);
    const remaining = schedule.total_amount - vested;
    return remaining > 0n ? remaining : 0n;
  }

  /**
   * Return how many tokens are vested for a schedule using the current ledger time.
   */
  async getVestedAmountCurrent(id: number, publicKey?: string): Promise<bigint> {
    try {
      const val = await this.simulate(
        "vested_amount_current",
        [nativeToScVal(id, { type: "u64" })],
        publicKey
      );
      return BigInt(scValToNative(val));
    } catch {
      return 0n;
    }
  }

  /**
   * Preview how many tokens will be claimable at an arbitrary future timestamp.
   *
   * The result reflects current schedule state projected to `ts` — most
   * meaningful for future timestamps.
   * Returns 0n for unknown schedule IDs.
   */
  async getClaimableAtTimestamp(id: number, ts: number, publicKey?: string): Promise<bigint> {
    try {
      const val = await this.simulate(
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
   * Fetch the timestamp at which a schedule reaches 100% vested.
   *
   * Correct for every vesting kind, including Graded schedules where the
   * last milestone's offset (not `start_time + duration`) determines the
   * full-vest point.
   *
   * @param id - Schedule ID
   * @param publicKey - Optional source account for the simulation
   * @returns Unix timestamp of full vesting, or null for unknown schedule IDs
   */
  async getFullyVestedAt(id: number, publicKey?: string): Promise<number | null> {
    try {
      const val = await this.simulate(
        "fully_vested_at",
        [nativeToScVal(id, { type: "u64" })],
        publicKey
      );
      const native = scValToNative(val);
      return native == null ? null : Number(native);
    } catch {
      return null;
    }
  }

  /**
   * Fetch all schedules ever created.
   *
   * Uses get_schedule_batch to fetch all schedules in a single simulation
   * round-trip instead of N individual calls.
   *
   * @param publicKey - Optional source account for the read-only simulation.
   * @param timeoutMs - Rejects with a clear timeout error if the RPC hasn't
   * responded within this many milliseconds. Defaults to 30s.
   */
  async getAllSchedules(
    publicKey?: string,
    timeoutMs = 30_000
  ): Promise<ScheduleData[]> {
    return this.withTimeout(
      this.fetchAllSchedules(publicKey),
      timeoutMs,
      `getAllSchedules timed out after ${timeoutMs}ms waiting for the Soroban RPC`
    );
  }

  private async fetchAllSchedules(publicKey?: string): Promise<ScheduleData[]> {
    const count = await this.getScheduleCount();
    if (count === 0) return [];
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const schedules = await this.getScheduleBatch(ids, publicKey);
    return schedules.filter(Boolean) as ScheduleData[];
  }

  /**
   * Fetch a single claim delegation by (scheduleId, delegationId).
   * Returns null if the delegation does not exist.
   */
  async getDelegation(
    scheduleId: number,
    delegationId: number,
    publicKey?: string
  ): Promise<ClaimDelegation | null> {
    try {
      const val = await this.simulate(
        "get_delegation",
        [
          nativeToScVal(scheduleId, { type: "u64" }),
          nativeToScVal(delegationId, { type: "u32" }),
        ],
        publicKey
      );
      const native = scValToNative(val);
      return native == null ? null : this.parseDelegation(native);
    } catch {
      return null;
    }
  }

  // ── Internal: parse balance ────────────────────────────────────────────────

  private parseBalance(raw: any): BalanceResult {
    return {
      streamingBalance: BigInt(raw?.streaming_balance ?? 0),
      collectableAmount: BigInt(raw?.collectable_amount ?? 0),
      streamingRatePerSec: BigInt(raw?.streaming_rate_per_sec ?? 0),
    };
  }

  /**
   * Read the live streaming balance and collectable amount for an
   * account/token pair via Soroban simulation — not indexed state — so the
   * result reflects on-chain streams as of the current ledger.
   *
   * @param account - Stellar address to read the balance for.
   * @param token - Stellar Asset Contract address of the token.
   * @param publicKey - Optional source account for the simulation.
   * @returns Streaming balance, collectable amount, and current streaming rate.
   * Returns all-zero values when the account has no streams for this token.
   */
  async getBalance(account: string, token: string, publicKey?: string): Promise<BalanceResult> {
    try {
      const val = await this.simulate(
        "streaming_balance",
        [
          nativeToScVal(account, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
        ],
        publicKey
      );
      return this.parseBalance(scValToNative(val));
    } catch {
      return { streamingBalance: 0n, collectableAmount: 0n, streamingRatePerSec: 0n };
    }
  }

  /**
   * Fetch the current splits configuration for an account from the
   * indexer's `/splits` endpoint.
   *
   * @param account - Stellar address to look up.
   * @returns Configured receivers and a hash identifying the splits
   * configuration. Returns an empty receivers list and `hash: ""` when the
   * account has no splits configured.
   * @throws If the indexer request fails with an unexpected (non-404) error status.
   */
  async getSplits(account: string): Promise<SplitsConfig> {
    const url = new URL("/splits", this.indexerUrl);
    url.searchParams.set("account", account);

    const res = await fetch(url.toString());
    if (res.status === 404) {
      return { receivers: [], hash: "" };
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch splits for ${account}: ${res.status}`);
    }

    const data = await res.json();
    const receivers = Array.isArray(data.receivers)
      ? data.receivers.map((r: any) => ({
          address: String(r.address ?? r.account ?? ""),
          weightBps: Number(r.weightBps ?? r.weight_bps ?? r.weight ?? 0),
        }))
      : [];
    return { receivers, hash: String(data.hash ?? "") };
  }

  /**
   * Fetch an aggregated profile for a Stellar address from the indexer's
   * `/profile/:address` endpoint.
   *
   * The profile combines the address's outgoing streams, splits
   * configuration, give history and Drips lists, plus summary totals.
   *
   * Addresses with no activity resolve to a zeroed/empty profile rather
   * than throwing.
   *
   * @param address - Stellar address (account) to look up.
   * @returns Typed `ProfileSummary` for the address.
   * @throws `ProfileError` with `status: 400` if `address` is not a valid
   * Stellar ed25519 public key, or with the indexer's status on unexpected
   * failures (404 resolves to an empty profile instead of throwing).
   */
  async getProfile(address: string): Promise<ProfileSummary> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new ProfileError("address must be a valid Stellar public key", 400);
    }

    const url = new URL(`/profile/${address}`, this.indexerUrl);
    url.searchParams.set("network", this.network);

    const res = await fetch(url.toString());
    if (res.status === 404) {
      return this.emptyProfile(address);
    }
    if (!res.ok) {
      throw new ProfileError(
        `Failed to fetch profile for ${address}: ${res.status}`,
        res.status
      );
    }

    const data = await res.json();
    return this.mapProfile(address, data);
  }

  /** Build an empty (zeroed) profile for an address with no activity. */
  private emptyProfile(address: string): ProfileSummary {
    return {
      address,
      network: this.network,
      streams: [],
      splits: { receivers: [], hash: "" },
      gives: [],
      dripsLists: [],
      totals: {
        streams: 0,
        splitsReceivers: 0,
        gives: 0,
        totalGiven: 0n,
        dripsLists: 0,
      },
    };
  }

  /** Normalise an indexer profile payload into a typed `ProfileSummary`. */
  private mapProfile(address: string, data: any): ProfileSummary {
    const streams: Stream[] = Array.isArray(data?.streams)
      ? data.streams.map((s: any) => ({
          sender: String(s.sender ?? address),
          receiver: String(s.receiver ?? ""),
          token: String(s.token ?? ""),
          ratePerSec: BigInt(
            s.ratePerSec ?? s.rate_per_sec ?? s.rate_per_second ?? 0
          ),
          maxEndTime: Number(
            s.maxEndTime ?? s.max_end_time ?? s.estimated_end_time ?? 0
          ),
        }))
      : [];

    const splitsReceivers = Array.isArray(data?.splits?.receivers)
      ? data.splits.receivers.map((r: any) => ({
          address: String(r.address ?? r.account ?? r.receiver ?? ""),
          weightBps: Number(r.weightBps ?? r.weight_bps ?? r.weight ?? 0),
        }))
      : [];

    const gives: GiveRecord[] = Array.isArray(data?.gives)
      ? data.gives.map((g: any) => ({
          id: String(g.id ?? ""),
          sender: String(g.sender ?? ""),
          receiver: String(g.receiver ?? ""),
          token: String(g.token ?? ""),
          amount: BigInt(g.amount ?? g.amount_stroops ?? 0),
          ledger: Number(g.ledger ?? 0),
          timestamp: Number(g.timestamp ?? 0),
        }))
      : [];

    const dripsLists: DripsListSummary[] = Array.isArray(data?.dripsLists)
      ? data.dripsLists.map((d: any) => ({
          id: String(d.id ?? ""),
          name: String(d.name ?? ""),
          owner: String(d.owner ?? ""),
          token: String(d.token ?? ""),
          memberCount: Number(d.memberCount ?? d.member_count ?? 0),
        }))
      : [];

    const totalGiven = gives.reduce(
      (acc, g) => acc + (g.sender === address ? g.amount : 0n),
      0n
    );

    return {
      address,
      network: this.network,
      streams,
      splits: {
        receivers: splitsReceivers,
        hash: String(data?.splits?.hash ?? ""),
      },
      gives,
      dripsLists,
      totals: {
        streams: streams.length,
        splitsReceivers: splitsReceivers.length,
        gives: gives.length,
        totalGiven,
        dripsLists: dripsLists.length,
      },
    };
  }

  /**
   * Race a promise against a deadline, rejecting with `message` if it fires first.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Create a new vesting schedule and lock tokens into the contract.
   *
   * @param params - Schedule parameters
   * @param signer - Function that signs the transaction XDR (e.g. Freighter's signTransaction)
   * @returns Transaction hash
   * @throws If `params.beneficiary` equals `params.grantor`
   */
  async createSchedule(
    params: CreateScheduleParams,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    if (params.beneficiary === params.grantor) {
      throw new Error("beneficiary must be different from grantor");
    }
    const totalStroops = xlmToStroops(params.totalAmountXlm);
    const durationSecs = params.durationDays * 86400;
    const cliffSecs = params.cliffDays * 86400;
    const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(params.kind)]);

    const args: xdr.ScVal[] = [
      nativeToScVal(params.grantor, { type: "address" }),
      nativeToScVal(params.beneficiary, { type: "address" }),
      nativeToScVal(this.nativeToken, { type: "address" }),
      nativeToScVal(totalStroops, { type: "i128" }),
      nativeToScVal(params.startTime, { type: "u64" }),
      nativeToScVal(durationSecs, { type: "u64" }),
      nativeToScVal(cliffSecs, { type: "u64" }),
      kindVal,
      nativeToScVal(params.revocable, { type: "bool" }),
    ];
    return this.buildAndSend(params.grantor, "create_schedule", args, signer);
  }

  /**
   * Create a new graded (percentage-based) vesting schedule.
   *
   * Tokens unlock at discrete milestones. All milestones must sum to exactly
   * 10 000 bps. The last milestone's `offsetDays` defines the total duration.
   *
   * @param params - Graded schedule parameters including milestone list
   * @param signer - Function that signs the transaction XDR (e.g. Freighter's signTransaction)
   * @returns Transaction hash
   * @throws If `params.beneficiary` equals `params.grantor`
   */
  async createGradedSchedule(
    params: CreateGradedScheduleParams,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    if (params.beneficiary === params.grantor) {
      throw new Error("beneficiary must be different from grantor");
    }
    const totalStroops = BigInt(Math.round(params.totalAmountXlm * 10_000_000));
    const lockupSecs = params.lockupDays * 86400;

    const milestonesVal = xdr.ScVal.scvVec(
      params.milestones.map((m) => {
        const offsetSecs = BigInt(m.offsetDays * 86400);
        return xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("bps"),
            val: nativeToScVal(m.bps, { type: "u32" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("offset_secs"),
            val: nativeToScVal(offsetSecs, { type: "u64" }),
          }),
        ]);
      })
    );

    const args: xdr.ScVal[] = [
      nativeToScVal(params.grantor, { type: "address" }),
      nativeToScVal(params.beneficiary, { type: "address" }),
      nativeToScVal(this.nativeToken, { type: "address" }),
      nativeToScVal(totalStroops, { type: "i128" }),
      nativeToScVal(params.startTime, { type: "u64" }),
      nativeToScVal(lockupSecs, { type: "u64" }),
      nativeToScVal(params.revocable, { type: "bool" }),
      milestonesVal,
    ];
    return this.buildAndSend(params.grantor, "create_graded_schedule", args, signer);
  }

  /**
   * Claim all currently vested but unclaimed tokens for a schedule.
   *
   * @param publicKey - Beneficiary's Stellar public key
   * @param scheduleId - ID of the schedule to claim from
   * @param signer - Function that signs the transaction XDR
   * @returns Transaction hash
   */
  async claimVested(
    publicKey: string,
    scheduleId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      publicKey,
      "claim",
      [nativeToScVal(scheduleId, { type: "u64" })],
      signer
    );
  }

  /**
   * Collect all claimable tokens for a given SAC token address.
   *
   * Simulates the collectable amount first; if nothing is collectable the
   * transaction is **not** submitted and the method resolves with
   * `{ collected: 0n, txHash: "" }` — no gas is spent and no error is thrown.
   *
   * @param publicKey - Beneficiary's Stellar public key
   * @param token - SAC address of the token to collect
   * @param signer - Function that signs the transaction XDR
   * @returns `{ collected, txHash }`. When nothing was collected, `txHash` is
   *   an empty string and `collected` is `0n`.
   */
  async collect(
    publicKey: string,
    token: string,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<CollectResult> {
    // Probe how much is collectable before spending fees.
    let claimable = 0n;
    try {
      const val = await this.simulate(
        "collectable",
        [
          nativeToScVal(publicKey, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
        ],
        publicKey
      );
      claimable = BigInt(scValToNative(val) ?? 0);
    } catch {
      // Contract may not expose `collectable` view — attempt the collect
      // call regardless so on-chain logic decides.
      claimable = 1n; // sentinel: proceed to submit
    }

    // Nothing to collect — return early without submitting a transaction.
    if (claimable === 0n) {
      return { collected: 0n, txHash: "" };
    }

    const txHash = await this.buildAndSend(
      publicKey,
      "collect",
      [
        nativeToScVal(publicKey, { type: "address" }),
        nativeToScVal(token, { type: "address" }),
      ],
      signer
    );

    // Re-read collected amount from a fresh simulation if we used the sentinel.
    const collected = claimable === 1n ? 0n : claimable;
    return { collected, txHash };
  }

  /**
   * Revoke a vesting schedule (grantor only, revocable schedules only).
   * Unvested tokens return to the grantor; vested tokens remain claimable.
   *
   * @param publicKey - Grantor's Stellar public key
   * @param scheduleId - ID of the schedule to revoke
   * @param signer - Function that signs the transaction XDR
   * @returns Transaction hash
   */
  async revokeSchedule(
    publicKey: string,
    scheduleId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      publicKey,
      "revoke",
      [nativeToScVal(scheduleId, { type: "u64" })],
      signer
    );
  }

  /**
   * Pause an active vesting schedule (grantor only).
   * While paused, no additional tokens vest. The beneficiary can still claim
   * already-vested tokens.
   *
   * @param publicKey - Grantor's Stellar public key
   * @param scheduleId - ID of the schedule to pause
   * @param signer - Function that signs the transaction XDR
   * @returns Transaction hash
   */
  async pauseSchedule(
    publicKey: string,
    scheduleId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      publicKey,
      "pause_schedule",
      [nativeToScVal(scheduleId, { type: "u64" })],
      signer
    );
  }

  /**
   * Resume a paused vesting schedule (grantor only).
   *
   * @param publicKey - Grantor's Stellar public key
   * @param scheduleId - ID of the schedule to resume
   * @param signer - Function that signs the transaction XDR
   * @returns Transaction hash
   */
  async resumeSchedule(
    publicKey: string,
    scheduleId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      publicKey,
      "resume_schedule",
      [nativeToScVal(scheduleId, { type: "u64" })],
      signer
    );
  }

  /**
   * Transfer beneficiary of a vesting schedule (current beneficiary only).
   *
   * @param currentBeneficiary - Current beneficiary's Stellar public key (signs the transaction)
   * @param scheduleId - ID of the schedule to transfer
   * @param newBeneficiary - New beneficiary's Stellar public key
   * @param signer - Function that signs the transaction XDR
   * @returns Transaction hash
   */
  async transferBeneficiary(
    currentBeneficiary: string,
    scheduleId: number,
    newBeneficiary: string,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      currentBeneficiary,
      "transfer_beneficiary",
      [
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(newBeneficiary, { type: "address" }),
      ],
      signer
    );
  }

  /**
   * Subscribe to live updates for a vesting schedule by polling the chain at a
   * configurable interval.
   *
   * The callback receives fresh {@link ScheduleData} (and the current claimable
   * amount in stroops) on every successful poll. Call the returned `unsubscribe`
   * function to stop polling and release resources.
   *
   * @example
   * ```ts
   * const { unsubscribe } = client.subscribeToSchedule(42, async (schedule, claimable) => {
   *   console.log("Claimable:", claimable.toString(), "stroops");
   *   console.log("Progress:", vestingProgress(schedule, Math.floor(Date.now() / 1000)), "%");
   * });
   *
   * // Later — e.g. on component unmount:
   * unsubscribe();
   * ```
   *
   * @param id - Schedule ID to watch.
   * @param callback - Called after every successful poll with the latest schedule
   *   state and claimable amount. Errors thrown inside the callback are swallowed
   *   so a transient UI error cannot kill the poller.
   * @param options - Optional configuration.
   * @param options.intervalMs - Poll interval in milliseconds. Defaults to 10 000 (10 s).
   * @param options.publicKey - Wallet address used to simulate read-only calls.
   *   Pass the beneficiary's key to get an accurate claimable amount.
   * @param options.onError - Called when a poll fails. Defaults to `console.error`.
   * @returns An object with an `unsubscribe()` teardown function.
   */
  /**
   * Extend the vesting duration of an existing schedule (grantor only).
   *
   * Adds `additionalSeconds` to the schedule's current duration, pushing
   * the end date forward without affecting the start time or already-vested
   * amounts.
   *
   * @param grantor - Grantor's Stellar public key (must sign the transaction).
   * @param scheduleId - ID of the schedule to extend.
   * @param additionalSeconds - Number of seconds to add to the current duration.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction hash.
   */
  async extendDuration(
    grantor: string,
    scheduleId: number,
    additionalSeconds: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      grantor,
      "extend_duration",
      [
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(additionalSeconds, { type: "u64" }),
      ],
      signer
    );
  }

  /**
   * Atomically merge multiple active vesting schedules belonging to the same
   * grantor-beneficiary pair into a single unified schedule, destroying the
   * sources.
   *
   * Requires authorization from both the grantor and the beneficiary of the
   * schedules being merged, regardless of who `caller` is — pass a `signer`
   * capable of producing both signatures (e.g. a multi-signature flow), or
   * call this once per required signer with the same transaction if your
   * wallet integration supports co-signing.
   *
   * @param caller - Address invoking the merge (must be the grantor or the beneficiary)
   * @param ids - Schedule IDs to merge (2-20 schedules, all sharing the same
   *   grantor, beneficiary, token, and vesting kind)
   * @param signer - Function that signs the transaction XDR
   * @returns Transaction hash
   */
  async mergeSchedules(
    caller: string,
    ids: number[],
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    const idsVal = xdr.ScVal.scvVec(
      ids.map((id) => nativeToScVal(id, { type: "u64" }))
    );
    return this.buildAndSend(
      caller,
      "merge_schedules",
      [nativeToScVal(caller, { type: "address" }), idsVal],
      signer
    );
  }

  /**
   * Propose a vesting schedule without transferring tokens.
   *
   * The grantor later calls {@link fundAndActivate} within 72 hours to lock
   * tokens and start the schedule. Beneficiary acknowledgment is optional.
   */
  async proposeSchedule(
    params: ProposeScheduleParams,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    if (params.beneficiary === params.grantor) {
      throw new Error("beneficiary must be different from grantor");
    }
    const totalStroops = xlmToStroops(params.totalAmountXlm);
    const durationSecs = params.durationDays * 86400;
    const cliffSecs = params.cliffDays * 86400;
    const lockupSecs = (params.lockupDays ?? 0) * 86400;
    const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(params.kind)]);

    const args: xdr.ScVal[] = [
      nativeToScVal(params.grantor, { type: "address" }),
      nativeToScVal(params.beneficiary, { type: "address" }),
      nativeToScVal(this.nativeToken, { type: "address" }),
      nativeToScVal(totalStroops, { type: "i128" }),
      nativeToScVal(params.startTime, { type: "u64" }),
      nativeToScVal(durationSecs, { type: "u64" }),
      nativeToScVal(cliffSecs, { type: "u64" }),
      nativeToScVal(lockupSecs, { type: "u64" }),
      kindVal,
      nativeToScVal(params.revocable, { type: "bool" }),
    ];
    return this.buildAndSend(params.grantor, "propose_schedule", args, signer);
  }

  /**
   * Record that the beneficiary has seen a proposal.
   *
   * Does not block {@link fundAndActivate}.
   */
  async acknowledgeProposal(
    beneficiary: string,
    proposalId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      beneficiary,
      "acknowledge_proposal",
      [
        nativeToScVal(beneficiary, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" }),
      ],
      signer
    );
  }

  /**
   * Transfer tokens and activate a proposed schedule (grantor only).
   *
   * Must be called within 72 hours of {@link proposeSchedule}.
   */
  async fundAndActivate(
    grantor: string,
    proposalId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      grantor,
      "fund_and_activate",
      [
        nativeToScVal(grantor, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" }),
      ],
      signer
    );
  }

  /**
   * Mark a proposal as expired after the 72-hour window. Anyone may call this.
   * The proposal remains queryable with state `Expired`.
   */
  async expireProposal(
    caller: string,
    proposalId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      caller,
      "expire_proposal",
      [
        nativeToScVal(caller, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" }),
      ],
      signer
    );
  }

  /**
   * Fetch a proposal by ID.
   * Returns null if the proposal was never created. Expired proposals are
   * returned with state `Expired`.
   */
  async getProposal(id: number, publicKey?: string): Promise<ScheduleProposal | null> {
    try {
      const val = await this.simulate(
        "get_proposal",
        [nativeToScVal(id, { type: "u64" })],
        publicKey
      );
      const native = scValToNative(val);
      if (native == null) return null;
      return this.parseProposal(native);
    } catch {
      return null;
    }
  }

  private parseProposal(raw: Record<string, unknown>): ScheduleProposal {
    return {
      id: Number(raw.id ?? 0),
      grantor: String(raw.grantor ?? ""),
      beneficiary: String(raw.beneficiary ?? ""),
      token: String(raw.token ?? ""),
      total_amount: BigInt(raw.total_amount as string | number | bigint ?? 0),
      start_time: Number(raw.start_time ?? 0),
      duration: Number(raw.duration ?? 0),
      cliff_duration: Number(raw.cliff_duration ?? 0),
      lockup_duration: Number(raw.lockup_duration ?? 0),
      kind:
        raw.kind === "Cliff"
          ? "Cliff"
          : raw.kind === "LinearWithCliff"
            ? "LinearWithCliff"
            : "Linear",
      revocable: Boolean(raw.revocable),
      state: this.parseProposalState(raw.state),
      created_at_ledger: Number(raw.created_at_ledger ?? 0),
    };
  }

  private parseProposalState(raw: unknown): ProposalState {
    if (raw == null) return "Pending";
    if (typeof raw === "string") {
      if (raw === "Acknowledged" || raw === "Expired" || raw === "Pending") {
        return raw;
      }
      return "Pending";
    }
    if (typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if ("Activated" in obj) {
        return { tag: "Activated", scheduleId: Number(obj.Activated) };
      }
      if (obj.tag === "Activated") {
        return { tag: "Activated", scheduleId: Number(obj.values ?? obj.scheduleId ?? 0) };
      }
    }
    return "Pending";
  }

  /**
   * Delegate claim rights on a schedule to a third-party address, optionally
   * bounded by a total claimable amount and/or a ledger-sequence expiry.
   *
   * @param beneficiary - Current beneficiary's Stellar public key (signs the transaction).
   * @param scheduleId - ID of the schedule to delegate from.
   * @param delegate - Address that will be authorized to claim on the beneficiary's behalf.
   * @param maxAmountStroops - Maximum total tokens the delegate may ever claim, or null for unlimited.
   * @param expiresAtLedger - Ledger sequence after which the delegation stops working, or null for no expiry.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction hash.
   */
  async createDelegation(
    beneficiary: string,
    scheduleId: number,
    delegate: string,
    maxAmountStroops: bigint | null,
    expiresAtLedger: number | null,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    const args: xdr.ScVal[] = [
      nativeToScVal(beneficiary, { type: "address" }),
      nativeToScVal(scheduleId, { type: "u64" }),
      nativeToScVal(delegate, { type: "address" }),
      maxAmountStroops == null ? xdr.ScVal.scvVoid() : nativeToScVal(maxAmountStroops, { type: "i128" }),
      expiresAtLedger == null ? xdr.ScVal.scvVoid() : nativeToScVal(expiresAtLedger, { type: "u32" }),
    ];
    return this.buildAndSend(beneficiary, "create_delegation", args, signer);
  }

  /**
   * Revoke a claim delegation, immediately and permanently disabling it.
   *
   * @param beneficiary - Current beneficiary's Stellar public key (signs the transaction).
   * @param scheduleId - ID of the schedule the delegation belongs to.
   * @param delegationId - ID of the delegation to revoke.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction hash.
   */
  async revokeDelegation(
    beneficiary: string,
    scheduleId: number,
    delegationId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      beneficiary,
      "revoke_delegation",
      [
        nativeToScVal(beneficiary, { type: "address" }),
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(delegationId, { type: "u32" }),
      ],
      signer
    );
  }

  /**
   * Claim vested tokens on behalf of a beneficiary through a delegation.
   * Tokens are transferred directly to the delegate's own address.
   *
   * @param delegate - Delegate's Stellar public key (signs the transaction).
   * @param scheduleId - ID of the schedule the delegation belongs to.
   * @param delegationId - ID of the delegation to claim through.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction hash.
   */
  async claimAsDelegate(
    delegate: string,
    scheduleId: number,
    delegationId: number,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
    return this.buildAndSend(
      delegate,
      "claim_as_delegate",
      [
        nativeToScVal(delegate, { type: "address" }),
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(delegationId, { type: "u32" }),
      ],
      signer
    );
  }

  /**
   * Send a one-time direct payment ("give") to a receiver, bypassing any
   * vesting schedule.
   *
   * @param sender - Sender's Stellar public key (must sign the transaction).
   * @param receiver - Recipient's Stellar address (account or contract).
   * @param token - Stellar Asset Contract address of the token to send.
   * @param amount - Amount to send, in the token's base units. Must be > 0n.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction result with hash and settlement status.
   * @throws If `receiver` or `token` is not a valid Stellar address, or `amount` is not positive.
   */
  async give(
    sender: string,
    receiver: string,
    token: string,
    amount: bigint,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<TransactionResult> {
    if (!StrKey.isValidEd25519PublicKey(receiver) && !StrKey.isValidContract(receiver)) {
      throw new Error("receiver must be a valid Stellar address");
    }
    if (!StrKey.isValidContract(token)) {
      throw new Error("token must be a valid Stellar Asset Contract address");
    }
    if (amount <= 0n) {
      throw new Error("amount must be greater than 0");
    }

    const args: xdr.ScVal[] = [
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(receiver, { type: "address" }),
      nativeToScVal(token, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ];
    return this.submitAndSettle(sender, "give", args, signer);
  }

  /**
   * Send one-time direct payments ("gives") to multiple receivers in a
   * single transaction, wrapping the contract's `batch_give` entry point.
   *
   * @param sender - Sender's Stellar public key (must sign the transaction).
   * @param receivers - Receiver Stellar addresses (accounts or contracts).
   * @param amounts - Amount per receiver, in the token's base units. Must
   * have the same length as `receivers`; every amount must be > 0n.
   * @param token - Stellar Asset Contract address of the token to send.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction result with hash and settlement status.
   * @throws If `receivers` and `amounts` lengths differ, any amount is not
   * positive, or any address/token is not a valid Stellar address.
   */
  async batchGive(
    sender: string,
    receivers: string[],
    amounts: bigint[],
    token: string,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<TransactionResult> {
    if (receivers.length !== amounts.length) {
      throw new Error("receivers and amounts must have the same length");
    }
    if (receivers.length === 0) {
      throw new Error("receivers must not be empty");
    }
    for (const [i, amount] of amounts.entries()) {
      if (amount <= 0n) {
        throw new Error(`amounts[${i}] must be greater than 0`);
      }
    }
    for (const [i, receiver] of receivers.entries()) {
      if (
        !StrKey.isValidEd25519PublicKey(receiver) &&
        !StrKey.isValidContract(receiver)
      ) {
        throw new Error(`receivers[${i}] must be a valid Stellar address`);
      }
    }
    if (!StrKey.isValidContract(token)) {
      throw new Error("token must be a valid Stellar Asset Contract address");
    }

    const args: xdr.ScVal[] = [
      nativeToScVal(sender, { type: "address" }),
      xdr.ScVal.scvVec(
        receivers.map((r) => nativeToScVal(r, { type: "address" }))
      ),
      xdr.ScVal.scvVec(amounts.map((a) => nativeToScVal(a, { type: "i128" }))),
      nativeToScVal(token, { type: "address" }),
    ];
    return this.submitAndSettle(sender, "batch_give", args, signer);
  }

  /**
   * Settle all past drips cycles for an account/token pair, transferring
   * accumulated streaming income into the account's collectable balance.
   *
   * Simulates the receivable amount first; if no past cycles are pending the
   * transaction is **not** submitted and the method resolves with
   * `{ received: 0n, txHash: "" }` — no gas is spent and no error is thrown.
   *
   * @param account - Stellar address whose past cycles to settle.
   * @param token - Stellar Asset Contract address of the token.
   * @param signer - Function that signs the transaction XDR.
   * @param maxCycles - Maximum number of past cycles to process in one call.
   *   Defaults to 100. Capped to avoid exceeding Soroban instruction limits.
   * @returns `{ received, txHash }`. When nothing was settled, `txHash` is `""`
   *   and `received` is `0n`.
   */
  async receiveStreams(
    account: string,
    token: string,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>,
    maxCycles = 100
  ): Promise<ReceiveStreamsResult> {
    // Probe receivable amount before spending fees.
    let receivable = 0n;
    try {
      const val = await this.simulate(
        "receivable_streams",
        [
          nativeToScVal(account, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
          nativeToScVal(maxCycles, { type: "u32" }),
        ],
        account
      );
      receivable = BigInt(scValToNative(val) ?? 0);
    } catch {
      // Contract may not expose `receivable_streams` view — proceed to submit.
      receivable = 1n; // sentinel: proceed
    }

    // Nothing to settle — skip the transaction entirely.
    if (receivable === 0n) {
      return { received: 0n, txHash: "" };
    }

    const txHash = await this.buildAndSend(
      account,
      "receive_streams",
      [
        nativeToScVal(account, { type: "address" }),
        nativeToScVal(token, { type: "address" }),
        nativeToScVal(maxCycles, { type: "u32" }),
      ],
      signer
    );

    const received = receivable === 1n ? 0n : receivable;
    return { received, txHash };
  }

  /**
   * Collect the tokens a sender has streamed to `account` so far in the
   * current, unfinished drips cycle ("squeeze"), instead of waiting for the
   * cycle to end. Wraps the `squeeze_streams` contract entry point.
   *
   * The call is simulated first to learn how much it would collect; when that
   * is nothing the transaction is **not** submitted and the method resolves
   * with `{ collected: 0n, txHash: "" }` — no gas is spent.
   *
   * @param account - Stellar address of the receiver collecting the tokens
   *   (must sign the transaction).
   * @param sender - Stellar address of the stream sender to squeeze from.
   * @param token - Stellar Asset Contract address of the streamed token.
   * @param history - The sender's streams history, oldest entry first.
   * @param signer - Function that signs the transaction XDR.
   * @returns `{ collected, txHash }`. When nothing was squeezed, `collected`
   *   is `0n` and `txHash` is `""`.
   */
  async squeezeStreams(
    account: string,
    sender: string,
    token: string,
    history: StreamsHistory[],
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<SqueezeStreamsResult> {
    // Contract struct fields, in the sorted key order Soroban maps require.
    const historyVal = xdr.ScVal.scvVec(
      history.map((entry) =>
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("max_end"),
            val: nativeToScVal(entry.maxEnd, { type: "u64" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("receivers"),
            val: xdr.ScVal.scvVec(
              entry.receivers.map((r) =>
                xdr.ScVal.scvMap([
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("amt_per_sec"),
                    val: nativeToScVal(r.ratePerSec, { type: "i128" }),
                  }),
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol("receiver"),
                    val: nativeToScVal(r.receiver, { type: "address" }),
                  }),
                ])
              )
            ),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("update_time"),
            val: nativeToScVal(entry.updateTime, { type: "u64" }),
          }),
        ])
      )
    );

    const args: xdr.ScVal[] = [
      nativeToScVal(account, { type: "address" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(token, { type: "address" }),
      historyVal,
    ];

    // Simulating the call returns the amount it would collect.
    const val = await this.simulate("squeeze_streams", args, account);
    const collected = BigInt(scValToNative(val) ?? 0);

    // Nothing to squeeze — skip the transaction entirely.
    if (collected === 0n) {
      return { collected: 0n, txHash: "" };
    }

    const txHash = await this.buildAndSend(account, "squeeze_streams", args, signer);
    return { collected, txHash };
  }

  /**
   * Add funds to an account's drips balance for a given token so outgoing
   * streams can continue flowing.
   *
   * @param account - Stellar address topping up its own drips balance.
   * @param token - Stellar Asset Contract address of the token to deposit.
   * @param amount - Amount to deposit, in the token's base units. Must be > 0n.
   * @param signer - Function that signs the transaction XDR.
   * @returns `{ txHash }` on success.
   * @throws If `amount` is not positive.
   */
  async topUp(
    account: string,
    token: string,
    amount: bigint,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<TopUpResult> {
    if (amount <= 0n) {
      throw new Error("amount must be greater than 0");
    }

    const txHash = await this.buildAndSend(
      account,
      "top_up",
      [
        nativeToScVal(account, { type: "address" }),
        nativeToScVal(token, { type: "address" }),
        nativeToScVal(amount, { type: "i128" }),
      ],
      signer
    );

    return { txHash };
  }

  /**
   * Withdraw unused funds from an account's drips balance back to its wallet.
   *
   * Simulates the withdrawable amount first; if the balance is zero the
   * transaction is **not** submitted and the method resolves with
   * `{ withdrawn: 0n, txHash: "" }`.
   *
   * @param account - Stellar address withdrawing from its own drips balance.
   * @param token - Stellar Asset Contract address of the token to withdraw.
   * @param signer - Function that signs the transaction XDR.
   * @returns `{ withdrawn, txHash }`. When nothing was withdrawn, `txHash` is `""`.
   */
  async withdraw(
    account: string,
    token: string,
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<WithdrawResult> {
    let withdrawable = 0n;
    try {
      const val = await this.simulate(
        "withdrawable",
        [
          nativeToScVal(account, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
        ],
        account
      );
      withdrawable = BigInt(scValToNative(val) ?? 0);
    } catch {
      withdrawable = 1n; // sentinel: proceed
    }

    if (withdrawable === 0n) {
      return { withdrawn: 0n, txHash: "" };
    }

    const txHash = await this.buildAndSend(
      account,
      "withdraw",
      [
        nativeToScVal(account, { type: "address" }),
        nativeToScVal(token, { type: "address" }),
      ],
      signer
    );

    const withdrawn = withdrawable === 1n ? 0n : withdrawable;
    return { withdrawn, txHash };
  }

  subscribeToSchedule(
    options: {
      intervalMs?: number;
      publicKey?: string;
      onError?: (err: unknown) => void;
    } = {}
  ): { unsubscribe: () => void } {
    const { intervalMs = 10_000, publicKey, onError = console.error } = options;

    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const schedule = await this.getSchedule(id, publicKey);
        if (!active || schedule === null) return;
        const claimable = await this.getClaimable(id, publicKey);
        if (!active) return;
        try {
          await callback(schedule, claimable);
        } catch {
          // Swallow callback errors — the caller's UI should not kill the poller.
        }
      } catch (err) {
        onError(err);
      }
    };

    // Fire immediately, then on each interval tick.
    void poll();
    const timerId = setInterval(() => void poll(), intervalMs);

    return {
      unsubscribe: () => {
        active = false;
        clearInterval(timerId);
      },
    };
  }

  /**
   * Poll `getBalance` on an interval and invoke `callback` with the latest
   * balance for an account/token pair.
   *
   * The first poll fires immediately; subsequent polls run every
   * `intervalMs` (default 10 000 ms).
   *
   * @param account - Stellar address whose balance to watch.
   * @param token - Stellar Asset Contract address of the token.
   * @param callback - Receives the latest `BalanceResult` on each poll.
   * @param intervalMs - Poll interval in milliseconds. Defaults to 10 000.
   * @returns Teardown function — call it to stop polling.
   */
  subscribeToBalance(
    account: string,
    token: string,
    callback: (balance: BalanceResult) => void | Promise<void>,
    intervalMs: number = 10_000
  ): () => void {
    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const balance = await this.getBalance(account, token);
        if (!active) return;
        try {
          await callback(balance);
        } catch {
          // Swallow callback errors — the caller's UI should not kill the poller.
        }
      } catch (err) {
        console.error(err);
      }
    };

    // Fire immediately, then on each interval tick.
    void poll();
    const timerId = setInterval(() => void poll(), intervalMs);

    return () => {
      active = false;
      clearInterval(timerId);
    };
  }
}


  /**
   * Configure splits receivers for an account wrapping the set_splits contract call.
   *
   * Splits divide incoming streams among multiple receivers according to their
   * configured weight in basis points. All weights must sum to exactly 10000.
   *
   * @param account - Stellar address configuring its own splits must sign the transaction.
   * @param receivers - Array of receivers with their weight allocations. Empty array clears splits.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction result with hash and settlement status.
   * @throws If weights do not sum to 10000 any weight is zero or negative or addresses are invalid.
   *
   * @example
   * ```typescript
   * await client.setSplits(myAddress, [
   *   { address: "GABC...", weightBps: 5000 },
   *   { address: "GDEF...", weightBps: 5000 }
   * ], signTransaction);
   * ```
   */
  async setSplits(
    account: string,
    receivers: SplitsReceiver[],
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<TransactionResult> {
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new Error("account must be a valid Stellar public key");
    }

    if (receivers.length === 0) {
      const args: xdr.ScVal[] = [
        nativeToScVal(account, { type: "address" }),
        xdr.ScVal.scvVec([]),
      ];
      return this.submitAndSettle(account, "set_splits", args, signer);
    }

    for (const [i, receiver] of receivers.entries()) {
      if (!StrKey.isValidEd25519PublicKey(receiver.address) && !StrKey.isValidContract(receiver.address)) {
        throw new Error(`receivers[${i}].address must be a valid Stellar address`);
      }
      if (receiver.weightBps <= 0) {
        throw new Error(`receivers[${i}].weightBps must be greater than 0`);
      }
      if (receiver.weightBps > 10000) {
        throw new Error(`receivers[${i}].weightBps must not exceed 10000`);
      }
    }

    const totalWeight = receivers.reduce((sum, r) => sum + r.weightBps, 0);
    if (totalWeight !== 10000) {
      throw new Error(`Total weight must equal 10000 basis points. Got ${totalWeight}.`);
    }

    const receiversVal = xdr.ScVal.scvVec(
      receivers.map((r) =>
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("account"),
            val: nativeToScVal(r.address, { type: "address" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("weight_bps"),
            val: nativeToScVal(r.weightBps, { type: "u32" }),
          }),
        ])
      )
    );

    const args: xdr.ScVal[] = [
      nativeToScVal(account, { type: "address" }),
      receiversVal,
    ];

    return this.submitAndSettle(account, "set_splits", args, signer);
  }
}

