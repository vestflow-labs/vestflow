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
} from "@stellar/stellar-sdk";
import type {
  ScheduleData,
  VestflowConfig,
  CreateScheduleParams,
  CreateGradedScheduleParams,
  VestingKind,
} from "./types";
import { xlmToStroops } from "./utils";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  testnet: {
    contractId: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
    rpcUrl: "https://soroban-testnet.stellar.org",
    nativeToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    contractId: "",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    nativeToken: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
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
  private readonly networkPassphrase: string;
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
    this.networkPassphrase = defaults.networkPassphrase;
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

  // ── Internal: build and send ──────────────────────────────────────────────

  private async buildAndSend(
    publicKey: string,
    method: string,
    args: xdr.ScVal[],
    signer: (xdr: string, opts: { networkPassphrase: string }) => Promise<string | { signedTxXdr: string }>
  ): Promise<string> {
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

    await this.waitForTransaction(submitted.hash);
    return submitted.hash;
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  /**
   * Poll Soroban RPC for a submitted transaction's outcome until it settles
   * (anything other than `NOT_FOUND`), backing off exponentially between
   * polls to avoid hammering the RPC endpoint while still resolving quickly
   * for fast-confirming transactions.
   *
   * @param hash - Transaction hash, e.g. as returned by `createSchedule`
   * @param timeoutMs - Maximum total time to wait before giving up (default 30000ms)
   * @param options - Optional backoff tuning
   * @param options.initialDelayMs - Delay before the first poll retry (default 1000ms)
   * @param options.maxDelayMs - Upper bound on the backoff delay (default 8000ms)
   * @returns The settled transaction response (e.g. status `SUCCESS` or `FAILED`)
   * @throws If the transaction is still `NOT_FOUND` when `timeoutMs` elapses
   */
  async waitForTransaction(
    hash: string,
    timeoutMs = 30_000,
    options: { initialDelayMs?: number; maxDelayMs?: number } = {}
  ): Promise<StellarRpc.Api.GetTransactionResponse> {
    const initialDelayMs = options.initialDelayMs ?? 1000;
    const maxDelayMs = options.maxDelayMs ?? 8000;
    const deadline = Date.now() + timeoutMs;

    let delay = initialDelayMs;
    let status = await this.server.getTransaction(hash);
    while (status.status === "NOT_FOUND") {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for transaction ${hash} to confirm after ${timeoutMs}ms`
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
      status = await this.server.getTransaction(hash);
    }
    return status;
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

  subscribeToSchedule(
    id: number,
    callback: (schedule: ScheduleData, claimable: bigint) => void | Promise<void>,
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
}
