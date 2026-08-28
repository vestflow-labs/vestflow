import { rpc } from '@stellar/stellar-sdk';

/**
 * The type of vesting curve applied to a schedule.
 * Mirrors the VestingKind enum in the Soroban contract.
 */
type VestingKind = "Linear" | "Cliff" | "LinearWithCliff";
/**
 * A vesting schedule that has been revoked by the grantor.
 * `isScheduleRevoked` narrows `ScheduleData` to this type.
 */
interface RevokedSchedule extends ScheduleData {
    readonly revoked: true;
}
/**
 * Type guard that narrows `ScheduleData` to `RevokedSchedule`.
 *
 * @example
 * if (isScheduleRevoked(schedule)) {
 *   // TypeScript knows schedule.revoked === true here
 * }
 */
declare function isScheduleRevoked(s: ScheduleData): s is RevokedSchedule;
/**
 * A fully parsed vesting schedule returned from the contract.
 */
interface ScheduleData {
    /** Unique schedule identifier assigned by the contract. */
    id: number;
    /** Stellar address of the account that created this schedule. */
    grantor: string;
    /** Stellar address of the account that receives vested tokens. */
    beneficiary: string;
    /** Stellar Asset Contract address of the vested token. */
    token: string;
    /** Total tokens locked into this schedule (in stroops / base units). */
    total_amount: bigint;
    /** Tokens already claimed by the beneficiary. */
    claimed: bigint;
    /** Unix timestamp when vesting begins. */
    start_time: number;
    /** Vesting duration in seconds. */
    duration: number;
    /** Cliff duration in seconds from start_time. */
    cliff_duration: number;
    /** Vesting curve type. */
    kind: VestingKind;
    /** Whether the grantor can revoke unvested tokens. */
    revocable: boolean;
    /** Whether this schedule has been revoked. */
    revoked: boolean;
    /** Whether this schedule is currently paused. */
    paused: boolean;
    /** Lockup duration in seconds from start_time. */
    lockup_duration: number;
    /** Whether this schedule requires milestones for graded vesting. */
    requires_milestones: boolean;
    /** Timestamp when vested balance was determined after revoke. */
    vested_at_revoke: bigint;
    /** Cumulative time (in seconds) the schedule has been paused. */
    paused_duration: number;
    /** Unix timestamp when the schedule was last paused (0 if not paused). */
    paused_at: number;
}
/**
 * Configuration for the VestflowClient.
 */
interface VestflowConfig {
    /**
     * Target Stellar network.
     * @default "testnet"
     */
    network?: "testnet" | "mainnet";
    /**
     * Override the contract ID.
     * Defaults to the deployed testnet contract address.
     */
    contractId?: string;
    /**
     * Override the Soroban RPC URL.
     * Defaults to the public endpoint for the selected network.
     */
    rpcUrl?: string;
    /**
     * Override the native token SAC address.
     * Defaults to the testnet native XLM SAC.
     */
    nativeToken?: string;
}
/**
 * Parameters for creating a new vesting schedule.
 */
interface CreateScheduleParams {
    /** Stellar public key of the grantor (must sign the transaction). */
    grantor: string;
    /** Stellar public key of the beneficiary. */
    beneficiary: string;
    /** Total amount to vest in XLM as a decimal string (converted to stroops internally). */
    totalAmountXlm: string;
    /** Unix timestamp when vesting begins. */
    startTime: number;
    /** Vesting duration in days. */
    durationDays: number;
    /** Cliff duration in days (0 for no cliff). */
    cliffDays: number;
    /** Vesting curve type. */
    kind: VestingKind;
    /** Whether the grantor can revoke unvested tokens. */
    revocable: boolean;
}
/**
 * A single unlock milestone for a graded vesting schedule.
 *
 * `offsetDays` — days after `startTime` when this tranche unlocks.
 * `bps`        — basis points (out of 10 000) of `totalAmountXlm` that unlock.
 *
 * All milestones in a schedule must sum to exactly 10 000 bps.
 */
interface GradedMilestone {
    /** Days after startTime when this tranche unlocks. */
    offsetDays: number;
    /** Basis points (out of 10 000) of total amount that unlock at this milestone. */
    bps: number;
}
/**
 * Lifecycle of an escrow schedule proposal.
 * Mirrors the ProposalState enum in the Soroban contract.
 */
