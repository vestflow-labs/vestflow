import { Networks, rpc, Contract, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

// src/client.ts

// src/utils.ts
function xlmToStroops(amountXlm) {
  const normalized = amountXlm.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error("Invalid amount");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const fractionPadded = (fraction + "0000000").slice(0, 7);
  return BigInt(whole) * 10000000n + BigInt(fractionPadded);
}
function stroopsToXlm(stroops) {
  return (Number(stroops) / 1e7).toLocaleString(void 0, {
    maximumFractionDigits: 4
  });
}
function truncate(addr, prefixLen = 6, suffixLen = 4) {
  if (addr.length <= prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}
function vestingProgress(schedule, now) {
  if (now < schedule.start_time) return 0;
  const elapsed = now - schedule.start_time;
  return Math.min(100, Math.round(elapsed / schedule.duration * 100));
}
function formatDate(ts) {
  return new Date(ts * 1e3).toLocaleDateString(void 0, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}
function parseContractError(e) {
  const msg = e.message;
  if (msg.includes("Nothing to claim yet"))
    return "No tokens are available to claim yet.";
  if (msg.includes("Schedule is not revocable"))
    return "This schedule cannot be revoked.";
  if (msg.includes("Already revoked"))
    return "This schedule has already been revoked.";
  if (msg.includes("Not the grantor"))
    return "Only the grantor can perform this action.";
  if (msg.includes("Not the beneficiary"))
    return "Only the beneficiary can claim tokens.";
  if (msg.includes("Schedule not found"))
    return "Schedule not found.";
  if (msg.includes("Insufficient balance"))
    return "Insufficient balance to complete this action.";
  if (msg.includes("Schedule has ended"))
    return "This vesting schedule has already ended.";
  if (msg.includes("Start time in the past"))
    return "The start time must be in the future.";
  if (msg.includes("Duration too short") || msg.includes("DurationTooShort") || msg.includes("Contract error: 15") || msg.includes("Contract, #15"))
    return "The vesting duration is too short.";
  if (msg.includes("Beneficiary must differ from grantor"))
    return "The beneficiary must be a different address from the grantor.";
  if (msg.includes("Amount must be positive"))
    return "The vesting amount must be greater than zero.";
  if (msg.includes("Duration must be positive"))
    return "The vesting duration must be greater than zero.";
  if (msg.includes("Cliff cannot exceed duration"))
    return "The cliff period cannot be longer than the total vesting duration.";
  return msg;
}
function formatSchedule(s, now = Math.floor(Date.now() / 1e3)) {
  const endTime = s.start_time + s.duration;
  const cliffTime = s.cliff_duration > 0 ? s.start_time + s.cliff_duration : null;
  let status;
  if (s.revoked) {
    status = "Revoked";
  } else if (s.paused) {
    status = "Paused";
  } else if (now >= endTime) {
    status = "Completed";
  } else {
    status = "Active";
  }
  const elapsed = Math.max(0, now - s.start_time);
  const progressPct = s.duration > 0 ? Math.min(100, Math.round(elapsed / s.duration * 100)) : 100;
  const remaining = s.total_amount - s.claimed;
  return {
    id: String(s.id),
    grantor: truncate(s.grantor),
    beneficiary: truncate(s.beneficiary),
    totalAmountXlm: stroopsToXlm(s.total_amount),
    claimedXlm: stroopsToXlm(s.claimed),
    remainingXlm: stroopsToXlm(remaining >= 0n ? remaining : 0n),
    startDate: formatDate(s.start_time),
    endDate: formatDate(endTime),
    cliffDate: cliffTime !== null ? formatDate(cliffTime) : null,
    kind: s.kind,
    status,
    progressPct
  };
}
var TOTAL_SPLITS_WEIGHT = 1e4;
var MAX_SPLITS_RECEIVERS = 20;

// src/client.ts
var DEFAULTS = {
  testnet: {
    contractId: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
    rpcUrl: "https://soroban-testnet.stellar.org",
    nativeToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    networkPassphrase: Networks.TESTNET
  },
  mainnet: {
    contractId: "",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    nativeToken: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    networkPassphrase: Networks.PUBLIC
  }
};
var FALLBACK_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
var VestflowClient = class {
  /**
   * Create a new VestflowClient.
   *
   * @param config - Network and connection overrides. Defaults to testnet.
   */
  constructor(config = {}) {
    const net = config.network ?? "testnet";
    const defaults = DEFAULTS[net];
    this.contractId = config.contractId ?? defaults.contractId;
    this.nativeToken = config.nativeToken ?? defaults.nativeToken;
    this.networkPassphrase = defaults.networkPassphrase;
    this.server = new rpc.Server(config.rpcUrl ?? defaults.rpcUrl);
    this.signTransaction = null;
  }
  // ── Internal: simulate ────────────────────────────────────────────────────
  async simulate(method, args, publicKey) {
    const contract = new Contract(this.contractId);
    const source = publicKey ?? FALLBACK_ACCOUNT;
    const account = await this.server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase
    }).addOperation(contract.call(method, ...args)).setTimeout(30).build();
    const result = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(result)) {
      throw new Error(result.error);
    }
    return result.result.retval;
  }
  // ── Internal: build and send ──────────────────────────────────────────────
  async buildAndSend(publicKey, method, args, signer) {
    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(publicKey);
    let tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase
    }).addOperation(contract.call(method, ...args)).setTimeout(30).build();
    const simResult = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(simResult.error);
    }
    tx = rpc.assembleTransaction(tx, simResult).build();
    const signed = await signer(tx.toXDR(), {
      networkPassphrase: this.networkPassphrase
    });
    const xdrStr = typeof signed === "string" ? signed : signed.signedTxXdr;
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
  async waitForTransaction(hash, timeoutMs = 3e4, options = {}) {
    const initialDelayMs = options.initialDelayMs ?? 1e3;
    const maxDelayMs = options.maxDelayMs ?? 8e3;
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
  parseSchedule(raw) {
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
      kind: raw.kind === "Cliff" ? "Cliff" : raw.kind === "LinearWithCliff" ? "LinearWithCliff" : "Linear",
      revocable: Boolean(raw.revocable),
      revoked: Boolean(raw.revoked),
      paused: Boolean(raw.paused),
      lockup_duration: Number(raw.lockup_duration ?? raw.lockup_seconds ?? 0),
      requires_milestones: Boolean(raw.requires_milestones),
      vested_at_revoke: BigInt(raw.vested_at_revoke ?? 0),
      paused_duration: Number(raw.paused_duration ?? 0),
      paused_at: Number(raw.paused_at ?? 0)
    };
  }
  // ── Internal: parse delegation ────────────────────────────────────────────
  parseDelegation(raw) {
    return {
      delegate: raw.delegate?.toString() ?? "",
      maxAmount: raw.max_amount == null ? null : BigInt(raw.max_amount),
      expiresAtLedger: raw.expires_at_ledger == null ? null : Number(raw.expires_at_ledger),
      claimedSoFar: BigInt(raw.claimed_so_far ?? 0),
      revoked: Boolean(raw.revoked)
    };
  }
  // ── Read ──────────────────────────────────────────────────────────────────
  /**
   * Fetch a single vesting schedule by ID.
   * Returns null if the schedule does not exist.
   */
  async getSchedule(id, publicKey) {
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
  async getScheduleCount() {
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
  async getSchedulesByGrantor(grantor) {
    try {
      const val = await this.simulate("get_schedules_by_grantor", [
        nativeToScVal(grantor, { type: "address" })
      ]);
      return scValToNative(val).map(Number);
    } catch {
      return [];
    }
  }
  /**
   * Return all schedule IDs created by a given grantor, combining
   * single-token and multi-token schedules into a single list.
   */
  async getGrantorScheduleIds(grantor) {
    try {
      const val = await this.simulate("grantor_schedule_ids", [
        nativeToScVal(grantor, { type: "address" })
      ]);
      return scValToNative(val).map(Number);
    } catch {
      return [];
    }
  }
  /**
   * Return schedule IDs where the given address is the beneficiary.
   */
  async getSchedulesByBeneficiary(beneficiary) {
    try {
      const val = await this.simulate("get_schedules_by_beneficiary", [
        nativeToScVal(beneficiary, { type: "address" })
      ]);
      return scValToNative(val).map(Number);
    } catch {
      return [];
    }
  }
  /**
   * Return all schedule IDs where the given address is the beneficiary,
   * combining single-token and multi-token schedules into a single list.
   */
  async getBeneficiaryScheduleIds(beneficiary) {
    try {
      const val = await this.simulate("beneficiary_schedule_ids", [
        nativeToScVal(beneficiary, { type: "address" })
      ]);
      return scValToNative(val).map(Number);
    } catch {
      return [];
    }
  }
  /**
   * Return how many tokens are currently claimable for a schedule.
   */
  async getClaimable(id, publicKey) {
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
  async getClaimableAt(id, now, publicKey) {
    try {
      const val = await this.simulate(
        "claimable_amount",
        [
          nativeToScVal(id, { type: "u64" }),
          nativeToScVal(now, { type: "u64" })
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
  async getVestedAmountAt(id, now, publicKey) {
    try {
      const val = await this.simulate(
        "vested_amount",
        [
          nativeToScVal(id, { type: "u64" }),
          nativeToScVal(now, { type: "u64" })
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
  async getClaimableBulk(ids, publicKey) {
    if (ids.length === 0) return [];
    try {
      const idsVal = xdr.ScVal.scvVec(
        ids.map((id) => nativeToScVal(id, { type: "u64" }))
      );
      const val = await this.simulate("claimable_bulk", [idsVal], publicKey);
      const native = scValToNative(val);
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
  async getVestedAmountBulk(ids, publicKey) {
    if (ids.length === 0) return [];
    try {
      const idsVal = xdr.ScVal.scvVec(
        ids.map((id) => nativeToScVal(id, { type: "u64" }))
      );
      const val = await this.simulate("vested_amount_bulk", [idsVal], publicKey);
      const native = scValToNative(val);
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
  async getScheduleBatch(ids, publicKey) {
    if (ids.length === 0) return [];
    try {
      const idsVal = xdr.ScVal.scvVec(
        ids.map((id) => nativeToScVal(id, { type: "u64" }))
      );
      const val = await this.simulate("get_schedule_batch", [idsVal], publicKey);
      const rawItems = scValToNative(val);
      return rawItems.map((raw) => raw == null ? null : this.parseSchedule(raw));
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
  async getRemainingUnvested(scheduleId, publicKey) {
    const schedule = await this.getSchedule(scheduleId, publicKey);
    if (schedule === null) return 0n;
    const vested = await this.getVestedAmountCurrent(scheduleId, publicKey);
    const remaining = schedule.total_amount - vested;
    return remaining > 0n ? remaining : 0n;
  }
  /**
   * Return how many tokens are vested for a schedule using the current ledger time.
   */
  async getVestedAmountCurrent(id, publicKey) {
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
  async getClaimableAtTimestamp(id, ts, publicKey) {
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
  async getFullyVestedAt(id, publicKey) {
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
  async getAllSchedules(publicKey, timeoutMs = 3e4) {
    return this.withTimeout(
      this.fetchAllSchedules(publicKey),
      timeoutMs,
      `getAllSchedules timed out after ${timeoutMs}ms waiting for the Soroban RPC`
    );
  }
  async fetchAllSchedules(publicKey) {
    const count = await this.getScheduleCount();
    if (count === 0) return [];
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const schedules = await this.getScheduleBatch(ids, publicKey);
    return schedules.filter(Boolean);
  }
  /**
   * Fetch a single claim delegation by (scheduleId, delegationId).
   * Returns null if the delegation does not exist.
   */
  async getDelegation(scheduleId, delegationId, publicKey) {
    try {
      const val = await this.simulate(
        "get_delegation",
        [
          nativeToScVal(scheduleId, { type: "u64" }),
          nativeToScVal(delegationId, { type: "u32" })
        ],
        publicKey
      );
      const native = scValToNative(val);
      return native == null ? null : this.parseDelegation(native);
    } catch {
      return null;
    }
  }
  /**
   * Race a promise against a deadline, rejecting with `message` if it fires first.
   */
  withTimeout(promise, timeoutMs, message) {
    let timer;
    const deadline = new Promise((_, reject) => {
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
  async createSchedule(params, signer) {
    if (params.beneficiary === params.grantor) {
      throw new Error("beneficiary must be different from grantor");
    }
    const totalStroops = xlmToStroops(params.totalAmountXlm);
    const durationSecs = params.durationDays * 86400;
    const cliffSecs = params.cliffDays * 86400;
    const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(params.kind)]);
    const args = [
      nativeToScVal(params.grantor, { type: "address" }),
      nativeToScVal(params.beneficiary, { type: "address" }),
      nativeToScVal(this.nativeToken, { type: "address" }),
      nativeToScVal(totalStroops, { type: "i128" }),
      nativeToScVal(params.startTime, { type: "u64" }),
      nativeToScVal(durationSecs, { type: "u64" }),
      nativeToScVal(cliffSecs, { type: "u64" }),
      kindVal,
      nativeToScVal(params.revocable, { type: "bool" })
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
  async createGradedSchedule(params, signer) {
    if (params.beneficiary === params.grantor) {
      throw new Error("beneficiary must be different from grantor");
    }
    const totalStroops = BigInt(Math.round(params.totalAmountXlm * 1e7));
    const lockupSecs = params.lockupDays * 86400;
    const milestonesVal = xdr.ScVal.scvVec(
      params.milestones.map((m) => {
        const offsetSecs = BigInt(m.offsetDays * 86400);
        return xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("bps"),
            val: nativeToScVal(m.bps, { type: "u32" })
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("offset_secs"),
            val: nativeToScVal(offsetSecs, { type: "u64" })
          })
        ]);
      })
    );
    const args = [
      nativeToScVal(params.grantor, { type: "address" }),
      nativeToScVal(params.beneficiary, { type: "address" }),
      nativeToScVal(this.nativeToken, { type: "address" }),
      nativeToScVal(totalStroops, { type: "i128" }),
      nativeToScVal(params.startTime, { type: "u64" }),
      nativeToScVal(lockupSecs, { type: "u64" }),
      nativeToScVal(params.revocable, { type: "bool" }),
      milestonesVal
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
  async claimVested(publicKey, scheduleId, signer) {
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
  async revokeSchedule(publicKey, scheduleId, signer) {
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
  async pauseSchedule(publicKey, scheduleId, signer) {
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
  async resumeSchedule(publicKey, scheduleId, signer) {
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
  async transferBeneficiary(currentBeneficiary, scheduleId, newBeneficiary, signer) {
    return this.buildAndSend(
      currentBeneficiary,
      "transfer_beneficiary",
      [
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(newBeneficiary, { type: "address" })
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
  async extendDuration(grantor, scheduleId, additionalSeconds, signer) {
    return this.buildAndSend(
      grantor,
      "extend_duration",
      [
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(additionalSeconds, { type: "u64" })
      ],
      signer
    );
  }
  /**
   * Configure token splits for a vesting schedule.
   *
   * Allows the grantor to specify multiple receivers and their respective
   * weights (in basis points). When tokens are claimed, they are distributed
   * proportionally to each receiver based on their weight.
   *
   * The sum of all weights must equal TOTAL_SPLITS_WEIGHT (10_000 bps).
   * Maximum of MAX_SPLITS_RECEIVERS (20) receivers allowed.
   * Can only be called once per schedule.
   *
   * @param grantor - Grantor's Stellar public key (must sign the transaction).
   * @param scheduleId - ID of the schedule to configure splits for.
   * @param receivers - Array of receivers with their weights.
   * @param signer - Function that signs the transaction XDR.
   * @returns Transaction hash.
   * @throws If weights don't sum to TOTAL_SPLITS_WEIGHT, too many receivers,
   *   or splits already configured.
   */
  async setSplits(grantor, scheduleId, receivers, signer) {
    const totalWeight = receivers.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight !== TOTAL_SPLITS_WEIGHT) {
      throw new Error(
        `Invalid splits weight: weights must sum to ${TOTAL_SPLITS_WEIGHT} bps, got ${totalWeight}`
      );
    }
    if (receivers.length > MAX_SPLITS_RECEIVERS) {
      throw new Error(
        `Too many receivers: maximum is ${MAX_SPLITS_RECEIVERS}, got ${receivers.length}`
      );
    }
    for (const receiver of receivers) {
      if (receiver.weight <= 0) {
        throw new Error(`Invalid weight: each receiver must have weight > 0`);
      }
    }
    const addresses = receivers.map((r) => r.address);
    const uniqueAddresses = new Set(addresses);
    if (addresses.length !== uniqueAddresses.size) {
      throw new Error("Duplicate receiver addresses are not allowed");
    }
    const receiversVal = xdr.ScVal.scvVec(
      receivers.map(
        (r) => xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("address"),
            val: nativeToScVal(r.address, { type: "address" })
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("weight"),
            val: nativeToScVal(r.weight, { type: "u32" })
          })
        ])
      )
    );
    const hash = await this.buildAndSend(
      grantor,
      "set_splits",
      [
        nativeToScVal(scheduleId, { type: "u64" }),
        receiversVal
      ],
      signer
    );
    return { hash };
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
  async mergeSchedules(caller, ids, signer) {
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
  async proposeSchedule(params, signer) {
    if (params.beneficiary === params.grantor) {
      throw new Error("beneficiary must be different from grantor");
    }
    const totalStroops = xlmToStroops(params.totalAmountXlm);
    const durationSecs = params.durationDays * 86400;
    const cliffSecs = params.cliffDays * 86400;
    const lockupSecs = (params.lockupDays ?? 0) * 86400;
    const kindVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(params.kind)]);
    const args = [
      nativeToScVal(params.grantor, { type: "address" }),
      nativeToScVal(params.beneficiary, { type: "address" }),
      nativeToScVal(this.nativeToken, { type: "address" }),
      nativeToScVal(totalStroops, { type: "i128" }),
      nativeToScVal(params.startTime, { type: "u64" }),
      nativeToScVal(durationSecs, { type: "u64" }),
      nativeToScVal(cliffSecs, { type: "u64" }),
      nativeToScVal(lockupSecs, { type: "u64" }),
      kindVal,
      nativeToScVal(params.revocable, { type: "bool" })
    ];
    return this.buildAndSend(params.grantor, "propose_schedule", args, signer);
  }
  /**
   * Record that the beneficiary has seen a proposal.
   *
   * Does not block {@link fundAndActivate}.
   */
  async acknowledgeProposal(beneficiary, proposalId, signer) {
    return this.buildAndSend(
      beneficiary,
      "acknowledge_proposal",
      [
        nativeToScVal(beneficiary, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" })
      ],
      signer
    );
  }
  /**
   * Transfer tokens and activate a proposed schedule (grantor only).
   *
   * Must be called within 72 hours of {@link proposeSchedule}.
   */
  async fundAndActivate(grantor, proposalId, signer) {
    return this.buildAndSend(
      grantor,
      "fund_and_activate",
      [
        nativeToScVal(grantor, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" })
      ],
      signer
    );
  }
  /**
   * Mark a proposal as expired after the 72-hour window. Anyone may call this.
   * The proposal remains queryable with state `Expired`.
   */
  async expireProposal(caller, proposalId, signer) {
    return this.buildAndSend(
      caller,
      "expire_proposal",
      [
        nativeToScVal(caller, { type: "address" }),
        nativeToScVal(proposalId, { type: "u64" })
      ],
      signer
    );
  }
  /**
   * Fetch a proposal by ID.
   * Returns null if the proposal was never created. Expired proposals are
   * returned with state `Expired`.
   */
  async getProposal(id, publicKey) {
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
  parseProposal(raw) {
    return {
      id: Number(raw.id ?? 0),
      grantor: String(raw.grantor ?? ""),
      beneficiary: String(raw.beneficiary ?? ""),
      token: String(raw.token ?? ""),
      total_amount: BigInt(raw.total_amount ?? 0),
      start_time: Number(raw.start_time ?? 0),
      duration: Number(raw.duration ?? 0),
      cliff_duration: Number(raw.cliff_duration ?? 0),
      lockup_duration: Number(raw.lockup_duration ?? 0),
      kind: raw.kind === "Cliff" ? "Cliff" : raw.kind === "LinearWithCliff" ? "LinearWithCliff" : "Linear",
      revocable: Boolean(raw.revocable),
      state: this.parseProposalState(raw.state),
      created_at_ledger: Number(raw.created_at_ledger ?? 0)
    };
  }
  parseProposalState(raw) {
    if (raw == null) return "Pending";
    if (typeof raw === "string") {
      if (raw === "Acknowledged" || raw === "Expired" || raw === "Pending") {
        return raw;
      }
      return "Pending";
    }
    if (typeof raw === "object") {
      const obj = raw;
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
   * Fetch the splits configuration for a schedule.
   * Returns null if no splits are configured.
   */
  async getSplits(scheduleId, publicKey) {
    try {
      const val = await this.simulate(
        "get_splits",
        [nativeToScVal(scheduleId, { type: "u64" })],
        publicKey
      );
      const native = scValToNative(val);
      if (native == null) return null;
      return native.map((r) => ({
        address: String(r.address ?? ""),
        weight: Number(r.weight ?? 0)
      }));
    } catch {
      return null;
    }
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
  async createDelegation(beneficiary, scheduleId, delegate, maxAmountStroops, expiresAtLedger, signer) {
    const args = [
      nativeToScVal(beneficiary, { type: "address" }),
      nativeToScVal(scheduleId, { type: "u64" }),
      nativeToScVal(delegate, { type: "address" }),
      maxAmountStroops == null ? xdr.ScVal.scvVoid() : nativeToScVal(maxAmountStroops, { type: "i128" }),
      expiresAtLedger == null ? xdr.ScVal.scvVoid() : nativeToScVal(expiresAtLedger, { type: "u32" })
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
  async revokeDelegation(beneficiary, scheduleId, delegationId, signer) {
    return this.buildAndSend(
      beneficiary,
      "revoke_delegation",
      [
        nativeToScVal(beneficiary, { type: "address" }),
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(delegationId, { type: "u32" })
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
  async claimAsDelegate(delegate, scheduleId, delegationId, signer) {
    return this.buildAndSend(
      delegate,
      "claim_as_delegate",
      [
        nativeToScVal(delegate, { type: "address" }),
        nativeToScVal(scheduleId, { type: "u64" }),
        nativeToScVal(delegationId, { type: "u32" })
      ],
      signer
    );
  }
  subscribeToSchedule(id, callback, options = {}) {
    const { intervalMs = 1e4, publicKey, onError = console.error } = options;
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
        }
      } catch (err) {
        onError(err);
      }
    };
    void poll();
    const timerId = setInterval(() => void poll(), intervalMs);
    return {
      unsubscribe: () => {
        active = false;
        clearInterval(timerId);
      }
    };
  }
};

// src/types.ts
function isScheduleRevoked(s) {
  return s.revoked === true;
}

export { MAX_SPLITS_RECEIVERS, TOTAL_SPLITS_WEIGHT, VestflowClient, formatDate, formatSchedule, isScheduleRevoked, parseContractError, stroopsToXlm, truncate, vestingProgress, xlmToStroops };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map