type ProposalState = "Pending" | "Acknowledged" | {
    tag: "Activated";
    scheduleId: number;
} | "Expired";
/**
 * A two-phase escrow proposal returned from the contract.
 */
interface ScheduleProposal {
    id: number;
    grantor: string;
    beneficiary: string;
    token: string;
    total_amount: bigint;
    start_time: number;
    duration: number;
    cliff_duration: number;
    lockup_duration: number;
    kind: VestingKind;
    revocable: boolean;
    state: ProposalState;
    created_at_ledger: number;
}
/**
 * Parameters for proposing a vesting schedule without transferring tokens.
 */
interface ProposeScheduleParams extends CreateScheduleParams {
    /** Lockup duration in days. Defaults to 0. Must be >= cliffDays. */
    lockupDays?: number;
}
/**
 * A delegation of claim rights from a schedule's beneficiary to a
 * third-party address, optionally bounded by amount and/or ledger expiry.
 * Mirrors the ClaimDelegation struct in the Soroban contract.
 */
interface ClaimDelegation {
    /** Address authorized to claim on the beneficiary's behalf. */
    delegate: string;
    /** Maximum total tokens this delegate may ever claim, or null if unlimited. */
    maxAmount: bigint | null;
    /** Ledger sequence after which this delegation can no longer be used to claim, or null if no expiry. */
    expiresAtLedger: number | null;
    /** Tokens already claimed through this delegation. */
    claimedSoFar: bigint;
    /** Whether the beneficiary has revoked this delegation. */
    revoked: boolean;
}
/**
 * Parameters for creating a new graded (percentage-based) vesting schedule.
 */
interface CreateGradedScheduleParams {
    /** Stellar public key of the grantor (must sign the transaction). */
    grantor: string;
    /** Stellar public key of the beneficiary. */
    beneficiary: string;
    /** Total amount to vest in XLM (converted to stroops internally). */
    totalAmountXlm: number;
    /** Unix timestamp when vesting begins. */
    startTime: number;
    /** Lockup duration in days — tokens are earned but non-transferable until this date. */
    lockupDays: number;
    /** Whether the grantor can revoke unvested tokens. */
    revocable: boolean;
    /**
     * Ordered list of unlock milestones.
     * Must be non-empty and sum to exactly 10 000 bps.
     */
    milestones: GradedMilestone[];
}
/**
 * A single receiver in a splits configuration.
 * Each receiver gets a share of vested tokens proportional to their weight.
 * Mirrors the SplitsReceiver struct in the Soroban contract.
 */
interface SplitsReceiver {
    /** Stellar address of the receiver. */
    address: string;
    /** Weight in basis points (out of TOTAL_SPLITS_WEIGHT).
     * Must be > 0 and sum of all weights must equal TOTAL_SPLITS_WEIGHT. */
    weight: number;
}
/**
 * Parameters for configuring token splits on a vesting schedule.
 */
interface SetSplitsParams {
    /** Stellar public key of the grantor (must sign the transaction). */
    grantor: string;
    /** Schedule ID to configure splits for. */
    scheduleId: number;
    /** List of receivers and their weights. */
    receivers: SplitsReceiver[];
}
/**
 * Result of a successful transaction.
 */
interface TransactionResult {
    /** Transaction hash. */
    hash: string;
}

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
declare class VestflowClient {
    private readonly server;
    private readonly contractId;
    private readonly nativeToken;
    private readonly networkPassphrase;
    private readonly signTransaction;
    /**
     * Create a new VestflowClient.
     *
     * @param config - Network and connection overrides. Defaults to testnet.
     */
    constructor(config?: VestflowConfig);
    private simulate;
    private buildAndSend;
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
    waitForTransaction(hash: string, timeoutMs?: number, options?: {
        initialDelayMs?: number;
        maxDelayMs?: number;
    }): Promise<rpc.Api.GetTransactionResponse>;
    private parseSchedule;
    private parseDelegation;
    /**
     * Fetch a single vesting schedule by ID.
     * Returns null if the schedule does not exist.
     */
    getSchedule(id: number, publicKey?: string): Promise<ScheduleData | null>;
    /**
     * Return the total number of schedules ever created.
     */
    getScheduleCount(): Promise<number>;
    /**
     * Return schedule IDs created by a given grantor address.
     */
    getSchedulesByGrantor(grantor: string): Promise<number[]>;
    /**
     * Return all schedule IDs created by a given grantor, combining
     * single-token and multi-token schedules into a single list.
     */
    getGrantorScheduleIds(grantor: string): Promise<number[]>;
    /**
     * Return schedule IDs where the given address is the beneficiary.
     */
    getSchedulesByBeneficiary(beneficiary: string): Promise<number[]>;
    /**
     * Return all schedule IDs where the given address is the beneficiary,
     * combining single-token and multi-token schedules into a single list.
     */
    getBeneficiaryScheduleIds(beneficiary: string): Promise<number[]>;
    /**
     * Return how many tokens are currently claimable for a schedule.
     */
    getClaimable(id: number, publicKey?: string): Promise<bigint>;
    /**
     * Return how many tokens are claimable for a schedule at a specific time.
     */
    getClaimableAt(id: number, now: number, publicKey?: string): Promise<bigint>;
    /**
     * Return how many tokens are vested for a schedule at a specific time.
     */
    getVestedAmountAt(id: number, now: number, publicKey?: string): Promise<bigint>;
    /**
     * Fetch claimable amounts for multiple schedule IDs in a single
     * simulation round-trip using the claimable_bulk contract view.
     *
     * Results are in the same order as the input ids.
     * Unknown IDs return 0n.
     */
    getClaimableBulk(ids: number[], publicKey?: string): Promise<bigint[]>;
    /**
     * Fetch total vested amounts (earned, including already-claimed) for multiple
     * schedule IDs in a single simulation round-trip using the vested_amount_bulk
     * contract view.
     *
     * Results are in the same order as the input ids.
     * Unknown IDs return 0n.
     */
    getVestedAmountBulk(ids: number[], publicKey?: string): Promise<bigint[]>;
    /**
     * Fetch multiple schedules in a single simulation round-trip.
     *
     * Returns results in the same order as `ids`. Unknown IDs return null.
     * Replaces the Promise.all(getSchedule) N-call pattern.
     */
    getScheduleBatch(ids: number[], publicKey?: string): Promise<(ScheduleData | null)[]>;
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
    getRemainingUnvested(scheduleId: number, publicKey?: string): Promise<bigint>;
    /**
     * Return how many tokens are vested for a schedule using the current ledger time.
     */
    getVestedAmountCurrent(id: number, publicKey?: string): Promise<bigint>;
    /**
     * Preview how many tokens will be claimable at an arbitrary future timestamp.
     *
     * The result reflects current schedule state projected to `ts` — most
     * meaningful for future timestamps.
     * Returns 0n for unknown schedule IDs.
     */
    getClaimableAtTimestamp(id: number, ts: number, publicKey?: string): Promise<bigint>;
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
    getFullyVestedAt(id: number, publicKey?: string): Promise<number | null>;
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
    getAllSchedules(publicKey?: string, timeoutMs?: number): Promise<ScheduleData[]>;
    private fetchAllSchedules;
    /**
     * Fetch a single claim delegation by (scheduleId, delegationId).
     * Returns null if the delegation does not exist.
     */
    getDelegation(scheduleId: number, delegationId: number, publicKey?: string): Promise<ClaimDelegation | null>;
    /**
     * Race a promise against a deadline, rejecting with `message` if it fires first.
     */
    private withTimeout;
    /**
     * Create a new vesting schedule and lock tokens into the contract.
     *
     * @param params - Schedule parameters
     * @param signer - Function that signs the transaction XDR (e.g. Freighter's signTransaction)
     * @returns Transaction hash
     * @throws If `params.beneficiary` equals `params.grantor`
     */
    createSchedule(params: CreateScheduleParams, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
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
    createGradedSchedule(params: CreateGradedScheduleParams, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Claim all currently vested but unclaimed tokens for a schedule.
     *
     * @param publicKey - Beneficiary's Stellar public key
     * @param scheduleId - ID of the schedule to claim from
     * @param signer - Function that signs the transaction XDR
     * @returns Transaction hash
     */
    claimVested(publicKey: string, scheduleId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Revoke a vesting schedule (grantor only, revocable schedules only).
     * Unvested tokens return to the grantor; vested tokens remain claimable.
     *
     * @param publicKey - Grantor's Stellar public key
     * @param scheduleId - ID of the schedule to revoke
     * @param signer - Function that signs the transaction XDR
     * @returns Transaction hash
     */
    revokeSchedule(publicKey: string, scheduleId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
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
    pauseSchedule(publicKey: string, scheduleId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Resume a paused vesting schedule (grantor only).
     *
     * @param publicKey - Grantor's Stellar public key
     * @param scheduleId - ID of the schedule to resume
     * @param signer - Function that signs the transaction XDR
     * @returns Transaction hash
     */
    resumeSchedule(publicKey: string, scheduleId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Transfer beneficiary of a vesting schedule (current beneficiary only).
     *
     * @param currentBeneficiary - Current beneficiary's Stellar public key (signs the transaction)
     * @param scheduleId - ID of the schedule to transfer
     * @param newBeneficiary - New beneficiary's Stellar public key
     * @param signer - Function that signs the transaction XDR
     * @returns Transaction hash
     */
    transferBeneficiary(currentBeneficiary: string, scheduleId: number, newBeneficiary: string, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
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
    extendDuration(grantor: string, scheduleId: number, additionalSeconds: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
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
    setSplits(grantor: string, scheduleId: number, receivers: SplitsReceiver[], signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<TransactionResult>;
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
    mergeSchedules(caller: string, ids: number[], signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Propose a vesting schedule without transferring tokens.
     *
     * The grantor later calls {@link fundAndActivate} within 72 hours to lock
     * tokens and start the schedule. Beneficiary acknowledgment is optional.
     */
    proposeSchedule(params: ProposeScheduleParams, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Record that the beneficiary has seen a proposal.
     *
     * Does not block {@link fundAndActivate}.
     */
    acknowledgeProposal(beneficiary: string, proposalId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Transfer tokens and activate a proposed schedule (grantor only).
     *
     * Must be called within 72 hours of {@link proposeSchedule}.
     */
    fundAndActivate(grantor: string, proposalId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Mark a proposal as expired after the 72-hour window. Anyone may call this.
     * The proposal remains queryable with state `Expired`.
     */
    expireProposal(caller: string, proposalId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Fetch a proposal by ID.
     * Returns null if the proposal was never created. Expired proposals are
     * returned with state `Expired`.
     */
    getProposal(id: number, publicKey?: string): Promise<ScheduleProposal | null>;
    private parseProposal;
    private parseProposalState;
    /**
     * Fetch the splits configuration for a schedule.
     * Returns null if no splits are configured.
     */
    getSplits(scheduleId: number, publicKey?: string): Promise<SplitsReceiver[] | null>;
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
    createDelegation(beneficiary: string, scheduleId: number, delegate: string, maxAmountStroops: bigint | null, expiresAtLedger: number | null, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    /**
     * Revoke a claim delegation, immediately and permanently disabling it.
     *
     * @param beneficiary - Current beneficiary's Stellar public key (signs the transaction).
     * @param scheduleId - ID of the schedule the delegation belongs to.
     * @param delegationId - ID of the delegation to revoke.
     * @param signer - Function that signs the transaction XDR.
     * @returns Transaction hash.
     */
    revokeDelegation(beneficiary: string, scheduleId: number, delegationId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
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
    claimAsDelegate(delegate: string, scheduleId: number, delegationId: number, signer: (xdr: string, opts: {
        networkPassphrase: string;
    }) => Promise<string | {
        signedTxXdr: string;
    }>): Promise<string>;
    subscribeToSchedule(id: number, callback: (schedule: ScheduleData, claimable: bigint) => void | Promise<void>, options?: {
        intervalMs?: number;
        publicKey?: string;
        onError?: (err: unknown) => void;
    }): {
        unsubscribe: () => void;
    };
}

/**
 * Convert an XLM amount string to stroops using integer-only arithmetic.
 *
 * Avoids floating-point imprecision (e.g. 0.0000001 XLM → 1 stroop).
 *
 * @example
 * xlmToStroops("1")           // 10_000_000n
 * xlmToStroops("0.0000001")   // 1n
 */
declare function xlmToStroops(amountXlm: string): bigint;
/**
 * Convert a stroop value to a human-readable XLM string.
 *
 * @example
 * stroopsToXlm(10_000_000n) // "1.0000"
 * stroopsToXlm(5_500_000n)  // "0.5500"
 */
declare function stroopsToXlm(stroops: bigint): string;
/**
 * Truncate a Stellar public key for display.
 *
 * @example
 * truncate("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
 * // "GAAZI4...CCWN"
 */
declare function truncate(addr: string, prefixLen?: number, suffixLen?: number): string;
/**
 * Calculate the vesting progress percentage for a schedule at a given time.
 *
 * Returns a value between 0 and 100.
 *
 * @param schedule - The vesting schedule
 * @param now - Current Unix timestamp in seconds
 */
declare function vestingProgress(schedule: ScheduleData, now: number): number;
/**
 * Format a Unix timestamp as a human-readable date string.
 *
 * @example
 * formatDate(1_700_000_000) // "Nov 14, 2023"
 */
declare function formatDate(ts: number): string;
/**
 * Parse a contract error message into a user-friendly string.
 *
 * Maps raw Soroban contract panic strings to readable messages
 * so dApps can display them directly without string matching.
 */
declare function parseContractError(e: Error): string;
/**
 * Human-readable summary of a vesting schedule.
 *
 * All stroop values are converted to XLM strings; all timestamps are
 * converted to locale date strings so consuming components do not repeat
 * the same conversion logic.
 */
interface ScheduleSummary {
    /** Schedule ID as a string for display. */
    id: string;
    /** Abbreviated grantor address. */
    grantor: string;
    /** Abbreviated beneficiary address. */
    beneficiary: string;
    /** Total vesting amount in XLM (e.g. "1,000.0000"). */
    totalAmountXlm: string;
    /** Already-claimed amount in XLM. */
    claimedXlm: string;
    /** Remaining (unclaimed) amount in XLM. */
    remainingXlm: string;
    /** Vesting start date (locale string). */
    startDate: string;
    /** Vesting end date (locale string). */
    endDate: string;
    /** Cliff date, or null when no cliff applies. */
    cliffDate: string | null;
    /** Vesting curve label. */
    kind: string;
    /** "Active" | "Revoked" | "Paused" | "Completed" */
    status: string;
    /** Percentage of total duration elapsed (0–100). */
    progressPct: number;
}
/**
 * Return a human-readable summary object for a vesting schedule.
 *
 * Centralises stroops → XLM conversion and timestamp → date formatting
 * so downstream apps don't repeat the same transformation logic.
 *
 * @param s   - A `ScheduleData` object returned from `VestflowClient.getSchedule`.
 * @param now - Current Unix timestamp in seconds (defaults to `Date.now() / 1000`).
 *
 * @example
 * const summary = formatSchedule(schedule);
 * console.log(summary.totalAmountXlm); // "1,000.0000"
 * console.log(summary.status);         // "Active"
 */
declare function formatSchedule(s: ScheduleData, now?: number): ScheduleSummary;
/**
 * Total weight for splits (100% = 10_000 basis points).
 * All receiver weights must sum to this value.
 * Mirrors the TOTAL_SPLITS_WEIGHT constant in the Soroban contract.
 */
declare const TOTAL_SPLITS_WEIGHT = 10000;
/**
 * Maximum number of receivers allowed in a splits configuration.
 * Mirrors the MAX_SPLITS_RECEIVERS constant in the Soroban contract.
 */
declare const MAX_SPLITS_RECEIVERS = 20;

export { type ClaimDelegation, type CreateGradedScheduleParams, type CreateScheduleParams, type GradedMilestone, MAX_SPLITS_RECEIVERS, type ProposalState, type ProposeScheduleParams, type RevokedSchedule, type ScheduleData, type ScheduleProposal, type ScheduleSummary, type SetSplitsParams, type SplitsReceiver, TOTAL_SPLITS_WEIGHT, type TransactionResult, VestflowClient, type VestflowConfig, type VestingKind, formatDate, formatSchedule, isScheduleRevoked, parseContractError, stroopsToXlm, truncate, vestingProgress, xlmToStroops };
