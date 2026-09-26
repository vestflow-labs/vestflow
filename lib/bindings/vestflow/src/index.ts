import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export type DataKey = {tag: "Schedule", values: readonly [u64]} | {tag: "ScheduleCount", values: void} | {tag: "MultiTokenSchedule", values: readonly [u64]} | {tag: "MultiTokenScheduleCount", values: void} | {tag: "UpgradeAuthority", values: void} | {tag: "PendingUpgrade", values: void} | {tag: "GrantorSchedules", values: readonly [string]} | {tag: "GrantorMultiTokenSchedules", values: readonly [string]} | {tag: "BeneficiarySchedules", values: readonly [string]} | {tag: "BeneficiaryMultiTokenSchedules", values: readonly [string]} | {tag: "NftContract", values: void} | {tag: "PerformanceMilestones", values: readonly [u64]} | {tag: "PerformanceOracle", values: void} | {tag: "Proposal", values: readonly [u64]} | {tag: "ProposalCount", values: void};

/**
 * The type of vesting curve applied to a schedule.
 */
export type VestingKind = {tag: "Linear", values: void} | {tag: "Cliff", values: void} | {tag: "LinearWithCliff", values: void} | {tag: "Graded", values: void};


/**
 * A single token with its amount in a multi-token vesting schedule.
 */
export interface TokenTranche {
  /**
 * Amount of this token already claimed by the beneficiary.
 */
claimed_amount: i128;
  /**
 * Stellar asset contract for this token.
 */
token: string;
  /**
 * Total amount of this token locked in the schedule.
 */
total_amount: i128;
}

/**
 * Storage keys for claim delegations, keyed separately from [`DataKey`] so
 * delegation records don't crowd the schedule key space.
 */
export type DelegationKey = {tag: "Delegation", values: readonly [u64, u32]} | {tag: "DelegationCount", values: readonly [u64]} | {tag: "ActiveDelegationCount", values: readonly [u64]};

/**
 * Lifecycle of an escrow schedule proposal.
 */
export type ProposalState = {tag: "Pending", values: void} | {tag: "Acknowledged", values: void} | {tag: "Activated", values: readonly [u64]} | {tag: "Expired", values: void};

export const VestFlowError = {
  1: {message:"NotFound"},
  2: {message:"NotRevocable"},
  3: {message:"AlreadyRevoked"},
  4: {message:"NothingToClaim"},
  5: {message:"AmountZero"},
  6: {message:"DurationZero"},
  7: {message:"CliffExceedsDuration"},
  8: {message:"ScheduleRevoked"},
  9: {message:"LockupLessThanCliff"},
  10: {message:"InvalidToken"},
  11: {message:"ProposalNotFound"},
  12: {message:"ProposalNotExpired"},
  13: {message:"ProposalExpired"},
  14: {message:"ProposalAlreadyActivated"},
  15: {message:"DurationTooShort"},
  16: {message:"DelegationNotFound"},
  17: {message:"DelegationRevoked"},
  18: {message:"DelegationExpired"},
  19: {message:"DelegationExhausted"},
  20: {message:"NotDelegate"},
  21: {message:"TooManyDelegations"},
  22: {message:"MergeTypeMismatch"},
  23: {message:"MergeTooFewSchedules"},
  24: {message:"MergeTooManySchedules"},
  25: {message:"MergeTokenMismatch"},
  26: {message:"MergeOwnerMismatch"}
}


/**
 * A contract WASM upgrade that has been announced on-chain but not yet executed.
 */
export interface PendingUpgrade {
  /**
 * Ledger timestamp when the upgrade was announced.
 */
announced_at: u64;
  /**
 * Earliest ledger timestamp when the upgrade may be executed.
 */
executable_at: u64;
  /**
 * Hash of the already-uploaded WASM blob to migrate this contract to.
 */
wasm_hash: Buffer;
}


/**
 * A delegation of claim rights from a schedule's beneficiary to a
 * third-party address, optionally bounded by amount and/or ledger expiry.
 */
export interface ClaimDelegation {
  /**
 * Tokens already claimed through this delegation.
 */
claimed_so_far: i128;
  /**
 * Address authorized to claim on the beneficiary's behalf.
 */
delegate: string;
  /**
 * Ledger sequence after which this delegation can no longer be used to
 * claim. `None` = no expiry.
 */
expires_at_ledger: Option<u32>;
  /**
 * Maximum total tokens this delegate may ever claim. `None` = unlimited.
 */
max_amount: Option<i128>;
  /**
 * Whether the beneficiary has revoked this delegation.
 */
revoked: boolean;
}


/**
 * A single milestone for graded vesting.
 *
 * `offset_secs` — seconds after `start_time` when this tranche unlocks.
 * `bps`         — basis points (1/10_000) of `total_amount` that unlock.
 *
 * The milestones in a schedule must sum to exactly 10_000 bps.
 */
export interface GradedMilestone {
  /**
 * Basis points (out of 10_000) of `total_amount` that unlock.
 */
bps: u32;
  /**
 * Seconds after `start_time` when this tranche unlocks.
 */
offset_secs: u64;
}


export interface VestingSchedule {
  /**
 * Address that can claim vested tokens.
 */
beneficiary: string;
  /**
 * Tokens already claimed by the beneficiary.
 */
claimed_amount: i128;
  /**
 * Cliff in seconds from `start_time`.
 *
 * - `Linear`: ignored.
 * - `Cliff`: tokens unlock all-at-once after this many seconds.
 * - `LinearWithCliff`: no tokens until this point; linear from here to end.
 * - `Graded`: ignored (milestones define the schedule).
 */
cliff_seconds: u64;
  /**
 * Vesting duration in seconds.
 */
duration_seconds: u64;
  /**
 * Address that created and funded this schedule.
 */
grantor: string;
  id: u64;
  kind: VestingKind;
  /**
 * Lockup period in seconds from `start_time`.
 * During lockup, tokens are vested (earned) but non-transferable.
 * Beneficiary can claim after lockup expires even if tokens vested earlier.
 * Must be >= cliff_seconds.
 */
lockup_duration: u64;
  /**
 * Milestone tranches for `VestingKind::Graded` schedules.
 * Empty for all other kinds.
 */
milestones: Array<GradedMilestone>;
  /**
 * Whether this schedule is currently paused.
 */
paused: boolean;
  /**
 * Timestamp when the schedule was last paused (0 if not paused).
 */
paused_at: u64;
  /**
 * Cumulative time (in seconds) the schedule has been paused.
 */
paused_duration: u64;
  /**
 * Whether performance milestones are required for this schedule.
 */
requires_milestones: boolean;
  /**
 * Whether the grantor can revoke unvested tokens.
 */
revocable: boolean;
  /**
 * Whether this schedule has been revoked.
 */
revoked: boolean;
  /**
 * Unix timestamp when vesting begins.
 */
start_time: u64;
  /**
 * Stellar asset contract for the vested token.
 */
token: string;
  /**
 * Total tokens locked into this schedule (in stroops / base units).
 */
total_amount: i128;
  /**
 * Tokens that were vested at the moment of revocation.
 * Zero for non-revoked schedules. Used so the beneficiary can still
 * claim already-vested tokens after a revocation.
 */
vested_at_revoke: i128;
}


/**
 * Parameters and status of a two-phase escrow proposal.
 */
export interface ScheduleProposal {
  beneficiary: string;
  cliff_duration: u64;
  created_at_ledger: u32;
  duration: u64;
  grantor: string;
  id: u64;
  kind: VestingKind;
  lockup_duration: u64;
  revocable: boolean;
  start_time: u64;
  state: ProposalState;
  token: string;
  total_amount: i128;
}


/**
 * Performance milestone attestation for gating vesting releases.
 */
export interface PerformanceMilestone {
  /**
 * Whether the milestone has been attested by the oracle.
 */
attested: boolean;
  /**
 * Timestamp when the milestone was attested.
 */
attested_at: u64;
  /**
 * Percentage of total vesting unlocked by this milestone (0-100).
 */
unlock_percentage: u32;
}


/**
 * A vesting schedule that supports multiple Stellar assets simultaneously.
 *
 * Allows a single schedule to vest different tokens on the same timeline,
 * avoiding the need to create separate schedules for each token.
 */
export interface MultiTokenVestingSchedule {
  /**
 * Address that can claim vested tokens.
 */
beneficiary: string;
  /**
 * Cliff in seconds from `start_time`.
 */
cliff_seconds: u64;
  /**
 * Vesting duration in seconds.
 */
duration_seconds: u64;
  /**
 * Address that created and funded this schedule.
 */
grantor: string;
  id: u64;
  kind: VestingKind;
  /**
 * Lockup period in seconds from `start_time`.
 */
lockup_duration: u64;
  /**
 * Milestone tranches for `VestingKind::Graded` schedules.
 */
milestones: Array<GradedMilestone>;
  /**
 * Whether this schedule is currently paused.
 */
paused: boolean;
  /**
 * Timestamp when the schedule was last paused (0 if not paused).
 */
paused_at: u64;
  /**
 * Cumulative time (in seconds) the schedule has been paused.
 */
paused_duration: u64;
  /**
 * Whether the grantor can revoke unvested tokens.
 */
revocable: boolean;
  /**
 * Whether this schedule has been revoked.
 */
revoked: boolean;
  /**
 * Unix timestamp when vesting begins.
 */
start_time: u64;
  /**
 * Multiple tokens with their amounts and claim tracking.
 */
tokens: Array<TokenTranche>;
  /**
 * Tokens that were vested at the moment of revocation.
 */
vested_at_revoke: i128;
}

export interface Client {
  /**
   * Construct and simulate a claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claim all currently vested but unclaimed tokens.
   *
   * Vested-but-unclaimed tokens remain claimable even after a revocation.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   */
  claim: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke a vesting schedule (grantor only, revocable schedules only).
   * Unvested tokens are returned to the grantor. Already-vested tokens
   * remain claimable by the beneficiary.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Schedule is not revocable"` if the schedule is irrevocable.
   * Panics with `"Already revoked"` if the schedule has already been revoked.
   */
  revoke: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the contract version.
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a claimable transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Preview how many tokens are claimable right now for a given schedule.
   *
   * Returns 0 if `schedule_id` is unknown (does not panic).
   */
  claimable: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a is_revoked transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check whether a schedule has been revoked without loading the full schedule.
   *
   * Cheaper than `get_schedule` when the caller only needs to know revocation
   * status. Returns `false` for unknown schedule IDs (does not panic).
   */
  is_revoked: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return a proposal by id, or `None` if it was never created.
   */
  get_proposal: ({proposal_id}: {proposal_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ScheduleProposal>>>

  /**
   * Construct and simulate a get_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a vesting schedule by ID.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   */
  get_schedule: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<VestingSchedule>>>

  /**
   * Construct and simulate a nft_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the configured NFT contract address.
   */
  nft_contract: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a total_locked transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: return the sum of all unvested amounts for a given token.
   *
   * Iterates through all schedules and sums the unvested (unlocked but not claimed)
   * amounts for schedules using the specified token. Useful for protocol-level
   * tracking of total locked tokens by asset.
   */
  total_locked: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a vesting_type transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the vesting kind of a schedule without loading the full schedule.
   *
   * This is a cheap view that lets frontends and SDKs branch on the
   * vesting curve type (Linear, Cliff, LinearWithCliff, Graded) without
   * paying for a full storage read of the entire `VestingSchedule` struct.
   *
   * Returns `None` for unknown schedule IDs (does not panic).
   */
  vesting_type: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<VestingKind>>>

  /**
   * Construct and simulate a vested_amount transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: return the vested amount for a schedule ID at a specific time.
   *
   * The vested amount is the total tokens that have unlocked according to
   * the schedule's vesting curve, including already-claimed tokens.
   * Returns 0 for unknown schedule IDs.
   */
  vested_amount: ({schedule_id, now}: {schedule_id: u64, now: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a cancel_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel the currently pending upgrade announcement.
   *
   * The upgrade may only be cancelled before the timelock expires. Once the
   * upgrade becomes executable, it cannot be cancelled through this function.
   *
   * # Errors
   *
   * Panics with `"No pending upgrade"` when no upgrade is pending.
   * Panics with `"Upgrade already executable"` if the timelock has expired.
   */
  cancel_upgrade: ({authority}: {authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a claimable_bulk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch view: return claimable amounts for multiple schedule IDs in a
   * single simulation round-trip.
   *
   * Results are returned in the same order as the input `ids` vector.
   * Unknown IDs return 0 instead of panicking, so the caller can safely
   * pass the full ID range without knowing which ones exist.
   *
   * This replaces the `Promise.all(claimable)` pattern in the frontend
   * dashboard, reducing N simulation round-trips to 1.
   */
  claimable_bulk: ({ids}: {ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Array<i128>>>

  /**
   * Construct and simulate a get_delegation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a claim delegation by (schedule_id, delegation_id).
   *
   * Returns `None` if unknown rather than panicking.
   */
  get_delegation: ({schedule_id, delegation_id}: {schedule_id: u64, delegation_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ClaimDelegation>>>

  /**
   * Construct and simulate a get_milestones transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get performance milestones for a schedule.
   */
  get_milestones: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Array<PerformanceMilestone>>>>

  /**
   * Construct and simulate a pause_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pause an active vesting schedule (grantor only).
   *
   * While paused, no additional tokens vest. The beneficiary can still claim
   * already-vested tokens. The grantor can resume the schedule later.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Not the grantor"` if caller is not the grantor.
   * Panics with `"Schedule already paused"` if already paused.
   * Panics with `"Cannot pause revoked schedule"` if schedule is revoked.
   */
  pause_schedule: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a schedule_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * How many schedules have been created in total.
   */
  schedule_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a create_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new vesting schedule and lock the tokens into the contract.
   *
   * The grantor must approve the contract to transfer `total_amount` of
   * `token` before calling this function.
   *
   * # Errors
   *
   * Panics with `"Amount must be positive"` if `total_amount` ≤ 0.
   * Returns `DurationZero` if `duration` = 0.
   * Returns `DurationTooShort` if `0 < duration` < 60.
   * Panics with `"Cliff cannot exceed duration"` if `cliff_duration` > `duration`.
   * Panics with `"Lockup cannot be less than cliff"` if `lockup_duration` < `cliff_duration`.
   * Panics with `"Beneficiary must differ from grantor"` if `beneficiary == grantor`.
   * Panics with `"Start time cannot be in the past"` if `start_time` < current ledger time.
   * Returns `InvalidToken` if `token` is not a recognised Stellar Asset Contract.
   */
  create_schedule: ({grantor, beneficiary, token, total_amount, start_time, duration, cliff_duration, lockup_duration, kind, revocable}: {grantor: string, beneficiary: string, token: string, total_amount: i128, start_time: u64, duration: u64, cliff_duration: u64, lockup_duration: u64, kind: VestingKind, revocable: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a execute_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute the pending contract WASM migration after the 48-hour timelock.
   *
   * The pending upgrade must have been announced on-chain by
   * [`announce_upgrade`] at least [`UPGRADE_TIMELOCK_SECONDS`] earlier.
   * Soroban applies the WASM replacement only after this invocation
   * completes successfully.
   *
   * # Errors
   *
   * Panics with `"No pending upgrade"` when no upgrade is pending.
   * Panics with `"Upgrade timelock still active"` before 48 hours elapse.
   */
  execute_upgrade: ({authority}: {authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a expire_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mark an unactivated proposal as expired after the 72-hour window.
   *
   * Anyone who authorizes the call may expire an unactivated proposal.
   * The proposal remains readable via [`get_proposal`] with
   * [`ProposalState::Expired`]. Activated proposals are kept so they
   * remain auditable. Calling this on an already expired proposal is a
   * no-op.
   */
  expire_proposal: ({caller, proposal_id}: {caller: string, proposal_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a extend_duration transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend the vesting duration of an existing schedule.
   *
   * Only the **grantor** of the schedule may call this entry point.
   * The schedule must not be revoked.
   *
   * `additional_seconds` is added to the current `duration`, pushing the
   * end date forward without changing the `start_time` or any already-vested
   * amounts. This is equivalent to re-issuing the grant with a longer
   * horizon — useful when an employee stays beyond the original grant period.
   *
   * Emits an `"ext_dur"` event with `(schedule_id, old_duration, new_duration, timestamp)`.
   *
   * # Panics
   *
   * - `"Schedule not found"` — unknown `schedule_id`.
   * - `"Schedule has been revoked"` — cannot extend a revoked schedule.
   * - `"Additional seconds must be positive"` — zero extension is rejected.
   */
  extend_duration: ({schedule_id, additional_seconds}: {schedule_id: u64, additional_seconds: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a fully_vested_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: return the timestamp at which a schedule reaches 100% vested.
   *
   * Correct for every `VestingKind`, including `Graded`, where the
   * naive client-side `start_time + duration` calculation breaks
   * because the last milestone's offset determines full vesting.
   * Returns `None` for unknown schedule IDs.
   */
  fully_vested_at: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a merge_schedules transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Atomically combine multiple active vesting schedules belonging to the
   * same grantor-beneficiary pair into a single unified schedule.
   *
   * Every currently-claimable amount is paid out from each source before
   * merging (paused sources are never skipped — `claimable_at` already
   * accounts for frozen elapsed time while paused). The merged schedule's
   * `total_amount` is the exact sum of each source's remaining
   * (unclaimed) balance, so the token invariant
   * `claimed_total + merged.total_amount == sum(source.total_amount)`
   * holds exactly with no rounding dust.
   *
   * `start_time`, `duration_seconds`, `cliff_seconds`, and
   * `lockup_duration` are each the token-weighted average of the sources,
   * weighted by remaining balance. Because every source individually
   * satisfies `cliff <= duration` and `lockup >= cliff`, and a weighted
   * average of pointwise-ordered values preserves that order under floor
   * division by a common denominator, the merged schedule automatically
   * satisfies the same invariants without extra clamping.
   *
   * # Errors
   *
   * - `MergeTooFewSc
   */
  merge_schedules: ({caller, ids}: {caller: string, ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a pending_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the pending upgrade announcement, if any.
   */
  pending_upgrade: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingUpgrade>>>

  /**
   * Construct and simulate a resume_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Resume a paused vesting schedule (grantor only).
   *
   * Accumulates the paused duration and resumes vesting from the current time.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Not the grantor"` if caller is not the grantor.
   * Panics with `"Schedule not paused"` if not currently paused.
   */
  resume_schedule: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a announce_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Announce an upcoming contract WASM migration on-chain.
   *
   * The WASM identified by `wasm_hash` must already be uploaded. This
   * function verifies the WASM exists before recording the announcement,
   * preventing announcement of non-existent WASM hashes.
   *
   * # Errors
   *
   * Panics with `"Upgrade authority not initialized"` if unset.
   * Panics with `"Unauthorized upgrade authority"` if `authority` is not the configured authority.
   * Panics with `"WASM not found"` if the WASM hash has not been uploaded.
   */
  announce_upgrade: ({authority, wasm_hash}: {authority: string, wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<PendingUpgrade>>

  /**
   * Construct and simulate a attest_milestone transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Attest a performance milestone (oracle only).
   *
   * # Errors
   *
   * Panics with `"Oracle not initialized"` if oracle is not configured.
   * Panics with `"Not the oracle"` if caller is not the oracle.
   * Panics with `"Milestone index out of bounds"` if invalid index.
   * Panics with `"Milestone already attested"` if already attested.
   */
  attest_milestone: ({schedule_id, milestone_index}: {schedule_id: u64, milestone_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a claimable_amount transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Preview how many tokens are claimable at a specific timestamp.
   *
   * Returns 0 if `schedule_id` is unknown (does not panic).
   */
  claimable_amount: ({schedule_id, now}: {schedule_id: u64, now: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a destroy_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Destroy a schedule and reclaim storage for fully-claimed, irrevocable schedules.
   *
   * Only callable by the beneficiary or grantor.
   *
   * Panics if `claimed_amount < total_amount` or if the schedule is revocable.
   * Removes schedule entry and index entries and emits a `destroyed` event.
   */
  destroy_schedule: ({caller, schedule_id}: {caller: string, schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a propose_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lock schedule parameters without transferring tokens.
   *
   * The grantor later calls [`fund_and_activate`] within
   * [`PROPOSAL_WINDOW_LEDGERS`] to move funds and start the schedule.
   * Acknowledgment by the beneficiary is optional and auditable.
   *
   * # Errors
   *
   * Returns `AmountZero` if `total_amount` ≤ 0.
   * Returns `DurationZero` if `duration` = 0.
   * Returns `DurationTooShort` if `0 < duration` < 60.
   * Returns `CliffExceedsDuration` if `cliff_duration` > `duration`.
   */
  propose_schedule: ({grantor, beneficiary, token, total_amount, start_time, duration, cliff_duration, lockup_duration, kind, revocable}: {grantor: string, beneficiary: string, token: string, total_amount: i128, start_time: u64, duration: u64, cliff_duration: u64, lockup_duration: u64, kind: VestingKind, revocable: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a transfer_grantor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer grantor rights to a new address (current grantor only).
   *
   * Moves revocation and pause rights to `new_grantor`. Updates the grantor
   * schedule index for both the old and new grantor. Emits a `"grnt_chng"`
   * event with `(old_grantor, new_grantor, timestamp)`.
   *
   * Returns `Ok(())` immediately when `new_grantor` is the same as the
   * current grantor (no-op).
   *
   * # Errors
   *
   * Returns `VestFlowError::NotFound` if `schedule_id` does not exist.
   */
  transfer_grantor: ({schedule_id, new_grantor}: {schedule_id: u64, new_grantor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a bump_schedule_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend this contract instance's storage TTL. Callable by anyone
   * (beneficiary, grantor, or a third-party keeper) -- there is nothing
   * sensitive about keeping the contract alive, and requiring auth here
   * would just make it harder for keepers to run this permissionlessly.
   *
   * `schedule_id` is validated to exist so a caller gets a clear
   * [`VestFlowError::NotFound`] instead of silently bumping TTL for a
   * schedule that was never created (e.g. a typo'd ID).
   *
   * # Note on storage tier
   *
   * Schedules currently live in **instance** storage (see [`DataKey::Schedule`]
   * and every other read/write in this contract), not persistent storage --
   * there is no independent per-schedule persistent entry to bump yet. Instance
   * storage has a single TTL for the whole contract instance, so this extends
   * that shared TTL rather than a per-schedule key. If schedules are ever
   * migrated to persistent storage (tracked separately), this should be
   * updated to call `env.storage().persistent().extend_ttl(&DataKey::Schedule(schedule_id), ..)`
   * instead.
   *
   * # Errors
   *
   * Re
   */
  bump_schedule_ttl: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_as_delegate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claim vested tokens on behalf of a beneficiary through a delegation.
   *
   * Tokens are transferred directly to `delegate`. The claim is capped by
   * whatever is currently claimable on the schedule and, if set, by the
   * delegation's remaining `max_amount - claimed_so_far` budget. The token
   * transfer and both counter updates (`delegation.claimed_so_far` and
   * `schedule.claimed_amount`) happen within this single invocation, so a
   * failed transfer reverts every state change here — there is no window
   * where the counters advance without the tokens actually moving.
   *
   * Soroban auth for this call is scoped to `(schedule_id, delegation_id)`
   * via `require_auth_for_args`, not a blanket `delegate.require_auth()`.
   * A signature authorizing a claim for one delegation cannot be replayed
   * against a different delegation or schedule, even one with the same
   * delegate address.
   *
   * # Errors
   *
   * Returns `NotFound` if `schedule_id` does not exist.
   * Returns `DelegationNotFound` if `delegation_id` does not exist for this schedule.
   * Returns `NotDelegate` if `delega
   */
  claim_as_delegate: ({delegate, schedule_id, delegation_id}: {delegate: string, schedule_id: u64, delegation_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_multi_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claim all vested tokens from a multi-token schedule.
   *
   * Transfers all available claimable amounts across all tokens in the schedule
   * to the beneficiary, subject to cliff and lockup constraints.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if the schedule ID doesn't exist.
   * Panics with `"Nothing to claim yet"` if no tokens are claimable.
   */
  claim_multi_token: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_delegation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Delegate claim rights on a schedule to a third-party address.
   *
   * The delegate may later call [`claim_as_delegate`] to pull vested
   * tokens directly to their own address, bounded by `max_amount` and/or
   * `expires_at_ledger`. A schedule may have at most
   * [`MAX_DELEGATIONS_PER_SCHEDULE`] concurrently active (non-revoked)
   * delegations; revoking one frees a slot.
   *
   * # Errors
   *
   * Returns `NotFound` if `schedule_id` does not exist.
   * Returns `TooManyDelegations` if 5 active delegations already exist for this schedule.
   * Panics with `"Not the beneficiary"` if `beneficiary` is not the schedule's beneficiary.
   * Panics with `"Delegate must differ from beneficiary"` if `delegate == beneficiary`.
   * Panics with `"Max amount must be positive"` if `max_amount` is `Some(n)` with `n <= 0`.
   * Panics with `"Expiry must be in the future"` if `expires_at_ledger` is at or before the current ledger sequence.
   */
  create_delegation: ({beneficiary, schedule_id, delegate, max_amount, expires_at_ledger}: {beneficiary: string, schedule_id: u64, delegate: string, max_amount: Option<i128>, expires_at_ledger: Option<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a fund_and_activate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer tokens and create the schedule from a pending proposal.
   *
   * Acknowledgment is optional. Fails if the 72-hour window has elapsed
   * or if the proposal was already activated. `start_time` is taken from
   * the frozen proposal and is not re-checked against the current ledger
   * time, so a proposal created with `start_time = now` remains fundable.
   */
  fund_and_activate: ({grantor, proposal_id}: {grantor: string, proposal_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a get_grantor_multi transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get all multi-token schedule IDs for a grantor.
   */
  get_grantor_multi: ({grantor}: {grantor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a irrevocable_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: return the number of irrevocable schedules.
   *
   * Counts schedules where `revocable` is false. Useful for protocol-level
   * trust metrics — beneficiaries and investors care how many schedules
   * cannot be cancelled by the grantor.
   */
  irrevocable_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a revoke_delegation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke a claim delegation, immediately and permanently disabling it.
   *
   * Idempotent: revoking an already-revoked delegation is a no-op success.
   * Any `claim_as_delegate` call that has not yet started executing in a
   * later transaction will see `revoked == true` and be rejected — Soroban
   * applies transactions within a ledger sequentially, so there is no
   * window where a revocation and a claim can both partially apply.
   *
   * # Errors
   *
   * Returns `NotFound` if `schedule_id` does not exist.
   * Returns `DelegationNotFound` if `delegation_id` does not exist for this schedule.
   * Panics with `"Not the beneficiary"` if `beneficiary` is not the schedule's beneficiary.
   */
  revoke_delegation: ({beneficiary, schedule_id, delegation_id}: {beneficiary: string, schedule_id: u64, delegation_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a upgrade_authority transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the configured upgrade authority.
   *
   * # Errors
   *
   * Panics with `"Upgrade authority not initialized"` if unset.
   */
  upgrade_authority: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_schedule_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch view: fetch multiple schedules in a single simulation round-trip.
   *
   * Returns `None` for unknown IDs rather than panicking, so callers can
   * safely pass a contiguous range without knowing which IDs exist.
   * Results are returned in the same order as the input `ids` vector.
   *
   * This replaces the `Promise.all(getSchedule)` pattern in the frontend
   * dashboard, reducing N simulation round-trips to 1.
   */
  get_schedule_batch: ({ids}: {ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Option<VestingSchedule>>>>

  /**
   * Construct and simulate a get_upgrade_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the status of a pending upgrade: hash and executable timestamp.
   *
   * Allows users and governance tools to inspect a pending upgrade without
   * parsing raw storage keys. Returns the WASM hash and the timestamp when
   * execution becomes possible, or `None` if no upgrade is pending.
   */
  get_upgrade_status: (options?: MethodOptions) => Promise<AssembledTransaction<Option<readonly [Buffer, u64]>>>

  /**
   * Construct and simulate a performance_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the configured performance oracle address.
   */
  performance_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a vested_amount_bulk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch view: return vested amounts for multiple schedule IDs in a
   * single simulation round-trip.
   *
   * Results are returned in the same order as the input `ids` vector.
   * Unknown IDs return 0 instead of panicking, so the caller can safely
   * pass the full ID range without knowing which ones exist.
   */
  vested_amount_bulk: ({ids}: {ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Array<i128>>>

  /**
   * Construct and simulate a cliff_unlock_amount transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: return the number of tokens that unlock at the cliff date for a
   * `Cliff` or `LinearWithCliff` schedule.
   *
   * | Kind              | Return value                                        |
   * |-------------------|-----------------------------------------------------|
   * | `Cliff`           | `total_amount` (everything unlocks at cliff)        |
   * | `LinearWithCliff` | 0 — the cliff itself unlocks nothing extra; linear  |
   * |                   | vesting begins at the cliff date                    |
   * | `Linear` / other  | 0 — no cliff concept applies                        |
   * | Unknown ID        | 0                                                   |
   *
   * The return value is in stroops (base token units). Beneficiaries can
   * compare this against `claimable()` to understand how much will become
   * available at the cliff without doing off-chain math.
   */
  cliff_unlock_amount: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a locked_at_timestamp transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Preview how many tokens are vested but still inside the lockup window at
   * timestamp `ts`.
   *
   * Returns 0 once the lockup has elapsed (those tokens appear via
   * `claimable_at_timestamp` instead), when no lockup is configured, or
   * when `schedule_id` is unknown.
   *
   * Frontends can call this alongside `claimable_at_timestamp` to
   * distinguish "your tokens are vesting but locked until DATE" from
   * "nothing has vested yet".
   */
  locked_at_timestamp: ({schedule_id, ts}: {schedule_id: u64, ts: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a acknowledge_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record that the beneficiary has seen the proposal.
   *
   * Does not block [`fund_and_activate`]. Idempotent if already acknowledged.
   */
  acknowledge_proposal: ({beneficiary, proposal_id}: {beneficiary: string, proposal_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a grantor_schedule_ids transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return **all** schedule IDs created by a given grantor, combining
   * single-token and multi-token schedules into a single list.
   *
   * The frontend can use this single view to load every schedule a
   * grantor has created without fetching the entire schedule space and
   * filtering client-side.
   *
   * Returns an empty vec if the grantor has not created any schedules.
   */
  grantor_schedule_ids: ({grantor}: {grantor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a transfer_beneficiary transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer beneficiary rights to a new address.
   *
   * Only the current beneficiary may call this. The schedule must not be
   * revoked. Emits a `bnf_chng` event with
   * `(schedule_id, old_beneficiary, new_beneficiary)`.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Schedule has been revoked"` if the schedule was revoked.
   */
  transfer_beneficiary: ({schedule_id, new_beneficiary}: {schedule_id: u64, new_beneficiary: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claimable_multi_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get claimable amounts for all tokens in a multi-token schedule.
   */
  claimable_multi_token: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Array<i128>>>

  /**
   * Construct and simulate a get_beneficiary_multi transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get all multi-token schedule IDs for a beneficiary.
   */
  get_beneficiary_multi: ({beneficiary}: {beneficiary: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a vested_amount_current transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: return the vested amount for a schedule ID using the current
   * ledger timestamp.
   */
  vested_amount_current: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a claimable_at_timestamp transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Preview how many tokens will be claimable at an arbitrary timestamp `ts`.
   *
   * Intended for UI previews such as "how much can I claim at the 1-year
   * mark?". The result reflects current schedule state projected to `ts`:
   * it accounts for lockup, pauses (accumulated up to now), cliff, and
   * revocation, but uses the current `claimed_amount` — so the return value
   * is most meaningful for future timestamps.
   *
   * Returns 0 if `schedule_id` is unknown (does not panic).
   */
  claimable_at_timestamp: ({schedule_id, ts}: {schedule_id: u64, ts: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a create_graded_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new graded (percentage-based) vesting schedule.
   *
   * Tokens unlock at discrete milestones. Each milestone specifies an
   * offset in seconds from `start_time` and a share in basis points
   * (1 bps = 0.01%). The milestones must sum to exactly 10 000 bps.
   *
   * Example: 10% at month 6, 20% at month 12, 70% at month 24 would use
   * milestones with offset_secs 15_552_000 / 31_104_000 / 62_208_000 and
   * bps 1_000 / 2_000 / 7_000 respectively.
   *
   * # Errors
   *
   * Panics with `"Amount must be positive"` if `total_amount` ≤ 0.
   * Panics with `"Start time cannot be in the past"` if `start_time` < current ledger time.
   * Panics with `"Milestones required"` if the milestones list is empty.
   * Panics with `"Milestone unlock percentage must be non-zero"` if any milestone has 0 bps.
   * Panics with `"Milestones must sum to 10000 bps"` if the bps total ≠ 10 000.
   */
  create_graded_schedule: ({grantor, beneficiary, token, total_amount, start_time, lockup_duration, revocable, milestones}: {grantor: string, beneficiary: string, token: string, total_amount: i128, start_time: u64, lockup_duration: u64, revocable: boolean, milestones: Array<GradedMilestone>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a initialize_nft_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize the NFT contract for vesting receipt tokens.
   *
   * Can only be called once by the upgrade authority.
   *
   * # Errors
   *
   * Panics with `"NFT contract already initialized"` if called again.
   */
  initialize_nft_contract: ({nft_contract}: {nft_contract: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a beneficiary_schedule_ids transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return **all** schedule IDs where the given address is the
   * beneficiary, combining single-token and multi-token schedules into
   * a single list.
   *
   * Returns an empty vec if the address has no beneficiary schedules.
   */
  beneficiary_schedule_ids: ({beneficiary}: {beneficiary: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a get_multi_token_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get a multi-token schedule by ID.
   */
  get_multi_token_schedule: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<MultiTokenVestingSchedule>>>

  /**
   * Construct and simulate a get_schedules_by_grantor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return schedule IDs created by a given grantor.
   *
   * Returns an empty vec if the grantor has not created any schedules.
   */
  get_schedules_by_grantor: ({grantor}: {grantor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a transfer_upgrade_authority transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer upgrade authority to a new address.
   *
   * Both the current and new authority must sign. Emits an `"upgr_xfr"` event.
   */
  transfer_upgrade_authority: ({current_authority, new_authority}: {current_authority: string, new_authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a create_multi_token_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new multi-token vesting schedule supporting simultaneous vesting of multiple assets.
   *
   * Allows a beneficiary to receive multiple different tokens on the same vesting timeline,
   * eliminating the need to create separate schedules for each token.
   *
   * # Arguments
   *
   * * `grantor` - Address funding the schedule and authorized to revoke
   * * `beneficiary` - Address receiving all vested tokens
   * * `tokens` - Vec of TokenTranche (each token, amount, and claim tracking)
   * * `start_time` - Unix timestamp when vesting begins
   * * `duration` - Vesting duration in seconds
   * * `cliff_duration` - Cliff period in seconds (0 for no cliff)
   * * `lockup_duration` - Lockup period in seconds (must be >= cliff_duration)
   * * `kind` - VestingKind (Linear, Cliff, LinearWithCliff, or Graded)
   * * `revocable` - Whether grantor can revoke unvested tokens
   * * `milestones` - GradedMilestone vec for Graded kind (empty for others)
   *
   * # Errors
   *
   * Panics with various validation errors (see single-token `create_schedule`)
   */
  create_multi_token_schedule: ({grantor, beneficiary, tokens, start_time, duration, cliff_duration, lockup_duration, kind, revocable, milestones}: {grantor: string, beneficiary: string, tokens: Array<TokenTranche>, start_time: u64, duration: u64, cliff_duration: u64, lockup_duration: u64, kind: VestingKind, revocable: boolean, milestones: Array<GradedMilestone>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a get_schedules_by_beneficiary transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return schedule IDs where the given address is the beneficiary.
   *
   * Returns an empty vec if the address has no beneficiary schedules.
   */
  get_schedules_by_beneficiary: ({beneficiary}: {beneficiary: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a initialize_upgrade_authority transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize the address that may announce and execute contract upgrades.
   *
   * This may only be called once, and the chosen authority must authorize
   * the call. Once initialized, every contract WASM migration must be
   * announced with [`announce_upgrade`] and wait at least 48 hours before
   * [`execute_upgrade`] can apply it.
   *
   * # Errors
   *
   * Panics with `"Upgrade authority already initialized"` if called again.
   */
  initialize_upgrade_authority: ({authority}: {authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a enable_performance_milestones transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Enable performance-based vesting for a schedule (grantor only).
   *
   * Once enabled, the beneficiary can only claim tokens after the oracle
   * attests the required milestones.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Not the grantor"` if caller is not the grantor.
   * Panics with `"Milestones already enabled"` if already enabled.
   */
  enable_performance_milestones: ({schedule_id, milestones}: {schedule_id: u64, milestones: Array<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a initialize_performance_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize the oracle address authorized to attest performance milestones.
   *
   * Can only be called once by the upgrade authority.
   *
   * # Errors
   *
   * Panics with `"Oracle already initialized"` if called again.
   */
  initialize_performance_oracle: ({oracle}: {oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAMZDbGFpbSBhbGwgY3VycmVudGx5IHZlc3RlZCBidXQgdW5jbGFpbWVkIHRva2Vucy4KClZlc3RlZC1idXQtdW5jbGFpbWVkIHRva2VucyByZW1haW4gY2xhaW1hYmxlIGV2ZW4gYWZ0ZXIgYSByZXZvY2F0aW9uLgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiU2NoZWR1bGUgbm90IGZvdW5kImAgaWYgYHNjaGVkdWxlX2lkYCBkb2VzIG5vdCBleGlzdC4AAAAAAAVjbGFpbQAAAAAAAAEAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1WZXN0Rmxvd0Vycm9yAAAA",
        "AAAAAAAAAY5SZXZva2UgYSB2ZXN0aW5nIHNjaGVkdWxlIChncmFudG9yIG9ubHksIHJldm9jYWJsZSBzY2hlZHVsZXMgb25seSkuClVudmVzdGVkIHRva2VucyBhcmUgcmV0dXJuZWQgdG8gdGhlIGdyYW50b3IuIEFscmVhZHktdmVzdGVkIHRva2VucwpyZW1haW4gY2xhaW1hYmxlIGJ5IHRoZSBiZW5lZmljaWFyeS4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIG5vdCBmb3VuZCJgIGlmIGBzY2hlZHVsZV9pZGAgZG9lcyBub3QgZXhpc3QuClBhbmljcyB3aXRoIGAiU2NoZWR1bGUgaXMgbm90IHJldm9jYWJsZSJgIGlmIHRoZSBzY2hlZHVsZSBpcyBpcnJldm9jYWJsZS4KUGFuaWNzIHdpdGggYCJBbHJlYWR5IHJldm9rZWQiYCBpZiB0aGUgc2NoZWR1bGUgaGFzIGFscmVhZHkgYmVlbiByZXZva2VkLgAAAAAABnJldm9rZQAAAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAAABxSZXR1cm4gdGhlIGNvbnRyYWN0IHZlcnNpb24uAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAAAAAAAH5QcmV2aWV3IGhvdyBtYW55IHRva2VucyBhcmUgY2xhaW1hYmxlIHJpZ2h0IG5vdyBmb3IgYSBnaXZlbiBzY2hlZHVsZS4KClJldHVybnMgMCBpZiBgc2NoZWR1bGVfaWRgIGlzIHVua25vd24gKGRvZXMgbm90IHBhbmljKS4AAAAAAAljbGFpbWFibGUAAAAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAQAAAAs=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAADwAAAAEAAAAAAAAACFNjaGVkdWxlAAAAAQAAAAYAAAAAAAAAAAAAAA1TY2hlZHVsZUNvdW50AAAAAAAAAQAAAAAAAAASTXVsdGlUb2tlblNjaGVkdWxlAAAAAAABAAAABgAAAAAAAAAAAAAAF011bHRpVG9rZW5TY2hlZHVsZUNvdW50AAAAAAAAAABGQWRkcmVzcyBhdXRob3JpemVkIHRvIGFubm91bmNlLCBleGVjdXRlLCBhbmQgY2FuY2VsIGNvbnRyYWN0IHVwZ3JhZGVzLgAAAAAAEFVwZ3JhZGVBdXRob3JpdHkAAAAAAAAAMVRoZSBjdXJyZW50bHkgYW5ub3VuY2VkIGNvbnRyYWN0IHVwZ3JhZGUsIGlmIGFueS4AAAAAAAAOUGVuZGluZ1VwZ3JhZGUAAAAAAAEAAAArSW5kZXggb2Ygc2NoZWR1bGUgSURzIGNyZWF0ZWQgYnkgYSBncmFudG9yLgAAAAAQR3JhbnRvclNjaGVkdWxlcwAAAAEAAAATAAAAAQAAAAAAAAAaR3JhbnRvck11bHRpVG9rZW5TY2hlZHVsZXMAAAAAAAEAAAATAAAAAQAAADpJbmRleCBvZiBzY2hlZHVsZSBJRHMgd2hlcmUgYW4gYWRkcmVzcyBpcyB0aGUgYmVuZWZpY2lhcnkuAAAAAAAUQmVuZWZpY2lhcnlTY2hlZHVsZXMAAAABAAAAEwAAAAEAAAAAAAAAHkJlbmVmaWNpYXJ5TXVsdGlUb2tlblNjaGVkdWxlcwAAAAAAAQAAABMAAAAAAAAAME5GVCB0b2tlbiBjb250cmFjdCBhZGRyZXNzIGZvciB2ZXN0aW5nIHJlY2VpcHRzLgAAAAtOZnRDb250cmFjdAAAAAABAAAAMlBlcmZvcm1hbmNlIG1pbGVzdG9uZSBhdHRlc3RhdGlvbnMgZm9yIGEgc2NoZWR1bGUuAAAAAAAVUGVyZm9ybWFuY2VNaWxlc3RvbmVzAAAAAAAAAQAAAAYAAAAAAAAAL09yYWNsZSBhZGRyZXNzIGF1dGhvcml6ZWQgdG8gYXR0ZXN0IG1pbGVzdG9uZXMuAAAAABFQZXJmb3JtYW5jZU9yYWNsZQAAAAAAAAEAAABGRXNjcm93IHByb3Bvc2FsIGJ5IGlkLiBBcHBlbmRlZCB0byBhdm9pZCBjb2xsaWRpbmcgd2l0aCBleGlzdGluZyBrZXlzLgAAAAAACFByb3Bvc2FsAAAAAQAAAAYAAAAAAAAALE1vbm90b25pYyBjb3VudGVyIG9mIHByb3Bvc2FscyBldmVyIGNyZWF0ZWQuAAAADVByb3Bvc2FsQ291bnQAAAA=",
        "AAAAAAAAANpDaGVjayB3aGV0aGVyIGEgc2NoZWR1bGUgaGFzIGJlZW4gcmV2b2tlZCB3aXRob3V0IGxvYWRpbmcgdGhlIGZ1bGwgc2NoZWR1bGUuCgpDaGVhcGVyIHRoYW4gYGdldF9zY2hlZHVsZWAgd2hlbiB0aGUgY2FsbGVyIG9ubHkgbmVlZHMgdG8ga25vdyByZXZvY2F0aW9uCnN0YXR1cy4gUmV0dXJucyBgZmFsc2VgIGZvciB1bmtub3duIHNjaGVkdWxlIElEcyAoZG9lcyBub3QgcGFuaWMpLgAAAAAACmlzX3Jldm9rZWQAAAAAAAEAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAABAAAAAQ==",
        "AAAAAAAAADtSZXR1cm4gYSBwcm9wb3NhbCBieSBpZCwgb3IgYE5vbmVgIGlmIGl0IHdhcyBuZXZlciBjcmVhdGVkLgAAAAAMZ2V0X3Byb3Bvc2FsAAAAAQAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAEAAAPoAAAH0AAAABBTY2hlZHVsZVByb3Bvc2Fs",
        "AAAAAAAAAG1SZWFkIGEgdmVzdGluZyBzY2hlZHVsZSBieSBJRC4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIG5vdCBmb3VuZCJgIGlmIGBzY2hlZHVsZV9pZGAgZG9lcyBub3QgZXhpc3QuAAAAAAAADGdldF9zY2hlZHVsZQAAAAEAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAPVmVzdGluZ1NjaGVkdWxlAAAAB9AAAAANVmVzdEZsb3dFcnJvcgAAAA==",
        "AAAAAAAAAChHZXQgdGhlIGNvbmZpZ3VyZWQgTkZUIGNvbnRyYWN0IGFkZHJlc3MuAAAADG5mdF9jb250cmFjdAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAQVWaWV3OiByZXR1cm4gdGhlIHN1bSBvZiBhbGwgdW52ZXN0ZWQgYW1vdW50cyBmb3IgYSBnaXZlbiB0b2tlbi4KCkl0ZXJhdGVzIHRocm91Z2ggYWxsIHNjaGVkdWxlcyBhbmQgc3VtcyB0aGUgdW52ZXN0ZWQgKHVubG9ja2VkIGJ1dCBub3QgY2xhaW1lZCkKYW1vdW50cyBmb3Igc2NoZWR1bGVzIHVzaW5nIHRoZSBzcGVjaWZpZWQgdG9rZW4uIFVzZWZ1bCBmb3IgcHJvdG9jb2wtbGV2ZWwKdHJhY2tpbmcgb2YgdG90YWwgbG9ja2VkIHRva2VucyBieSBhc3NldC4AAAAAAAAMdG90YWxfbG9ja2VkAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAU9SZXR1cm4gdGhlIHZlc3Rpbmcga2luZCBvZiBhIHNjaGVkdWxlIHdpdGhvdXQgbG9hZGluZyB0aGUgZnVsbCBzY2hlZHVsZS4KClRoaXMgaXMgYSBjaGVhcCB2aWV3IHRoYXQgbGV0cyBmcm9udGVuZHMgYW5kIFNES3MgYnJhbmNoIG9uIHRoZQp2ZXN0aW5nIGN1cnZlIHR5cGUgKExpbmVhciwgQ2xpZmYsIExpbmVhcldpdGhDbGlmZiwgR3JhZGVkKSB3aXRob3V0CnBheWluZyBmb3IgYSBmdWxsIHN0b3JhZ2UgcmVhZCBvZiB0aGUgZW50aXJlIGBWZXN0aW5nU2NoZWR1bGVgIHN0cnVjdC4KClJldHVybnMgYE5vbmVgIGZvciB1bmtub3duIHNjaGVkdWxlIElEcyAoZG9lcyBub3QgcGFuaWMpLgAAAAAMdmVzdGluZ190eXBlAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAPoAAAH0AAAAAtWZXN0aW5nS2luZAA=",
        "AAAAAAAAAO9WaWV3OiByZXR1cm4gdGhlIHZlc3RlZCBhbW91bnQgZm9yIGEgc2NoZWR1bGUgSUQgYXQgYSBzcGVjaWZpYyB0aW1lLgoKVGhlIHZlc3RlZCBhbW91bnQgaXMgdGhlIHRvdGFsIHRva2VucyB0aGF0IGhhdmUgdW5sb2NrZWQgYWNjb3JkaW5nIHRvCnRoZSBzY2hlZHVsZSdzIHZlc3RpbmcgY3VydmUsIGluY2x1ZGluZyBhbHJlYWR5LWNsYWltZWQgdG9rZW5zLgpSZXR1cm5zIDAgZm9yIHVua25vd24gc2NoZWR1bGUgSURzLgAAAAANdmVzdGVkX2Ftb3VudAAAAAAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAA25vdwAAAAAGAAAAAQAAAAs=",
        "AAAAAgAAADBUaGUgdHlwZSBvZiB2ZXN0aW5nIGN1cnZlIGFwcGxpZWQgdG8gYSBzY2hlZHVsZS4AAAAAAAAAC1Zlc3RpbmdLaW5kAAAAAAQAAAAAAAAAfFRva2VucyB1bmxvY2sgbGluZWFybHkgZnJvbSBgc3RhcnRfdGltZWAgdG8gYHN0YXJ0X3RpbWUgKyBkdXJhdGlvbmAuClRoZSBgY2xpZmZfZHVyYXRpb25gIGZpZWxkIGlzIGlnbm9yZWQgZm9yIHRoaXMgdmFyaWFudC4AAAAGTGluZWFyAAAAAAAAAAAAW05vIHRva2VucyB1bmxvY2sgdW50aWwgYHN0YXJ0X3RpbWUgKyBjbGlmZl9kdXJhdGlvbmAsIHRoZW4gdGhlIGZ1bGwKYW1vdW50IHVubG9ja3MgYXQgb25jZS4AAAAABUNsaWZmAAAAAAAAAAAAAR9ObyB0b2tlbnMgdW5sb2NrIHVudGlsIGBzdGFydF90aW1lICsgY2xpZmZfZHVyYXRpb25gICh0aGUgY2xpZmYpLgpBZnRlciB0aGUgY2xpZmYsIHRva2VucyB1bmxvY2sgbGluZWFybHkgZnJvbSB0aGUgY2xpZmYgZGF0ZSB0bwpgc3RhcnRfdGltZSArIGR1cmF0aW9uYC4KClRoaXMgbW9kZWxzIHRoZSBtb3N0IGNvbW1vbiByZWFsLXdvcmxkIGVtcGxveWVlIHZlc3Rpbmcgc2NoZWR1bGU6CmEgMS15ZWFyIGNsaWZmIGZvbGxvd2VkIGJ5IGxpbmVhciB2ZXN0aW5nIG92ZXIgdGhlIHJlbWFpbmluZyB0ZXJtLgAAAAAPTGluZWFyV2l0aENsaWZmAAAAAAAAAADoVG9rZW5zIHVubG9jayBhdCBkaXNjcmV0ZSBtaWxlc3RvbmVzIGRlZmluZWQgYXMgKG9mZnNldF9zZWNvbmRzLApiYXNpc19wb2ludHMpIHBhaXJzIHN0b3JlZCBpbiBgVmVzdGluZ1NjaGVkdWxlOjptaWxlc3RvbmVzYC4KRWFjaCBtaWxlc3RvbmUgdW5sb2NrcyBgdG90YWxfYW1vdW50ICogYnBzIC8gMTBfMDAwYCB0b2tlbnMgb25jZQpgc3RhcnRfdGltZSArIG9mZnNldF9zZWNvbmRzYCBpcyByZWFjaGVkLgAAAAZHcmFkZWQAAA==",
        "AAAAAAAAAVdDYW5jZWwgdGhlIGN1cnJlbnRseSBwZW5kaW5nIHVwZ3JhZGUgYW5ub3VuY2VtZW50LgoKVGhlIHVwZ3JhZGUgbWF5IG9ubHkgYmUgY2FuY2VsbGVkIGJlZm9yZSB0aGUgdGltZWxvY2sgZXhwaXJlcy4gT25jZSB0aGUKdXBncmFkZSBiZWNvbWVzIGV4ZWN1dGFibGUsIGl0IGNhbm5vdCBiZSBjYW5jZWxsZWQgdGhyb3VnaCB0aGlzIGZ1bmN0aW9uLgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiTm8gcGVuZGluZyB1cGdyYWRlImAgd2hlbiBubyB1cGdyYWRlIGlzIHBlbmRpbmcuClBhbmljcyB3aXRoIGAiVXBncmFkZSBhbHJlYWR5IGV4ZWN1dGFibGUiYCBpZiB0aGUgdGltZWxvY2sgaGFzIGV4cGlyZWQuAAAAAA5jYW5jZWxfdXBncmFkZQAAAAAAAQAAAAAAAAAJYXV0aG9yaXR5AAAAAAAAEwAAAAA=",
        "AAAAAAAAAZhCYXRjaCB2aWV3OiByZXR1cm4gY2xhaW1hYmxlIGFtb3VudHMgZm9yIG11bHRpcGxlIHNjaGVkdWxlIElEcyBpbiBhCnNpbmdsZSBzaW11bGF0aW9uIHJvdW5kLXRyaXAuCgpSZXN1bHRzIGFyZSByZXR1cm5lZCBpbiB0aGUgc2FtZSBvcmRlciBhcyB0aGUgaW5wdXQgYGlkc2AgdmVjdG9yLgpVbmtub3duIElEcyByZXR1cm4gMCBpbnN0ZWFkIG9mIHBhbmlja2luZywgc28gdGhlIGNhbGxlciBjYW4gc2FmZWx5CnBhc3MgdGhlIGZ1bGwgSUQgcmFuZ2Ugd2l0aG91dCBrbm93aW5nIHdoaWNoIG9uZXMgZXhpc3QuCgpUaGlzIHJlcGxhY2VzIHRoZSBgUHJvbWlzZS5hbGwoY2xhaW1hYmxlKWAgcGF0dGVybiBpbiB0aGUgZnJvbnRlbmQKZGFzaGJvYXJkLCByZWR1Y2luZyBOIHNpbXVsYXRpb24gcm91bmQtdHJpcHMgdG8gMS4AAAAOY2xhaW1hYmxlX2J1bGsAAAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAABgAAAAEAAAPqAAAACw==",
        "AAAAAAAAAGpSZWFkIGEgY2xhaW0gZGVsZWdhdGlvbiBieSAoc2NoZWR1bGVfaWQsIGRlbGVnYXRpb25faWQpLgoKUmV0dXJucyBgTm9uZWAgaWYgdW5rbm93biByYXRoZXIgdGhhbiBwYW5pY2tpbmcuAAAAAAAOZ2V0X2RlbGVnYXRpb24AAAAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAADWRlbGVnYXRpb25faWQAAAAAAAAEAAAAAQAAA+gAAAfQAAAAD0NsYWltRGVsZWdhdGlvbgA=",
        "AAAAAAAAACpHZXQgcGVyZm9ybWFuY2UgbWlsZXN0b25lcyBmb3IgYSBzY2hlZHVsZS4AAAAAAA5nZXRfbWlsZXN0b25lcwAAAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAPoAAAD6gAAB9AAAAAUUGVyZm9ybWFuY2VNaWxlc3RvbmU=",
        "AAAAAAAAAcpQYXVzZSBhbiBhY3RpdmUgdmVzdGluZyBzY2hlZHVsZSAoZ3JhbnRvciBvbmx5KS4KCldoaWxlIHBhdXNlZCwgbm8gYWRkaXRpb25hbCB0b2tlbnMgdmVzdC4gVGhlIGJlbmVmaWNpYXJ5IGNhbiBzdGlsbCBjbGFpbQphbHJlYWR5LXZlc3RlZCB0b2tlbnMuIFRoZSBncmFudG9yIGNhbiByZXN1bWUgdGhlIHNjaGVkdWxlIGxhdGVyLgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiU2NoZWR1bGUgbm90IGZvdW5kImAgaWYgYHNjaGVkdWxlX2lkYCBkb2VzIG5vdCBleGlzdC4KUGFuaWNzIHdpdGggYCJOb3QgdGhlIGdyYW50b3IiYCBpZiBjYWxsZXIgaXMgbm90IHRoZSBncmFudG9yLgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIGFscmVhZHkgcGF1c2VkImAgaWYgYWxyZWFkeSBwYXVzZWQuClBhbmljcyB3aXRoIGAiQ2Fubm90IHBhdXNlIHJldm9rZWQgc2NoZWR1bGUiYCBpZiBzY2hlZHVsZSBpcyByZXZva2VkLgAAAAAADnBhdXNlX3NjaGVkdWxlAAAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAA==",
        "AAAAAAAAAC5Ib3cgbWFueSBzY2hlZHVsZXMgaGF2ZSBiZWVuIGNyZWF0ZWQgaW4gdG90YWwuAAAAAAAOc2NoZWR1bGVfY291bnQAAAAAAAAAAAABAAAABg==",
        "AAAAAQAAAEFBIHNpbmdsZSB0b2tlbiB3aXRoIGl0cyBhbW91bnQgaW4gYSBtdWx0aS10b2tlbiB2ZXN0aW5nIHNjaGVkdWxlLgAAAAAAAAAAAAAMVG9rZW5UcmFuY2hlAAAAAwAAADhBbW91bnQgb2YgdGhpcyB0b2tlbiBhbHJlYWR5IGNsYWltZWQgYnkgdGhlIGJlbmVmaWNpYXJ5LgAAAA5jbGFpbWVkX2Ftb3VudAAAAAAACwAAACZTdGVsbGFyIGFzc2V0IGNvbnRyYWN0IGZvciB0aGlzIHRva2VuLgAAAAAABXRva2VuAAAAAAAAEwAAADJUb3RhbCBhbW91bnQgb2YgdGhpcyB0b2tlbiBsb2NrZWQgaW4gdGhlIHNjaGVkdWxlLgAAAAAADHRvdGFsX2Ftb3VudAAAAAs=",
        "AAAAAAAAAvlDcmVhdGUgYSBuZXcgdmVzdGluZyBzY2hlZHVsZSBhbmQgbG9jayB0aGUgdG9rZW5zIGludG8gdGhlIGNvbnRyYWN0LgoKVGhlIGdyYW50b3IgbXVzdCBhcHByb3ZlIHRoZSBjb250cmFjdCB0byB0cmFuc2ZlciBgdG90YWxfYW1vdW50YCBvZgpgdG9rZW5gIGJlZm9yZSBjYWxsaW5nIHRoaXMgZnVuY3Rpb24uCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJBbW91bnQgbXVzdCBiZSBwb3NpdGl2ZSJgIGlmIGB0b3RhbF9hbW91bnRgIOKJpCAwLgpSZXR1cm5zIGBEdXJhdGlvblplcm9gIGlmIGBkdXJhdGlvbmAgPSAwLgpSZXR1cm5zIGBEdXJhdGlvblRvb1Nob3J0YCBpZiBgMCA8IGR1cmF0aW9uYCA8IDYwLgpQYW5pY3Mgd2l0aCBgIkNsaWZmIGNhbm5vdCBleGNlZWQgZHVyYXRpb24iYCBpZiBgY2xpZmZfZHVyYXRpb25gID4gYGR1cmF0aW9uYC4KUGFuaWNzIHdpdGggYCJMb2NrdXAgY2Fubm90IGJlIGxlc3MgdGhhbiBjbGlmZiJgIGlmIGBsb2NrdXBfZHVyYXRpb25gIDwgYGNsaWZmX2R1cmF0aW9uYC4KUGFuaWNzIHdpdGggYCJCZW5lZmljaWFyeSBtdXN0IGRpZmZlciBmcm9tIGdyYW50b3IiYCBpZiBgYmVuZWZpY2lhcnkgPT0gZ3JhbnRvcmAuClBhbmljcyB3aXRoIGAiU3RhcnQgdGltZSBjYW5ub3QgYmUgaW4gdGhlIHBhc3QiYCBpZiBgc3RhcnRfdGltZWAgPCBjdXJyZW50IGxlZGdlciB0aW1lLgpSZXR1cm5zIGBJbnZhbGlkVG9rZW5gIGlmIGB0b2tlbmAgaXMgbm90IGEgcmVjb2duaXNlZCBTdGVsbGFyIEFzc2V0IENvbnRyYWN0LgAAAAAAAA9jcmVhdGVfc2NoZWR1bGUAAAAACgAAAAAAAAAHZ3JhbnRvcgAAAAATAAAAAAAAAAtiZW5lZmljaWFyeQAAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAADHRvdGFsX2Ftb3VudAAAAAsAAAAAAAAACnN0YXJ0X3RpbWUAAAAAAAYAAAAAAAAACGR1cmF0aW9uAAAABgAAAAAAAAAOY2xpZmZfZHVyYXRpb24AAAAAAAYAAAAAAAAAD2xvY2t1cF9kdXJhdGlvbgAAAAAGAAAAAAAAAARraW5kAAAH0AAAAAtWZXN0aW5nS2luZAAAAAAAAAAACXJldm9jYWJsZQAAAAAAAAEAAAABAAAD6QAAAAYAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAAAa1FeGVjdXRlIHRoZSBwZW5kaW5nIGNvbnRyYWN0IFdBU00gbWlncmF0aW9uIGFmdGVyIHRoZSA0OC1ob3VyIHRpbWVsb2NrLgoKVGhlIHBlbmRpbmcgdXBncmFkZSBtdXN0IGhhdmUgYmVlbiBhbm5vdW5jZWQgb24tY2hhaW4gYnkKW2Bhbm5vdW5jZV91cGdyYWRlYF0gYXQgbGVhc3QgW2BVUEdSQURFX1RJTUVMT0NLX1NFQ09ORFNgXSBlYXJsaWVyLgpTb3JvYmFuIGFwcGxpZXMgdGhlIFdBU00gcmVwbGFjZW1lbnQgb25seSBhZnRlciB0aGlzIGludm9jYXRpb24KY29tcGxldGVzIHN1Y2Nlc3NmdWxseS4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIk5vIHBlbmRpbmcgdXBncmFkZSJgIHdoZW4gbm8gdXBncmFkZSBpcyBwZW5kaW5nLgpQYW5pY3Mgd2l0aCBgIlVwZ3JhZGUgdGltZWxvY2sgc3RpbGwgYWN0aXZlImAgYmVmb3JlIDQ4IGhvdXJzIGVsYXBzZS4AAAAAAAAPZXhlY3V0ZV91cGdyYWRlAAAAAAEAAAAAAAAACWF1dGhvcml0eQAAAAAAABMAAAAA",
        "AAAAAAAAAUhNYXJrIGFuIHVuYWN0aXZhdGVkIHByb3Bvc2FsIGFzIGV4cGlyZWQgYWZ0ZXIgdGhlIDcyLWhvdXIgd2luZG93LgoKQW55b25lIHdobyBhdXRob3JpemVzIHRoZSBjYWxsIG1heSBleHBpcmUgYW4gdW5hY3RpdmF0ZWQgcHJvcG9zYWwuClRoZSBwcm9wb3NhbCByZW1haW5zIHJlYWRhYmxlIHZpYSBbYGdldF9wcm9wb3NhbGBdIHdpdGgKW2BQcm9wb3NhbFN0YXRlOjpFeHBpcmVkYF0uIEFjdGl2YXRlZCBwcm9wb3NhbHMgYXJlIGtlcHQgc28gdGhleQpyZW1haW4gYXVkaXRhYmxlLiBDYWxsaW5nIHRoaXMgb24gYW4gYWxyZWFkeSBleHBpcmVkIHByb3Bvc2FsIGlzIGEKbm8tb3AuAAAAD2V4cGlyZV9wcm9wb3NhbAAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1WZXN0Rmxvd0Vycm9yAAAA",
        "AAAAAAAAAtxFeHRlbmQgdGhlIHZlc3RpbmcgZHVyYXRpb24gb2YgYW4gZXhpc3Rpbmcgc2NoZWR1bGUuCgpPbmx5IHRoZSAqKmdyYW50b3IqKiBvZiB0aGUgc2NoZWR1bGUgbWF5IGNhbGwgdGhpcyBlbnRyeSBwb2ludC4KVGhlIHNjaGVkdWxlIG11c3Qgbm90IGJlIHJldm9rZWQuCgpgYWRkaXRpb25hbF9zZWNvbmRzYCBpcyBhZGRlZCB0byB0aGUgY3VycmVudCBgZHVyYXRpb25gLCBwdXNoaW5nIHRoZQplbmQgZGF0ZSBmb3J3YXJkIHdpdGhvdXQgY2hhbmdpbmcgdGhlIGBzdGFydF90aW1lYCBvciBhbnkgYWxyZWFkeS12ZXN0ZWQKYW1vdW50cy4gVGhpcyBpcyBlcXVpdmFsZW50IHRvIHJlLWlzc3VpbmcgdGhlIGdyYW50IHdpdGggYSBsb25nZXIKaG9yaXpvbiDigJQgdXNlZnVsIHdoZW4gYW4gZW1wbG95ZWUgc3RheXMgYmV5b25kIHRoZSBvcmlnaW5hbCBncmFudCBwZXJpb2QuCgpFbWl0cyBhbiBgImV4dF9kdXIiYCBldmVudCB3aXRoIGAoc2NoZWR1bGVfaWQsIG9sZF9kdXJhdGlvbiwgbmV3X2R1cmF0aW9uLCB0aW1lc3RhbXApYC4KCiMgUGFuaWNzCgotIGAiU2NoZWR1bGUgbm90IGZvdW5kImAg4oCUIHVua25vd24gYHNjaGVkdWxlX2lkYC4KLSBgIlNjaGVkdWxlIGhhcyBiZWVuIHJldm9rZWQiYCDigJQgY2Fubm90IGV4dGVuZCBhIHJldm9rZWQgc2NoZWR1bGUuCi0gYCJBZGRpdGlvbmFsIHNlY29uZHMgbXVzdCBiZSBwb3NpdGl2ZSJgIOKAlCB6ZXJvIGV4dGVuc2lvbiBpcyByZWplY3RlZC4AAAAPZXh0ZW5kX2R1cmF0aW9uAAAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAEmFkZGl0aW9uYWxfc2Vjb25kcwAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAAASZWaWV3OiByZXR1cm4gdGhlIHRpbWVzdGFtcCBhdCB3aGljaCBhIHNjaGVkdWxlIHJlYWNoZXMgMTAwJSB2ZXN0ZWQuCgpDb3JyZWN0IGZvciBldmVyeSBgVmVzdGluZ0tpbmRgLCBpbmNsdWRpbmcgYEdyYWRlZGAsIHdoZXJlIHRoZQpuYWl2ZSBjbGllbnQtc2lkZSBgc3RhcnRfdGltZSArIGR1cmF0aW9uYCBjYWxjdWxhdGlvbiBicmVha3MKYmVjYXVzZSB0aGUgbGFzdCBtaWxlc3RvbmUncyBvZmZzZXQgZGV0ZXJtaW5lcyBmdWxsIHZlc3RpbmcuClJldHVybnMgYE5vbmVgIGZvciB1bmtub3duIHNjaGVkdWxlIElEcy4AAAAAAA9mdWxseV92ZXN0ZWRfYXQAAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAPoAAAABg==",
        "AAAAAAAABABBdG9taWNhbGx5IGNvbWJpbmUgbXVsdGlwbGUgYWN0aXZlIHZlc3Rpbmcgc2NoZWR1bGVzIGJlbG9uZ2luZyB0byB0aGUKc2FtZSBncmFudG9yLWJlbmVmaWNpYXJ5IHBhaXIgaW50byBhIHNpbmdsZSB1bmlmaWVkIHNjaGVkdWxlLgoKRXZlcnkgY3VycmVudGx5LWNsYWltYWJsZSBhbW91bnQgaXMgcGFpZCBvdXQgZnJvbSBlYWNoIHNvdXJjZSBiZWZvcmUKbWVyZ2luZyAocGF1c2VkIHNvdXJjZXMgYXJlIG5ldmVyIHNraXBwZWQg4oCUIGBjbGFpbWFibGVfYXRgIGFscmVhZHkKYWNjb3VudHMgZm9yIGZyb3plbiBlbGFwc2VkIHRpbWUgd2hpbGUgcGF1c2VkKS4gVGhlIG1lcmdlZCBzY2hlZHVsZSdzCmB0b3RhbF9hbW91bnRgIGlzIHRoZSBleGFjdCBzdW0gb2YgZWFjaCBzb3VyY2UncyByZW1haW5pbmcKKHVuY2xhaW1lZCkgYmFsYW5jZSwgc28gdGhlIHRva2VuIGludmFyaWFudApgY2xhaW1lZF90b3RhbCArIG1lcmdlZC50b3RhbF9hbW91bnQgPT0gc3VtKHNvdXJjZS50b3RhbF9hbW91bnQpYApob2xkcyBleGFjdGx5IHdpdGggbm8gcm91bmRpbmcgZHVzdC4KCmBzdGFydF90aW1lYCwgYGR1cmF0aW9uX3NlY29uZHNgLCBgY2xpZmZfc2Vjb25kc2AsIGFuZApgbG9ja3VwX2R1cmF0aW9uYCBhcmUgZWFjaCB0aGUgdG9rZW4td2VpZ2h0ZWQgYXZlcmFnZSBvZiB0aGUgc291cmNlcywKd2VpZ2h0ZWQgYnkgcmVtYWluaW5nIGJhbGFuY2UuIEJlY2F1c2UgZXZlcnkgc291cmNlIGluZGl2aWR1YWxseQpzYXRpc2ZpZXMgYGNsaWZmIDw9IGR1cmF0aW9uYCBhbmQgYGxvY2t1cCA+PSBjbGlmZmAsIGFuZCBhIHdlaWdodGVkCmF2ZXJhZ2Ugb2YgcG9pbnR3aXNlLW9yZGVyZWQgdmFsdWVzIHByZXNlcnZlcyB0aGF0IG9yZGVyIHVuZGVyIGZsb29yCmRpdmlzaW9uIGJ5IGEgY29tbW9uIGRlbm9taW5hdG9yLCB0aGUgbWVyZ2VkIHNjaGVkdWxlIGF1dG9tYXRpY2FsbHkKc2F0aXNmaWVzIHRoZSBzYW1lIGludmFyaWFudHMgd2l0aG91dCBleHRyYSBjbGFtcGluZy4KCiMgRXJyb3JzCgotIGBNZXJnZVRvb0Zld1NjAAAAD21lcmdlX3NjaGVkdWxlcwAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAAA2lkcwAAAAPqAAAABgAAAAEAAAPpAAAABgAAB9AAAAANVmVzdEZsb3dFcnJvcgAAAA==",
        "AAAAAAAAADBSZXR1cm4gdGhlIHBlbmRpbmcgdXBncmFkZSBhbm5vdW5jZW1lbnQsIGlmIGFueS4AAAAPcGVuZGluZ191cGdyYWRlAAAAAAAAAAABAAAD6AAAB9AAAAAOUGVuZGluZ1VwZ3JhZGUAAA==",
        "AAAAAAAAAUZSZXN1bWUgYSBwYXVzZWQgdmVzdGluZyBzY2hlZHVsZSAoZ3JhbnRvciBvbmx5KS4KCkFjY3VtdWxhdGVzIHRoZSBwYXVzZWQgZHVyYXRpb24gYW5kIHJlc3VtZXMgdmVzdGluZyBmcm9tIHRoZSBjdXJyZW50IHRpbWUuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJTY2hlZHVsZSBub3QgZm91bmQiYCBpZiBgc2NoZWR1bGVfaWRgIGRvZXMgbm90IGV4aXN0LgpQYW5pY3Mgd2l0aCBgIk5vdCB0aGUgZ3JhbnRvciJgIGlmIGNhbGxlciBpcyBub3QgdGhlIGdyYW50b3IuClBhbmljcyB3aXRoIGAiU2NoZWR1bGUgbm90IHBhdXNlZCJgIGlmIG5vdCBjdXJyZW50bHkgcGF1c2VkLgAAAAAAD3Jlc3VtZV9zY2hlZHVsZQAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAA==",
        "AAAAAgAAAH9TdG9yYWdlIGtleXMgZm9yIGNsYWltIGRlbGVnYXRpb25zLCBrZXllZCBzZXBhcmF0ZWx5IGZyb20gW2BEYXRhS2V5YF0gc28KZGVsZWdhdGlvbiByZWNvcmRzIGRvbid0IGNyb3dkIHRoZSBzY2hlZHVsZSBrZXkgc3BhY2UuAAAAAAAAAAANRGVsZWdhdGlvbktleQAAAAAAAAMAAAABAAAAMkEgc2luZ2xlIGRlbGVnYXRpb246IChzY2hlZHVsZV9pZCwgZGVsZWdhdGlvbl9pZCkuAAAAAAAKRGVsZWdhdGlvbgAAAAAAAgAAAAYAAAAEAAAAAQAAAEVNb25vdG9uaWMgZGVsZWdhdGlvbi1pZCBjb3VudGVyIGZvciBhIHNjaGVkdWxlLCBrZXllZCBieSBzY2hlZHVsZV9pZC4AAAAAAAAPRGVsZWdhdGlvbkNvdW50AAAAAAEAAAAGAAAAAQAAAQ5Db3VudCBvZiBjdXJyZW50bHkgYWN0aXZlIChub24tcmV2b2tlZCkgZGVsZWdhdGlvbnMgZm9yIGEgc2NoZWR1bGUsCmtleWVkIGJ5IHNjaGVkdWxlX2lkLiBNYWludGFpbmVkIGluY3JlbWVudGFsbHkgYnkgYGNyZWF0ZV9kZWxlZ2F0aW9uYAphbmQgYHJldm9rZV9kZWxlZ2F0aW9uYCBzbyB0aGUgY29uY3VycmVuY3kgY2FwIGNhbiBiZSBlbmZvcmNlZCBpbgpPKDEpIGluc3RlYWQgb2Ygc2Nhbm5pbmcgZXZlcnkgaGlzdG9yaWNhbCBkZWxlZ2F0aW9uIGV2ZXIgY3JlYXRlZC4AAAAAABVBY3RpdmVEZWxlZ2F0aW9uQ291bnQAAAAAAAABAAAABg==",
        "AAAAAgAAAClMaWZlY3ljbGUgb2YgYW4gZXNjcm93IHNjaGVkdWxlIHByb3Bvc2FsLgAAAAAAAAAAAAANUHJvcG9zYWxTdGF0ZQAAAAAAAAQAAAAAAAAANFBhcmFtZXRlcnMgbG9ja2VkOyB0b2tlbnMgaGF2ZSBub3QgYmVlbiB0cmFuc2ZlcnJlZC4AAAAHUGVuZGluZwAAAAAAAAAAREJlbmVmaWNpYXJ5IGhhcyBhY2tub3dsZWRnZWQgb24tY2hhaW4uIEFjdGl2YXRpb24gaXMgc3RpbGwgb3B0aW9uYWwuAAAADEFja25vd2xlZGdlZAAAAAEAAABER3JhbnRvciBmdW5kZWQgdGhlIHByb3Bvc2FsLiBJbm5lciB2YWx1ZSBpcyB0aGUgY3JlYXRlZCBzY2hlZHVsZSBpZC4AAAAJQWN0aXZhdGVkAAAAAAAAAQAAAAYAAAAAAAAASlBhc3QgdGhlIDcyLWhvdXIgd2luZG93LiBXcml0dGVuIGJ5IFtgVmVzdEZsb3dDb250cmFjdDo6ZXhwaXJlX3Byb3Bvc2FsYF0uAAAAAAAHRXhwaXJlZAA=",
        "AAAABAAAAAAAAAAAAAAADVZlc3RGbG93RXJyb3IAAAAAAAAaAAAAAAAAAAhOb3RGb3VuZAAAAAEAAAAAAAAADE5vdFJldm9jYWJsZQAAAAIAAAAAAAAADkFscmVhZHlSZXZva2VkAAAAAAADAAAAAAAAAA5Ob3RoaW5nVG9DbGFpbQAAAAAABAAAAAAAAAAKQW1vdW50WmVybwAAAAAABQAAAAAAAAAMRHVyYXRpb25aZXJvAAAABgAAAAAAAAAUQ2xpZmZFeGNlZWRzRHVyYXRpb24AAAAHAAAAAAAAAA9TY2hlZHVsZVJldm9rZWQAAAAACAAAAAAAAAATTG9ja3VwTGVzc1RoYW5DbGlmZgAAAAAJAAAAAAAAAAxJbnZhbGlkVG9rZW4AAAAKAAAAAAAAABBQcm9wb3NhbE5vdEZvdW5kAAAACwAAAAAAAAASUHJvcG9zYWxOb3RFeHBpcmVkAAAAAAAMAAAAAAAAAA9Qcm9wb3NhbEV4cGlyZWQAAAAADQAAAAAAAAAYUHJvcG9zYWxBbHJlYWR5QWN0aXZhdGVkAAAADgAAAAAAAAAQRHVyYXRpb25Ub29TaG9ydAAAAA8AAAAAAAAAEkRlbGVnYXRpb25Ob3RGb3VuZAAAAAAAEAAAAAAAAAARRGVsZWdhdGlvblJldm9rZWQAAAAAAAARAAAAAAAAABFEZWxlZ2F0aW9uRXhwaXJlZAAAAAAAABIAAAAAAAAAE0RlbGVnYXRpb25FeGhhdXN0ZWQAAAAAEwAAAAAAAAALTm90RGVsZWdhdGUAAAAAFAAAAAAAAAASVG9vTWFueURlbGVnYXRpb25zAAAAAAAVAAAAAAAAABFNZXJnZVR5cGVNaXNtYXRjaAAAAAAAABYAAAAAAAAAFE1lcmdlVG9vRmV3U2NoZWR1bGVzAAAAFwAAAAAAAAAVTWVyZ2VUb29NYW55U2NoZWR1bGVzAAAAAAAAGAAAAAAAAAASTWVyZ2VUb2tlbk1pc21hdGNoAAAAAAAZAAAAAAAAABJNZXJnZU93bmVyTWlzbWF0Y2gAAAAAABo=",
        "AAAAAAAAAeBBbm5vdW5jZSBhbiB1cGNvbWluZyBjb250cmFjdCBXQVNNIG1pZ3JhdGlvbiBvbi1jaGFpbi4KClRoZSBXQVNNIGlkZW50aWZpZWQgYnkgYHdhc21faGFzaGAgbXVzdCBhbHJlYWR5IGJlIHVwbG9hZGVkLiBUaGlzCmZ1bmN0aW9uIHZlcmlmaWVzIHRoZSBXQVNNIGV4aXN0cyBiZWZvcmUgcmVjb3JkaW5nIHRoZSBhbm5vdW5jZW1lbnQsCnByZXZlbnRpbmcgYW5ub3VuY2VtZW50IG9mIG5vbi1leGlzdGVudCBXQVNNIGhhc2hlcy4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlVwZ3JhZGUgYXV0aG9yaXR5IG5vdCBpbml0aWFsaXplZCJgIGlmIHVuc2V0LgpQYW5pY3Mgd2l0aCBgIlVuYXV0aG9yaXplZCB1cGdyYWRlIGF1dGhvcml0eSJgIGlmIGBhdXRob3JpdHlgIGlzIG5vdCB0aGUgY29uZmlndXJlZCBhdXRob3JpdHkuClBhbmljcyB3aXRoIGAiV0FTTSBub3QgZm91bmQiYCBpZiB0aGUgV0FTTSBoYXNoIGhhcyBub3QgYmVlbiB1cGxvYWRlZC4AAAAQYW5ub3VuY2VfdXBncmFkZQAAAAIAAAAAAAAACWF1dGhvcml0eQAAAAAAABMAAAAAAAAACXdhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAB9AAAAAOUGVuZGluZ1VwZ3JhZGUAAA==",
        "AAAAAAAAAThBdHRlc3QgYSBwZXJmb3JtYW5jZSBtaWxlc3RvbmUgKG9yYWNsZSBvbmx5KS4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIk9yYWNsZSBub3QgaW5pdGlhbGl6ZWQiYCBpZiBvcmFjbGUgaXMgbm90IGNvbmZpZ3VyZWQuClBhbmljcyB3aXRoIGAiTm90IHRoZSBvcmFjbGUiYCBpZiBjYWxsZXIgaXMgbm90IHRoZSBvcmFjbGUuClBhbmljcyB3aXRoIGAiTWlsZXN0b25lIGluZGV4IG91dCBvZiBib3VuZHMiYCBpZiBpbnZhbGlkIGluZGV4LgpQYW5pY3Mgd2l0aCBgIk1pbGVzdG9uZSBhbHJlYWR5IGF0dGVzdGVkImAgaWYgYWxyZWFkeSBhdHRlc3RlZC4AAAAQYXR0ZXN0X21pbGVzdG9uZQAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAD21pbGVzdG9uZV9pbmRleAAAAAAEAAAAAA==",
        "AAAAAAAAAHdQcmV2aWV3IGhvdyBtYW55IHRva2VucyBhcmUgY2xhaW1hYmxlIGF0IGEgc3BlY2lmaWMgdGltZXN0YW1wLgoKUmV0dXJucyAwIGlmIGBzY2hlZHVsZV9pZGAgaXMgdW5rbm93biAoZG9lcyBub3QgcGFuaWMpLgAAAAAQY2xhaW1hYmxlX2Ftb3VudAAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAA25vdwAAAAAGAAAAAQAAAAs=",
        "AAAAAAAAARJEZXN0cm95IGEgc2NoZWR1bGUgYW5kIHJlY2xhaW0gc3RvcmFnZSBmb3IgZnVsbHktY2xhaW1lZCwgaXJyZXZvY2FibGUgc2NoZWR1bGVzLgoKT25seSBjYWxsYWJsZSBieSB0aGUgYmVuZWZpY2lhcnkgb3IgZ3JhbnRvci4KClBhbmljcyBpZiBgY2xhaW1lZF9hbW91bnQgPCB0b3RhbF9hbW91bnRgIG9yIGlmIHRoZSBzY2hlZHVsZSBpcyByZXZvY2FibGUuClJlbW92ZXMgc2NoZWR1bGUgZW50cnkgYW5kIGluZGV4IGVudHJpZXMgYW5kIGVtaXRzIGEgYGRlc3Ryb3llZGAgZXZlbnQuAAAAAAAQZGVzdHJveV9zY2hlZHVsZQAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAA=",
        "AAAAAAAAAcFMb2NrIHNjaGVkdWxlIHBhcmFtZXRlcnMgd2l0aG91dCB0cmFuc2ZlcnJpbmcgdG9rZW5zLgoKVGhlIGdyYW50b3IgbGF0ZXIgY2FsbHMgW2BmdW5kX2FuZF9hY3RpdmF0ZWBdIHdpdGhpbgpbYFBST1BPU0FMX1dJTkRPV19MRURHRVJTYF0gdG8gbW92ZSBmdW5kcyBhbmQgc3RhcnQgdGhlIHNjaGVkdWxlLgpBY2tub3dsZWRnbWVudCBieSB0aGUgYmVuZWZpY2lhcnkgaXMgb3B0aW9uYWwgYW5kIGF1ZGl0YWJsZS4KCiMgRXJyb3JzCgpSZXR1cm5zIGBBbW91bnRaZXJvYCBpZiBgdG90YWxfYW1vdW50YCDiiaQgMC4KUmV0dXJucyBgRHVyYXRpb25aZXJvYCBpZiBgZHVyYXRpb25gID0gMC4KUmV0dXJucyBgRHVyYXRpb25Ub29TaG9ydGAgaWYgYDAgPCBkdXJhdGlvbmAgPCA2MC4KUmV0dXJucyBgQ2xpZmZFeGNlZWRzRHVyYXRpb25gIGlmIGBjbGlmZl9kdXJhdGlvbmAgPiBgZHVyYXRpb25gLgAAAAAAABBwcm9wb3NlX3NjaGVkdWxlAAAACgAAAAAAAAAHZ3JhbnRvcgAAAAATAAAAAAAAAAtiZW5lZmljaWFyeQAAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAADHRvdGFsX2Ftb3VudAAAAAsAAAAAAAAACnN0YXJ0X3RpbWUAAAAAAAYAAAAAAAAACGR1cmF0aW9uAAAABgAAAAAAAAAOY2xpZmZfZHVyYXRpb24AAAAAAAYAAAAAAAAAD2xvY2t1cF9kdXJhdGlvbgAAAAAGAAAAAAAAAARraW5kAAAH0AAAAAtWZXN0aW5nS2luZAAAAAAAAAAACXJldm9jYWJsZQAAAAAAAAEAAAABAAAD6QAAAAYAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAAAa9UcmFuc2ZlciBncmFudG9yIHJpZ2h0cyB0byBhIG5ldyBhZGRyZXNzIChjdXJyZW50IGdyYW50b3Igb25seSkuCgpNb3ZlcyByZXZvY2F0aW9uIGFuZCBwYXVzZSByaWdodHMgdG8gYG5ld19ncmFudG9yYC4gVXBkYXRlcyB0aGUgZ3JhbnRvcgpzY2hlZHVsZSBpbmRleCBmb3IgYm90aCB0aGUgb2xkIGFuZCBuZXcgZ3JhbnRvci4gRW1pdHMgYSBgImdybnRfY2huZyJgCmV2ZW50IHdpdGggYChvbGRfZ3JhbnRvciwgbmV3X2dyYW50b3IsIHRpbWVzdGFtcClgLgoKUmV0dXJucyBgT2soKCkpYCBpbW1lZGlhdGVseSB3aGVuIGBuZXdfZ3JhbnRvcmAgaXMgdGhlIHNhbWUgYXMgdGhlCmN1cnJlbnQgZ3JhbnRvciAobm8tb3ApLgoKIyBFcnJvcnMKClJldHVybnMgYFZlc3RGbG93RXJyb3I6Ok5vdEZvdW5kYCBpZiBgc2NoZWR1bGVfaWRgIGRvZXMgbm90IGV4aXN0LgAAAAAQdHJhbnNmZXJfZ3JhbnRvcgAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAC25ld19ncmFudG9yAAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1WZXN0Rmxvd0Vycm9yAAAA",
        "AAAAAQAAAE5BIGNvbnRyYWN0IFdBU00gdXBncmFkZSB0aGF0IGhhcyBiZWVuIGFubm91bmNlZCBvbi1jaGFpbiBidXQgbm90IHlldCBleGVjdXRlZC4AAAAAAAAAAAAOUGVuZGluZ1VwZ3JhZGUAAAAAAAMAAAAwTGVkZ2VyIHRpbWVzdGFtcCB3aGVuIHRoZSB1cGdyYWRlIHdhcyBhbm5vdW5jZWQuAAAADGFubm91bmNlZF9hdAAAAAYAAAA7RWFybGllc3QgbGVkZ2VyIHRpbWVzdGFtcCB3aGVuIHRoZSB1cGdyYWRlIG1heSBiZSBleGVjdXRlZC4AAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAQ0hhc2ggb2YgdGhlIGFscmVhZHktdXBsb2FkZWQgV0FTTSBibG9iIHRvIG1pZ3JhdGUgdGhpcyBjb250cmFjdCB0by4AAAAACXdhc21faGFzaAAAAAAAA+4AAAAg",
        "AAAAAAAABABFeHRlbmQgdGhpcyBjb250cmFjdCBpbnN0YW5jZSdzIHN0b3JhZ2UgVFRMLiBDYWxsYWJsZSBieSBhbnlvbmUKKGJlbmVmaWNpYXJ5LCBncmFudG9yLCBvciBhIHRoaXJkLXBhcnR5IGtlZXBlcikgLS0gdGhlcmUgaXMgbm90aGluZwpzZW5zaXRpdmUgYWJvdXQga2VlcGluZyB0aGUgY29udHJhY3QgYWxpdmUsIGFuZCByZXF1aXJpbmcgYXV0aCBoZXJlCndvdWxkIGp1c3QgbWFrZSBpdCBoYXJkZXIgZm9yIGtlZXBlcnMgdG8gcnVuIHRoaXMgcGVybWlzc2lvbmxlc3NseS4KCmBzY2hlZHVsZV9pZGAgaXMgdmFsaWRhdGVkIHRvIGV4aXN0IHNvIGEgY2FsbGVyIGdldHMgYSBjbGVhcgpbYFZlc3RGbG93RXJyb3I6Ok5vdEZvdW5kYF0gaW5zdGVhZCBvZiBzaWxlbnRseSBidW1waW5nIFRUTCBmb3IgYQpzY2hlZHVsZSB0aGF0IHdhcyBuZXZlciBjcmVhdGVkIChlLmcuIGEgdHlwbydkIElEKS4KCiMgTm90ZSBvbiBzdG9yYWdlIHRpZXIKClNjaGVkdWxlcyBjdXJyZW50bHkgbGl2ZSBpbiAqKmluc3RhbmNlKiogc3RvcmFnZSAoc2VlIFtgRGF0YUtleTo6U2NoZWR1bGVgXQphbmQgZXZlcnkgb3RoZXIgcmVhZC93cml0ZSBpbiB0aGlzIGNvbnRyYWN0KSwgbm90IHBlcnNpc3RlbnQgc3RvcmFnZSAtLQp0aGVyZSBpcyBubyBpbmRlcGVuZGVudCBwZXItc2NoZWR1bGUgcGVyc2lzdGVudCBlbnRyeSB0byBidW1wIHlldC4gSW5zdGFuY2UKc3RvcmFnZSBoYXMgYSBzaW5nbGUgVFRMIGZvciB0aGUgd2hvbGUgY29udHJhY3QgaW5zdGFuY2UsIHNvIHRoaXMgZXh0ZW5kcwp0aGF0IHNoYXJlZCBUVEwgcmF0aGVyIHRoYW4gYSBwZXItc2NoZWR1bGUga2V5LiBJZiBzY2hlZHVsZXMgYXJlIGV2ZXIKbWlncmF0ZWQgdG8gcGVyc2lzdGVudCBzdG9yYWdlICh0cmFja2VkIHNlcGFyYXRlbHkpLCB0aGlzIHNob3VsZCBiZQp1cGRhdGVkIHRvIGNhbGwgYGVudi5zdG9yYWdlKCkucGVyc2lzdGVudCgpLmV4dGVuZF90dGwoJkRhdGFLZXk6OlNjaGVkdWxlKHNjaGVkdWxlX2lkKSwgLi4pYAppbnN0ZWFkLgoKIyBFcnJvcnMKClJlAAAAEWJ1bXBfc2NoZWR1bGVfdHRsAAAAAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAABABDbGFpbSB2ZXN0ZWQgdG9rZW5zIG9uIGJlaGFsZiBvZiBhIGJlbmVmaWNpYXJ5IHRocm91Z2ggYSBkZWxlZ2F0aW9uLgoKVG9rZW5zIGFyZSB0cmFuc2ZlcnJlZCBkaXJlY3RseSB0byBgZGVsZWdhdGVgLiBUaGUgY2xhaW0gaXMgY2FwcGVkIGJ5CndoYXRldmVyIGlzIGN1cnJlbnRseSBjbGFpbWFibGUgb24gdGhlIHNjaGVkdWxlIGFuZCwgaWYgc2V0LCBieSB0aGUKZGVsZWdhdGlvbidzIHJlbWFpbmluZyBgbWF4X2Ftb3VudCAtIGNsYWltZWRfc29fZmFyYCBidWRnZXQuIFRoZSB0b2tlbgp0cmFuc2ZlciBhbmQgYm90aCBjb3VudGVyIHVwZGF0ZXMgKGBkZWxlZ2F0aW9uLmNsYWltZWRfc29fZmFyYCBhbmQKYHNjaGVkdWxlLmNsYWltZWRfYW1vdW50YCkgaGFwcGVuIHdpdGhpbiB0aGlzIHNpbmdsZSBpbnZvY2F0aW9uLCBzbyBhCmZhaWxlZCB0cmFuc2ZlciByZXZlcnRzIGV2ZXJ5IHN0YXRlIGNoYW5nZSBoZXJlIOKAlCB0aGVyZSBpcyBubyB3aW5kb3cKd2hlcmUgdGhlIGNvdW50ZXJzIGFkdmFuY2Ugd2l0aG91dCB0aGUgdG9rZW5zIGFjdHVhbGx5IG1vdmluZy4KClNvcm9iYW4gYXV0aCBmb3IgdGhpcyBjYWxsIGlzIHNjb3BlZCB0byBgKHNjaGVkdWxlX2lkLCBkZWxlZ2F0aW9uX2lkKWAKdmlhIGByZXF1aXJlX2F1dGhfZm9yX2FyZ3NgLCBub3QgYSBibGFua2V0IGBkZWxlZ2F0ZS5yZXF1aXJlX2F1dGgoKWAuCkEgc2lnbmF0dXJlIGF1dGhvcml6aW5nIGEgY2xhaW0gZm9yIG9uZSBkZWxlZ2F0aW9uIGNhbm5vdCBiZSByZXBsYXllZAphZ2FpbnN0IGEgZGlmZmVyZW50IGRlbGVnYXRpb24gb3Igc2NoZWR1bGUsIGV2ZW4gb25lIHdpdGggdGhlIHNhbWUKZGVsZWdhdGUgYWRkcmVzcy4KCiMgRXJyb3JzCgpSZXR1cm5zIGBOb3RGb3VuZGAgaWYgYHNjaGVkdWxlX2lkYCBkb2VzIG5vdCBleGlzdC4KUmV0dXJucyBgRGVsZWdhdGlvbk5vdEZvdW5kYCBpZiBgZGVsZWdhdGlvbl9pZGAgZG9lcyBub3QgZXhpc3QgZm9yIHRoaXMgc2NoZWR1bGUuClJldHVybnMgYE5vdERlbGVnYXRlYCBpZiBgZGVsZWdhAAAAEWNsYWltX2FzX2RlbGVnYXRlAAAAAAAAAwAAAAAAAAAIZGVsZWdhdGUAAAATAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAAAAAA1kZWxlZ2F0aW9uX2lkAAAAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAAAU9DbGFpbSBhbGwgdmVzdGVkIHRva2VucyBmcm9tIGEgbXVsdGktdG9rZW4gc2NoZWR1bGUuCgpUcmFuc2ZlcnMgYWxsIGF2YWlsYWJsZSBjbGFpbWFibGUgYW1vdW50cyBhY3Jvc3MgYWxsIHRva2VucyBpbiB0aGUgc2NoZWR1bGUKdG8gdGhlIGJlbmVmaWNpYXJ5LCBzdWJqZWN0IHRvIGNsaWZmIGFuZCBsb2NrdXAgY29uc3RyYWludHMuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJTY2hlZHVsZSBub3QgZm91bmQiYCBpZiB0aGUgc2NoZWR1bGUgSUQgZG9lc24ndCBleGlzdC4KUGFuaWNzIHdpdGggYCJOb3RoaW5nIHRvIGNsYWltIHlldCJgIGlmIG5vIHRva2VucyBhcmUgY2xhaW1hYmxlLgAAAAARY2xhaW1fbXVsdGlfdG9rZW4AAAAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANVmVzdEZsb3dFcnJvcgAAAA==",
        "AAAAAAAAA2pEZWxlZ2F0ZSBjbGFpbSByaWdodHMgb24gYSBzY2hlZHVsZSB0byBhIHRoaXJkLXBhcnR5IGFkZHJlc3MuCgpUaGUgZGVsZWdhdGUgbWF5IGxhdGVyIGNhbGwgW2BjbGFpbV9hc19kZWxlZ2F0ZWBdIHRvIHB1bGwgdmVzdGVkCnRva2VucyBkaXJlY3RseSB0byB0aGVpciBvd24gYWRkcmVzcywgYm91bmRlZCBieSBgbWF4X2Ftb3VudGAgYW5kL29yCmBleHBpcmVzX2F0X2xlZGdlcmAuIEEgc2NoZWR1bGUgbWF5IGhhdmUgYXQgbW9zdApbYE1BWF9ERUxFR0FUSU9OU19QRVJfU0NIRURVTEVgXSBjb25jdXJyZW50bHkgYWN0aXZlIChub24tcmV2b2tlZCkKZGVsZWdhdGlvbnM7IHJldm9raW5nIG9uZSBmcmVlcyBhIHNsb3QuCgojIEVycm9ycwoKUmV0dXJucyBgTm90Rm91bmRgIGlmIGBzY2hlZHVsZV9pZGAgZG9lcyBub3QgZXhpc3QuClJldHVybnMgYFRvb01hbnlEZWxlZ2F0aW9uc2AgaWYgNSBhY3RpdmUgZGVsZWdhdGlvbnMgYWxyZWFkeSBleGlzdCBmb3IgdGhpcyBzY2hlZHVsZS4KUGFuaWNzIHdpdGggYCJOb3QgdGhlIGJlbmVmaWNpYXJ5ImAgaWYgYGJlbmVmaWNpYXJ5YCBpcyBub3QgdGhlIHNjaGVkdWxlJ3MgYmVuZWZpY2lhcnkuClBhbmljcyB3aXRoIGAiRGVsZWdhdGUgbXVzdCBkaWZmZXIgZnJvbSBiZW5lZmljaWFyeSJgIGlmIGBkZWxlZ2F0ZSA9PSBiZW5lZmljaWFyeWAuClBhbmljcyB3aXRoIGAiTWF4IGFtb3VudCBtdXN0IGJlIHBvc2l0aXZlImAgaWYgYG1heF9hbW91bnRgIGlzIGBTb21lKG4pYCB3aXRoIGBuIDw9IDBgLgpQYW5pY3Mgd2l0aCBgIkV4cGlyeSBtdXN0IGJlIGluIHRoZSBmdXR1cmUiYCBpZiBgZXhwaXJlc19hdF9sZWRnZXJgIGlzIGF0IG9yIGJlZm9yZSB0aGUgY3VycmVudCBsZWRnZXIgc2VxdWVuY2UuAAAAAAARY3JlYXRlX2RlbGVnYXRpb24AAAAAAAAFAAAAAAAAAAtiZW5lZmljaWFyeQAAAAATAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAAAAAAhkZWxlZ2F0ZQAAABMAAAAAAAAACm1heF9hbW91bnQAAAAAA+gAAAALAAAAAAAAABFleHBpcmVzX2F0X2xlZGdlcgAAAAAAA+gAAAAEAAAAAQAAA+kAAAAEAAAH0AAAAA1WZXN0Rmxvd0Vycm9yAAAA",
        "AAAAAAAAAVVUcmFuc2ZlciB0b2tlbnMgYW5kIGNyZWF0ZSB0aGUgc2NoZWR1bGUgZnJvbSBhIHBlbmRpbmcgcHJvcG9zYWwuCgpBY2tub3dsZWRnbWVudCBpcyBvcHRpb25hbC4gRmFpbHMgaWYgdGhlIDcyLWhvdXIgd2luZG93IGhhcyBlbGFwc2VkCm9yIGlmIHRoZSBwcm9wb3NhbCB3YXMgYWxyZWFkeSBhY3RpdmF0ZWQuIGBzdGFydF90aW1lYCBpcyB0YWtlbiBmcm9tCnRoZSBmcm96ZW4gcHJvcG9zYWwgYW5kIGlzIG5vdCByZS1jaGVja2VkIGFnYWluc3QgdGhlIGN1cnJlbnQgbGVkZ2VyCnRpbWUsIHNvIGEgcHJvcG9zYWwgY3JlYXRlZCB3aXRoIGBzdGFydF90aW1lID0gbm93YCByZW1haW5zIGZ1bmRhYmxlLgAAAAAAABFmdW5kX2FuZF9hY3RpdmF0ZQAAAAAAAAIAAAAAAAAAB2dyYW50b3IAAAAAEwAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAEAAAPpAAAABgAAB9AAAAANVmVzdEZsb3dFcnJvcgAAAA==",
        "AAAAAAAAAC9HZXQgYWxsIG11bHRpLXRva2VuIHNjaGVkdWxlIElEcyBmb3IgYSBncmFudG9yLgAAAAARZ2V0X2dyYW50b3JfbXVsdGkAAAAAAAABAAAAAAAAAAdncmFudG9yAAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAONWaWV3OiByZXR1cm4gdGhlIG51bWJlciBvZiBpcnJldm9jYWJsZSBzY2hlZHVsZXMuCgpDb3VudHMgc2NoZWR1bGVzIHdoZXJlIGByZXZvY2FibGVgIGlzIGZhbHNlLiBVc2VmdWwgZm9yIHByb3RvY29sLWxldmVsCnRydXN0IG1ldHJpY3Mg4oCUIGJlbmVmaWNpYXJpZXMgYW5kIGludmVzdG9ycyBjYXJlIGhvdyBtYW55IHNjaGVkdWxlcwpjYW5ub3QgYmUgY2FuY2VsbGVkIGJ5IHRoZSBncmFudG9yLgAAAAARaXJyZXZvY2FibGVfY291bnQAAAAAAAAAAAAAAQAAAAY=",
        "AAAAAAAAAoVSZXZva2UgYSBjbGFpbSBkZWxlZ2F0aW9uLCBpbW1lZGlhdGVseSBhbmQgcGVybWFuZW50bHkgZGlzYWJsaW5nIGl0LgoKSWRlbXBvdGVudDogcmV2b2tpbmcgYW4gYWxyZWFkeS1yZXZva2VkIGRlbGVnYXRpb24gaXMgYSBuby1vcCBzdWNjZXNzLgpBbnkgYGNsYWltX2FzX2RlbGVnYXRlYCBjYWxsIHRoYXQgaGFzIG5vdCB5ZXQgc3RhcnRlZCBleGVjdXRpbmcgaW4gYQpsYXRlciB0cmFuc2FjdGlvbiB3aWxsIHNlZSBgcmV2b2tlZCA9PSB0cnVlYCBhbmQgYmUgcmVqZWN0ZWQg4oCUIFNvcm9iYW4KYXBwbGllcyB0cmFuc2FjdGlvbnMgd2l0aGluIGEgbGVkZ2VyIHNlcXVlbnRpYWxseSwgc28gdGhlcmUgaXMgbm8Kd2luZG93IHdoZXJlIGEgcmV2b2NhdGlvbiBhbmQgYSBjbGFpbSBjYW4gYm90aCBwYXJ0aWFsbHkgYXBwbHkuCgojIEVycm9ycwoKUmV0dXJucyBgTm90Rm91bmRgIGlmIGBzY2hlZHVsZV9pZGAgZG9lcyBub3QgZXhpc3QuClJldHVybnMgYERlbGVnYXRpb25Ob3RGb3VuZGAgaWYgYGRlbGVnYXRpb25faWRgIGRvZXMgbm90IGV4aXN0IGZvciB0aGlzIHNjaGVkdWxlLgpQYW5pY3Mgd2l0aCBgIk5vdCB0aGUgYmVuZWZpY2lhcnkiYCBpZiBgYmVuZWZpY2lhcnlgIGlzIG5vdCB0aGUgc2NoZWR1bGUncyBiZW5lZmljaWFyeS4AAAAAAAARcmV2b2tlX2RlbGVnYXRpb24AAAAAAAADAAAAAAAAAAtiZW5lZmljaWFyeQAAAAATAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAAAAAA1kZWxlZ2F0aW9uX2lkAAAAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADVZlc3RGbG93RXJyb3IAAAA=",
        "AAAAAAAAAG9SZXR1cm4gdGhlIGNvbmZpZ3VyZWQgdXBncmFkZSBhdXRob3JpdHkuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJVcGdyYWRlIGF1dGhvcml0eSBub3QgaW5pdGlhbGl6ZWQiYCBpZiB1bnNldC4AAAAAEXVwZ3JhZGVfYXV0aG9yaXR5AAAAAAAAAAAAAAEAAAAT",
        "AAAAAQAAAIdBIGRlbGVnYXRpb24gb2YgY2xhaW0gcmlnaHRzIGZyb20gYSBzY2hlZHVsZSdzIGJlbmVmaWNpYXJ5IHRvIGEKdGhpcmQtcGFydHkgYWRkcmVzcywgb3B0aW9uYWxseSBib3VuZGVkIGJ5IGFtb3VudCBhbmQvb3IgbGVkZ2VyIGV4cGlyeS4AAAAAAAAAAA9DbGFpbURlbGVnYXRpb24AAAAABQAAAC9Ub2tlbnMgYWxyZWFkeSBjbGFpbWVkIHRocm91Z2ggdGhpcyBkZWxlZ2F0aW9uLgAAAAAOY2xhaW1lZF9zb19mYXIAAAAAAAsAAAA4QWRkcmVzcyBhdXRob3JpemVkIHRvIGNsYWltIG9uIHRoZSBiZW5lZmljaWFyeSdzIGJlaGFsZi4AAAAIZGVsZWdhdGUAAAATAAAAX0xlZGdlciBzZXF1ZW5jZSBhZnRlciB3aGljaCB0aGlzIGRlbGVnYXRpb24gY2FuIG5vIGxvbmdlciBiZSB1c2VkIHRvCmNsYWltLiBgTm9uZWAgPSBubyBleHBpcnkuAAAAABFleHBpcmVzX2F0X2xlZGdlcgAAAAAAA+gAAAAEAAAARk1heGltdW0gdG90YWwgdG9rZW5zIHRoaXMgZGVsZWdhdGUgbWF5IGV2ZXIgY2xhaW0uIGBOb25lYCA9IHVubGltaXRlZC4AAAAAAAptYXhfYW1vdW50AAAAAAPoAAAACwAAADRXaGV0aGVyIHRoZSBiZW5lZmljaWFyeSBoYXMgcmV2b2tlZCB0aGlzIGRlbGVnYXRpb24uAAAAB3Jldm9rZWQAAAAAAQ==",
        "AAAAAQAAAPZBIHNpbmdsZSBtaWxlc3RvbmUgZm9yIGdyYWRlZCB2ZXN0aW5nLgoKYG9mZnNldF9zZWNzYCDigJQgc2Vjb25kcyBhZnRlciBgc3RhcnRfdGltZWAgd2hlbiB0aGlzIHRyYW5jaGUgdW5sb2Nrcy4KYGJwc2AgICAgICAgICDigJQgYmFzaXMgcG9pbnRzICgxLzEwXzAwMCkgb2YgYHRvdGFsX2Ftb3VudGAgdGhhdCB1bmxvY2suCgpUaGUgbWlsZXN0b25lcyBpbiBhIHNjaGVkdWxlIG11c3Qgc3VtIHRvIGV4YWN0bHkgMTBfMDAwIGJwcy4AAAAAAAAAAAAPR3JhZGVkTWlsZXN0b25lAAAAAAIAAAA7QmFzaXMgcG9pbnRzIChvdXQgb2YgMTBfMDAwKSBvZiBgdG90YWxfYW1vdW50YCB0aGF0IHVubG9jay4AAAAAA2JwcwAAAAAEAAAANVNlY29uZHMgYWZ0ZXIgYHN0YXJ0X3RpbWVgIHdoZW4gdGhpcyB0cmFuY2hlIHVubG9ja3MuAAAAAAAAC29mZnNldF9zZWNzAAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAAD1Zlc3RpbmdTY2hlZHVsZQAAAAATAAAAJUFkZHJlc3MgdGhhdCBjYW4gY2xhaW0gdmVzdGVkIHRva2Vucy4AAAAAAAALYmVuZWZpY2lhcnkAAAAAEwAAACpUb2tlbnMgYWxyZWFkeSBjbGFpbWVkIGJ5IHRoZSBiZW5lZmljaWFyeS4AAAAAAA5jbGFpbWVkX2Ftb3VudAAAAAAACwAAAPdDbGlmZiBpbiBzZWNvbmRzIGZyb20gYHN0YXJ0X3RpbWVgLgoKLSBgTGluZWFyYDogaWdub3JlZC4KLSBgQ2xpZmZgOiB0b2tlbnMgdW5sb2NrIGFsbC1hdC1vbmNlIGFmdGVyIHRoaXMgbWFueSBzZWNvbmRzLgotIGBMaW5lYXJXaXRoQ2xpZmZgOiBubyB0b2tlbnMgdW50aWwgdGhpcyBwb2ludDsgbGluZWFyIGZyb20gaGVyZSB0byBlbmQuCi0gYEdyYWRlZGA6IGlnbm9yZWQgKG1pbGVzdG9uZXMgZGVmaW5lIHRoZSBzY2hlZHVsZSkuAAAAAA1jbGlmZl9zZWNvbmRzAAAAAAAABgAAABxWZXN0aW5nIGR1cmF0aW9uIGluIHNlY29uZHMuAAAAEGR1cmF0aW9uX3NlY29uZHMAAAAGAAAALkFkZHJlc3MgdGhhdCBjcmVhdGVkIGFuZCBmdW5kZWQgdGhpcyBzY2hlZHVsZS4AAAAAAAdncmFudG9yAAAAABMAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAARraW5kAAAH0AAAAAtWZXN0aW5nS2luZAAAAADPTG9ja3VwIHBlcmlvZCBpbiBzZWNvbmRzIGZyb20gYHN0YXJ0X3RpbWVgLgpEdXJpbmcgbG9ja3VwLCB0b2tlbnMgYXJlIHZlc3RlZCAoZWFybmVkKSBidXQgbm9uLXRyYW5zZmVyYWJsZS4KQmVuZWZpY2lhcnkgY2FuIGNsYWltIGFmdGVyIGxvY2t1cCBleHBpcmVzIGV2ZW4gaWYgdG9rZW5zIHZlc3RlZCBlYXJsaWVyLgpNdXN0IGJlID49IGNsaWZmX3NlY29uZHMuAAAAAA9sb2NrdXBfZHVyYXRpb24AAAAABgAAAFJNaWxlc3RvbmUgdHJhbmNoZXMgZm9yIGBWZXN0aW5nS2luZDo6R3JhZGVkYCBzY2hlZHVsZXMuCkVtcHR5IGZvciBhbGwgb3RoZXIga2luZHMuAAAAAAAKbWlsZXN0b25lcwAAAAAD6gAAB9AAAAAPR3JhZGVkTWlsZXN0b25lAAAAACpXaGV0aGVyIHRoaXMgc2NoZWR1bGUgaXMgY3VycmVudGx5IHBhdXNlZC4AAAAAAAZwYXVzZWQAAAAAAAEAAAA+VGltZXN0YW1wIHdoZW4gdGhlIHNjaGVkdWxlIHdhcyBsYXN0IHBhdXNlZCAoMCBpZiBub3QgcGF1c2VkKS4AAAAAAAlwYXVzZWRfYXQAAAAAAAAGAAAAOkN1bXVsYXRpdmUgdGltZSAoaW4gc2Vjb25kcykgdGhlIHNjaGVkdWxlIGhhcyBiZWVuIHBhdXNlZC4AAAAAAA9wYXVzZWRfZHVyYXRpb24AAAAABgAAAD5XaGV0aGVyIHBlcmZvcm1hbmNlIG1pbGVzdG9uZXMgYXJlIHJlcXVpcmVkIGZvciB0aGlzIHNjaGVkdWxlLgAAAAAAE3JlcXVpcmVzX21pbGVzdG9uZXMAAAAAAQAAAC9XaGV0aGVyIHRoZSBncmFudG9yIGNhbiByZXZva2UgdW52ZXN0ZWQgdG9rZW5zLgAAAAAJcmV2b2NhYmxlAAAAAAAAAQAAACdXaGV0aGVyIHRoaXMgc2NoZWR1bGUgaGFzIGJlZW4gcmV2b2tlZC4AAAAAB3Jldm9rZWQAAAAAAQAAACNVbml4IHRpbWVzdGFtcCB3aGVuIHZlc3RpbmcgYmVnaW5zLgAAAAAKc3RhcnRfdGltZQAAAAAABgAAACxTdGVsbGFyIGFzc2V0IGNvbnRyYWN0IGZvciB0aGUgdmVzdGVkIHRva2VuLgAAAAV0b2tlbgAAAAAAABMAAABBVG90YWwgdG9rZW5zIGxvY2tlZCBpbnRvIHRoaXMgc2NoZWR1bGUgKGluIHN0cm9vcHMgLyBiYXNlIHVuaXRzKS4AAAAAAAAMdG90YWxfYW1vdW50AAAACwAAAKZUb2tlbnMgdGhhdCB3ZXJlIHZlc3RlZCBhdCB0aGUgbW9tZW50IG9mIHJldm9jYXRpb24uClplcm8gZm9yIG5vbi1yZXZva2VkIHNjaGVkdWxlcy4gVXNlZCBzbyB0aGUgYmVuZWZpY2lhcnkgY2FuIHN0aWxsCmNsYWltIGFscmVhZHktdmVzdGVkIHRva2VucyBhZnRlciBhIHJldm9jYXRpb24uAAAAAAAQdmVzdGVkX2F0X3Jldm9rZQAAAAs=",
        "AAAAAAAAAYhCYXRjaCB2aWV3OiBmZXRjaCBtdWx0aXBsZSBzY2hlZHVsZXMgaW4gYSBzaW5nbGUgc2ltdWxhdGlvbiByb3VuZC10cmlwLgoKUmV0dXJucyBgTm9uZWAgZm9yIHVua25vd24gSURzIHJhdGhlciB0aGFuIHBhbmlja2luZywgc28gY2FsbGVycyBjYW4Kc2FmZWx5IHBhc3MgYSBjb250aWd1b3VzIHJhbmdlIHdpdGhvdXQga25vd2luZyB3aGljaCBJRHMgZXhpc3QuClJlc3VsdHMgYXJlIHJldHVybmVkIGluIHRoZSBzYW1lIG9yZGVyIGFzIHRoZSBpbnB1dCBgaWRzYCB2ZWN0b3IuCgpUaGlzIHJlcGxhY2VzIHRoZSBgUHJvbWlzZS5hbGwoZ2V0U2NoZWR1bGUpYCBwYXR0ZXJuIGluIHRoZSBmcm9udGVuZApkYXNoYm9hcmQsIHJlZHVjaW5nIE4gc2ltdWxhdGlvbiByb3VuZC10cmlwcyB0byAxLgAAABJnZXRfc2NoZWR1bGVfYmF0Y2gAAAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAABgAAAAEAAAPqAAAD6AAAB9AAAAAPVmVzdGluZ1NjaGVkdWxlAA==",
        "AAAAAAAAARJHZXQgdGhlIHN0YXR1cyBvZiBhIHBlbmRpbmcgdXBncmFkZTogaGFzaCBhbmQgZXhlY3V0YWJsZSB0aW1lc3RhbXAuCgpBbGxvd3MgdXNlcnMgYW5kIGdvdmVybmFuY2UgdG9vbHMgdG8gaW5zcGVjdCBhIHBlbmRpbmcgdXBncmFkZSB3aXRob3V0CnBhcnNpbmcgcmF3IHN0b3JhZ2Uga2V5cy4gUmV0dXJucyB0aGUgV0FTTSBoYXNoIGFuZCB0aGUgdGltZXN0YW1wIHdoZW4KZXhlY3V0aW9uIGJlY29tZXMgcG9zc2libGUsIG9yIGBOb25lYCBpZiBubyB1cGdyYWRlIGlzIHBlbmRpbmcuAAAAAAASZ2V0X3VwZ3JhZGVfc3RhdHVzAAAAAAAAAAAAAQAAA+gAAAPtAAAAAgAAA+4AAAAgAAAABg==",
        "AAAAAAAAAC5HZXQgdGhlIGNvbmZpZ3VyZWQgcGVyZm9ybWFuY2Ugb3JhY2xlIGFkZHJlc3MuAAAAAAAScGVyZm9ybWFuY2Vfb3JhY2xlAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAAR5CYXRjaCB2aWV3OiByZXR1cm4gdmVzdGVkIGFtb3VudHMgZm9yIG11bHRpcGxlIHNjaGVkdWxlIElEcyBpbiBhCnNpbmdsZSBzaW11bGF0aW9uIHJvdW5kLXRyaXAuCgpSZXN1bHRzIGFyZSByZXR1cm5lZCBpbiB0aGUgc2FtZSBvcmRlciBhcyB0aGUgaW5wdXQgYGlkc2AgdmVjdG9yLgpVbmtub3duIElEcyByZXR1cm4gMCBpbnN0ZWFkIG9mIHBhbmlja2luZywgc28gdGhlIGNhbGxlciBjYW4gc2FmZWx5CnBhc3MgdGhlIGZ1bGwgSUQgcmFuZ2Ugd2l0aG91dCBrbm93aW5nIHdoaWNoIG9uZXMgZXhpc3QuAAAAAAASdmVzdGVkX2Ftb3VudF9idWxrAAAAAAABAAAAAAAAAANpZHMAAAAD6gAAAAYAAAABAAAD6gAAAAs=",
        "AAAAAQAAADVQYXJhbWV0ZXJzIGFuZCBzdGF0dXMgb2YgYSB0d28tcGhhc2UgZXNjcm93IHByb3Bvc2FsLgAAAAAAAAAAAAAQU2NoZWR1bGVQcm9wb3NhbAAAAA0AAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAAAAAAADmNsaWZmX2R1cmF0aW9uAAAAAAAGAAAAAAAAABFjcmVhdGVkX2F0X2xlZGdlcgAAAAAAAAQAAAAAAAAACGR1cmF0aW9uAAAABgAAAAAAAAAHZ3JhbnRvcgAAAAATAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAEa2luZAAAB9AAAAALVmVzdGluZ0tpbmQAAAAAAAAAAA9sb2NrdXBfZHVyYXRpb24AAAAABgAAAAAAAAAJcmV2b2NhYmxlAAAAAAAAAQAAAAAAAAAKc3RhcnRfdGltZQAAAAAABgAAAAAAAAAFc3RhdGUAAAAAAAfQAAAADVByb3Bvc2FsU3RhdGUAAAAAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAMdG90YWxfYW1vdW50AAAACw==",
        "AAAAAAAAA0ZWaWV3OiByZXR1cm4gdGhlIG51bWJlciBvZiB0b2tlbnMgdGhhdCB1bmxvY2sgYXQgdGhlIGNsaWZmIGRhdGUgZm9yIGEKYENsaWZmYCBvciBgTGluZWFyV2l0aENsaWZmYCBzY2hlZHVsZS4KCnwgS2luZCAgICAgICAgICAgICAgfCBSZXR1cm4gdmFsdWUgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfAp8LS0tLS0tLS0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLXwKfCBgQ2xpZmZgICAgICAgICAgICB8IGB0b3RhbF9hbW91bnRgIChldmVyeXRoaW5nIHVubG9ja3MgYXQgY2xpZmYpICAgICAgICB8CnwgYExpbmVhcldpdGhDbGlmZmAgfCAwIOKAlCB0aGUgY2xpZmYgaXRzZWxmIHVubG9ja3Mgbm90aGluZyBleHRyYTsgbGluZWFyICB8CnwgICAgICAgICAgICAgICAgICAgfCB2ZXN0aW5nIGJlZ2lucyBhdCB0aGUgY2xpZmYgZGF0ZSAgICAgICAgICAgICAgICAgICAgfAp8IGBMaW5lYXJgIC8gb3RoZXIgIHwgMCDigJQgbm8gY2xpZmYgY29uY2VwdCBhcHBsaWVzICAgICAgICAgICAgICAgICAgICAgICAgfAp8IFVua25vd24gSUQgICAgICAgIHwgMCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHwKClRoZSByZXR1cm4gdmFsdWUgaXMgaW4gc3Ryb29wcyAoYmFzZSB0b2tlbiB1bml0cykuIEJlbmVmaWNpYXJpZXMgY2FuCmNvbXBhcmUgdGhpcyBhZ2FpbnN0IGBjbGFpbWFibGUoKWAgdG8gdW5kZXJzdGFuZCBob3cgbXVjaCB3aWxsIGJlY29tZQphdmFpbGFibGUgYXQgdGhlIGNsaWZmIHdpdGhvdXQgZG9pbmcgb2ZmLWNoYWluIG1hdGguAAAAAAATY2xpZmZfdW5sb2NrX2Ftb3VudAAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAQAAAAs=",
        "AAAAAAAAAZVQcmV2aWV3IGhvdyBtYW55IHRva2VucyBhcmUgdmVzdGVkIGJ1dCBzdGlsbCBpbnNpZGUgdGhlIGxvY2t1cCB3aW5kb3cgYXQKdGltZXN0YW1wIGB0c2AuCgpSZXR1cm5zIDAgb25jZSB0aGUgbG9ja3VwIGhhcyBlbGFwc2VkICh0aG9zZSB0b2tlbnMgYXBwZWFyIHZpYQpgY2xhaW1hYmxlX2F0X3RpbWVzdGFtcGAgaW5zdGVhZCksIHdoZW4gbm8gbG9ja3VwIGlzIGNvbmZpZ3VyZWQsIG9yCndoZW4gYHNjaGVkdWxlX2lkYCBpcyB1bmtub3duLgoKRnJvbnRlbmRzIGNhbiBjYWxsIHRoaXMgYWxvbmdzaWRlIGBjbGFpbWFibGVfYXRfdGltZXN0YW1wYCB0bwpkaXN0aW5ndWlzaCAieW91ciB0b2tlbnMgYXJlIHZlc3RpbmcgYnV0IGxvY2tlZCB1bnRpbCBEQVRFIiBmcm9tCiJub3RoaW5nIGhhcyB2ZXN0ZWQgeWV0Ii4AAAAAAAATbG9ja2VkX2F0X3RpbWVzdGFtcAAAAAACAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAAAAAAJ0cwAAAAAABgAAAAEAAAAL",
        "AAAAAAAAAH1SZWNvcmQgdGhhdCB0aGUgYmVuZWZpY2lhcnkgaGFzIHNlZW4gdGhlIHByb3Bvc2FsLgoKRG9lcyBub3QgYmxvY2sgW2BmdW5kX2FuZF9hY3RpdmF0ZWBdLiBJZGVtcG90ZW50IGlmIGFscmVhZHkgYWNrbm93bGVkZ2VkLgAAAAAAABRhY2tub3dsZWRnZV9wcm9wb3NhbAAAAAIAAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1WZXN0Rmxvd0Vycm9yAAAA",
        "AAAAAAAAAVpSZXR1cm4gKiphbGwqKiBzY2hlZHVsZSBJRHMgY3JlYXRlZCBieSBhIGdpdmVuIGdyYW50b3IsIGNvbWJpbmluZwpzaW5nbGUtdG9rZW4gYW5kIG11bHRpLXRva2VuIHNjaGVkdWxlcyBpbnRvIGEgc2luZ2xlIGxpc3QuCgpUaGUgZnJvbnRlbmQgY2FuIHVzZSB0aGlzIHNpbmdsZSB2aWV3IHRvIGxvYWQgZXZlcnkgc2NoZWR1bGUgYQpncmFudG9yIGhhcyBjcmVhdGVkIHdpdGhvdXQgZmV0Y2hpbmcgdGhlIGVudGlyZSBzY2hlZHVsZSBzcGFjZSBhbmQKZmlsdGVyaW5nIGNsaWVudC1zaWRlLgoKUmV0dXJucyBhbiBlbXB0eSB2ZWMgaWYgdGhlIGdyYW50b3IgaGFzIG5vdCBjcmVhdGVkIGFueSBzY2hlZHVsZXMuAAAAAAAUZ3JhbnRvcl9zY2hlZHVsZV9pZHMAAAABAAAAAAAAAAdncmFudG9yAAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAWNUcmFuc2ZlciBiZW5lZmljaWFyeSByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4KCk9ubHkgdGhlIGN1cnJlbnQgYmVuZWZpY2lhcnkgbWF5IGNhbGwgdGhpcy4gVGhlIHNjaGVkdWxlIG11c3Qgbm90IGJlCnJldm9rZWQuIEVtaXRzIGEgYGJuZl9jaG5nYCBldmVudCB3aXRoCmAoc2NoZWR1bGVfaWQsIG9sZF9iZW5lZmljaWFyeSwgbmV3X2JlbmVmaWNpYXJ5KWAuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJTY2hlZHVsZSBub3QgZm91bmQiYCBpZiBgc2NoZWR1bGVfaWRgIGRvZXMgbm90IGV4aXN0LgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIGhhcyBiZWVuIHJldm9rZWQiYCBpZiB0aGUgc2NoZWR1bGUgd2FzIHJldm9rZWQuAAAAABR0cmFuc2Zlcl9iZW5lZmljaWFyeQAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAD25ld19iZW5lZmljaWFyeQAAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANVmVzdEZsb3dFcnJvcgAAAA==",
        "AAAAAAAAAD9HZXQgY2xhaW1hYmxlIGFtb3VudHMgZm9yIGFsbCB0b2tlbnMgaW4gYSBtdWx0aS10b2tlbiBzY2hlZHVsZS4AAAAAFWNsYWltYWJsZV9tdWx0aV90b2tlbgAAAAAAAAEAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAABAAAD6gAAAAs=",
        "AAAAAAAAADNHZXQgYWxsIG11bHRpLXRva2VuIHNjaGVkdWxlIElEcyBmb3IgYSBiZW5lZmljaWFyeS4AAAAAFWdldF9iZW5lZmljaWFyeV9tdWx0aQAAAAAAAAEAAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAFRWaWV3OiByZXR1cm4gdGhlIHZlc3RlZCBhbW91bnQgZm9yIGEgc2NoZWR1bGUgSUQgdXNpbmcgdGhlIGN1cnJlbnQKbGVkZ2VyIHRpbWVzdGFtcC4AAAAVdmVzdGVkX2Ftb3VudF9jdXJyZW50AAAAAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAAL",
        "AAAAAAAAAcVQcmV2aWV3IGhvdyBtYW55IHRva2VucyB3aWxsIGJlIGNsYWltYWJsZSBhdCBhbiBhcmJpdHJhcnkgdGltZXN0YW1wIGB0c2AuCgpJbnRlbmRlZCBmb3IgVUkgcHJldmlld3Mgc3VjaCBhcyAiaG93IG11Y2ggY2FuIEkgY2xhaW0gYXQgdGhlIDEteWVhcgptYXJrPyIuIFRoZSByZXN1bHQgcmVmbGVjdHMgY3VycmVudCBzY2hlZHVsZSBzdGF0ZSBwcm9qZWN0ZWQgdG8gYHRzYDoKaXQgYWNjb3VudHMgZm9yIGxvY2t1cCwgcGF1c2VzIChhY2N1bXVsYXRlZCB1cCB0byBub3cpLCBjbGlmZiwgYW5kCnJldm9jYXRpb24sIGJ1dCB1c2VzIHRoZSBjdXJyZW50IGBjbGFpbWVkX2Ftb3VudGAg4oCUIHNvIHRoZSByZXR1cm4gdmFsdWUKaXMgbW9zdCBtZWFuaW5nZnVsIGZvciBmdXR1cmUgdGltZXN0YW1wcy4KClJldHVybnMgMCBpZiBgc2NoZWR1bGVfaWRgIGlzIHVua25vd24gKGRvZXMgbm90IHBhbmljKS4AAAAAAAAWY2xhaW1hYmxlX2F0X3RpbWVzdGFtcAAAAAAAAgAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAAAAAACdHMAAAAAAAYAAAABAAAACw==",
        "AAAAAAAAAz1DcmVhdGUgYSBuZXcgZ3JhZGVkIChwZXJjZW50YWdlLWJhc2VkKSB2ZXN0aW5nIHNjaGVkdWxlLgoKVG9rZW5zIHVubG9jayBhdCBkaXNjcmV0ZSBtaWxlc3RvbmVzLiBFYWNoIG1pbGVzdG9uZSBzcGVjaWZpZXMgYW4Kb2Zmc2V0IGluIHNlY29uZHMgZnJvbSBgc3RhcnRfdGltZWAgYW5kIGEgc2hhcmUgaW4gYmFzaXMgcG9pbnRzCigxIGJwcyA9IDAuMDElKS4gVGhlIG1pbGVzdG9uZXMgbXVzdCBzdW0gdG8gZXhhY3RseSAxMCAwMDAgYnBzLgoKRXhhbXBsZTogMTAlIGF0IG1vbnRoIDYsIDIwJSBhdCBtb250aCAxMiwgNzAlIGF0IG1vbnRoIDI0IHdvdWxkIHVzZQptaWxlc3RvbmVzIHdpdGggb2Zmc2V0X3NlY3MgMTVfNTUyXzAwMCAvIDMxXzEwNF8wMDAgLyA2Ml8yMDhfMDAwIGFuZApicHMgMV8wMDAgLyAyXzAwMCAvIDdfMDAwIHJlc3BlY3RpdmVseS4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIkFtb3VudCBtdXN0IGJlIHBvc2l0aXZlImAgaWYgYHRvdGFsX2Ftb3VudGAg4omkIDAuClBhbmljcyB3aXRoIGAiU3RhcnQgdGltZSBjYW5ub3QgYmUgaW4gdGhlIHBhc3QiYCBpZiBgc3RhcnRfdGltZWAgPCBjdXJyZW50IGxlZGdlciB0aW1lLgpQYW5pY3Mgd2l0aCBgIk1pbGVzdG9uZXMgcmVxdWlyZWQiYCBpZiB0aGUgbWlsZXN0b25lcyBsaXN0IGlzIGVtcHR5LgpQYW5pY3Mgd2l0aCBgIk1pbGVzdG9uZSB1bmxvY2sgcGVyY2VudGFnZSBtdXN0IGJlIG5vbi16ZXJvImAgaWYgYW55IG1pbGVzdG9uZSBoYXMgMCBicHMuClBhbmljcyB3aXRoIGAiTWlsZXN0b25lcyBtdXN0IHN1bSB0byAxMDAwMCBicHMiYCBpZiB0aGUgYnBzIHRvdGFsIOKJoCAxMCAwMDAuAAAAAAAAFmNyZWF0ZV9ncmFkZWRfc2NoZWR1bGUAAAAAAAgAAAAAAAAAB2dyYW50b3IAAAAAEwAAAAAAAAALYmVuZWZpY2lhcnkAAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAx0b3RhbF9hbW91bnQAAAALAAAAAAAAAApzdGFydF90aW1lAAAAAAAGAAAAAAAAAA9sb2NrdXBfZHVyYXRpb24AAAAABgAAAAAAAAAJcmV2b2NhYmxlAAAAAAAAAQAAAAAAAAAKbWlsZXN0b25lcwAAAAAD6gAAB9AAAAAPR3JhZGVkTWlsZXN0b25lAAAAAAEAAAPpAAAABgAAB9AAAAANVmVzdEZsb3dFcnJvcgAAAA==",
        "AAAAAQAAAD5QZXJmb3JtYW5jZSBtaWxlc3RvbmUgYXR0ZXN0YXRpb24gZm9yIGdhdGluZyB2ZXN0aW5nIHJlbGVhc2VzLgAAAAAAAAAAABRQZXJmb3JtYW5jZU1pbGVzdG9uZQAAAAMAAAA2V2hldGhlciB0aGUgbWlsZXN0b25lIGhhcyBiZWVuIGF0dGVzdGVkIGJ5IHRoZSBvcmFjbGUuAAAAAAAIYXR0ZXN0ZWQAAAABAAAAKlRpbWVzdGFtcCB3aGVuIHRoZSBtaWxlc3RvbmUgd2FzIGF0dGVzdGVkLgAAAAAAC2F0dGVzdGVkX2F0AAAAAAYAAAA/UGVyY2VudGFnZSBvZiB0b3RhbCB2ZXN0aW5nIHVubG9ja2VkIGJ5IHRoaXMgbWlsZXN0b25lICgwLTEwMCkuAAAAABF1bmxvY2tfcGVyY2VudGFnZQAAAAAAAAQ=",
        "AAAAAAAAALdJbml0aWFsaXplIHRoZSBORlQgY29udHJhY3QgZm9yIHZlc3RpbmcgcmVjZWlwdCB0b2tlbnMuCgpDYW4gb25seSBiZSBjYWxsZWQgb25jZSBieSB0aGUgdXBncmFkZSBhdXRob3JpdHkuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJORlQgY29udHJhY3QgYWxyZWFkeSBpbml0aWFsaXplZCJgIGlmIGNhbGxlZCBhZ2Fpbi4AAAAAF2luaXRpYWxpemVfbmZ0X2NvbnRyYWN0AAAAAAEAAAAAAAAADG5mdF9jb250cmFjdAAAABMAAAAA",
        "AAAAAAAAAM9SZXR1cm4gKiphbGwqKiBzY2hlZHVsZSBJRHMgd2hlcmUgdGhlIGdpdmVuIGFkZHJlc3MgaXMgdGhlCmJlbmVmaWNpYXJ5LCBjb21iaW5pbmcgc2luZ2xlLXRva2VuIGFuZCBtdWx0aS10b2tlbiBzY2hlZHVsZXMgaW50bwphIHNpbmdsZSBsaXN0LgoKUmV0dXJucyBhbiBlbXB0eSB2ZWMgaWYgdGhlIGFkZHJlc3MgaGFzIG5vIGJlbmVmaWNpYXJ5IHNjaGVkdWxlcy4AAAAAGGJlbmVmaWNpYXJ5X3NjaGVkdWxlX2lkcwAAAAEAAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAACFHZXQgYSBtdWx0aS10b2tlbiBzY2hlZHVsZSBieSBJRC4AAAAAAAAYZ2V0X211bHRpX3Rva2VuX3NjaGVkdWxlAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAEAAAPoAAAH0AAAABlNdWx0aVRva2VuVmVzdGluZ1NjaGVkdWxlAAAA",
        "AAAAAAAAAHNSZXR1cm4gc2NoZWR1bGUgSURzIGNyZWF0ZWQgYnkgYSBnaXZlbiBncmFudG9yLgoKUmV0dXJucyBhbiBlbXB0eSB2ZWMgaWYgdGhlIGdyYW50b3IgaGFzIG5vdCBjcmVhdGVkIGFueSBzY2hlZHVsZXMuAAAAABhnZXRfc2NoZWR1bGVzX2J5X2dyYW50b3IAAAABAAAAAAAAAAdncmFudG9yAAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAHhUcmFuc2ZlciB1cGdyYWRlIGF1dGhvcml0eSB0byBhIG5ldyBhZGRyZXNzLgoKQm90aCB0aGUgY3VycmVudCBhbmQgbmV3IGF1dGhvcml0eSBtdXN0IHNpZ24uIEVtaXRzIGFuIGAidXBncl94ZnIiYCBldmVudC4AAAAadHJhbnNmZXJfdXBncmFkZV9hdXRob3JpdHkAAAAAAAIAAAAAAAAAEWN1cnJlbnRfYXV0aG9yaXR5AAAAAAAAEwAAAAAAAAANbmV3X2F1dGhvcml0eQAAAAAAABMAAAAA",
        "AAAAAAAAA85DcmVhdGUgYSBuZXcgbXVsdGktdG9rZW4gdmVzdGluZyBzY2hlZHVsZSBzdXBwb3J0aW5nIHNpbXVsdGFuZW91cyB2ZXN0aW5nIG9mIG11bHRpcGxlIGFzc2V0cy4KCkFsbG93cyBhIGJlbmVmaWNpYXJ5IHRvIHJlY2VpdmUgbXVsdGlwbGUgZGlmZmVyZW50IHRva2VucyBvbiB0aGUgc2FtZSB2ZXN0aW5nIHRpbWVsaW5lLAplbGltaW5hdGluZyB0aGUgbmVlZCB0byBjcmVhdGUgc2VwYXJhdGUgc2NoZWR1bGVzIGZvciBlYWNoIHRva2VuLgoKIyBBcmd1bWVudHMKCiogYGdyYW50b3JgIC0gQWRkcmVzcyBmdW5kaW5nIHRoZSBzY2hlZHVsZSBhbmQgYXV0aG9yaXplZCB0byByZXZva2UKKiBgYmVuZWZpY2lhcnlgIC0gQWRkcmVzcyByZWNlaXZpbmcgYWxsIHZlc3RlZCB0b2tlbnMKKiBgdG9rZW5zYCAtIFZlYyBvZiBUb2tlblRyYW5jaGUgKGVhY2ggdG9rZW4sIGFtb3VudCwgYW5kIGNsYWltIHRyYWNraW5nKQoqIGBzdGFydF90aW1lYCAtIFVuaXggdGltZXN0YW1wIHdoZW4gdmVzdGluZyBiZWdpbnMKKiBgZHVyYXRpb25gIC0gVmVzdGluZyBkdXJhdGlvbiBpbiBzZWNvbmRzCiogYGNsaWZmX2R1cmF0aW9uYCAtIENsaWZmIHBlcmlvZCBpbiBzZWNvbmRzICgwIGZvciBubyBjbGlmZikKKiBgbG9ja3VwX2R1cmF0aW9uYCAtIExvY2t1cCBwZXJpb2QgaW4gc2Vjb25kcyAobXVzdCBiZSA+PSBjbGlmZl9kdXJhdGlvbikKKiBga2luZGAgLSBWZXN0aW5nS2luZCAoTGluZWFyLCBDbGlmZiwgTGluZWFyV2l0aENsaWZmLCBvciBHcmFkZWQpCiogYHJldm9jYWJsZWAgLSBXaGV0aGVyIGdyYW50b3IgY2FuIHJldm9rZSB1bnZlc3RlZCB0b2tlbnMKKiBgbWlsZXN0b25lc2AgLSBHcmFkZWRNaWxlc3RvbmUgdmVjIGZvciBHcmFkZWQga2luZCAoZW1wdHkgZm9yIG90aGVycykKCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCB2YXJpb3VzIHZhbGlkYXRpb24gZXJyb3JzIChzZWUgc2luZ2xlLXRva2VuIGBjcmVhdGVfc2NoZWR1bGVgKQAAAAAAG2NyZWF0ZV9tdWx0aV90b2tlbl9zY2hlZHVsZQAAAAAKAAAAAAAAAAdncmFudG9yAAAAABMAAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAAAAAAABnRva2VucwAAAAAD6gAAB9AAAAAMVG9rZW5UcmFuY2hlAAAAAAAAAApzdGFydF90aW1lAAAAAAAGAAAAAAAAAAhkdXJhdGlvbgAAAAYAAAAAAAAADmNsaWZmX2R1cmF0aW9uAAAAAAAGAAAAAAAAAA9sb2NrdXBfZHVyYXRpb24AAAAABgAAAAAAAAAEa2luZAAAB9AAAAALVmVzdGluZ0tpbmQAAAAAAAAAAAlyZXZvY2FibGUAAAAAAAABAAAAAAAAAAptaWxlc3RvbmVzAAAAAAPqAAAH0AAAAA9HcmFkZWRNaWxlc3RvbmUAAAAAAQAAA+kAAAAGAAAH0AAAAA1WZXN0Rmxvd0Vycm9yAAAA",
        "AAAAAQAAANBBIHZlc3Rpbmcgc2NoZWR1bGUgdGhhdCBzdXBwb3J0cyBtdWx0aXBsZSBTdGVsbGFyIGFzc2V0cyBzaW11bHRhbmVvdXNseS4KCkFsbG93cyBhIHNpbmdsZSBzY2hlZHVsZSB0byB2ZXN0IGRpZmZlcmVudCB0b2tlbnMgb24gdGhlIHNhbWUgdGltZWxpbmUsCmF2b2lkaW5nIHRoZSBuZWVkIHRvIGNyZWF0ZSBzZXBhcmF0ZSBzY2hlZHVsZXMgZm9yIGVhY2ggdG9rZW4uAAAAAAAAABlNdWx0aVRva2VuVmVzdGluZ1NjaGVkdWxlAAAAAAAAEAAAACVBZGRyZXNzIHRoYXQgY2FuIGNsYWltIHZlc3RlZCB0b2tlbnMuAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAAjQ2xpZmYgaW4gc2Vjb25kcyBmcm9tIGBzdGFydF90aW1lYC4AAAAADWNsaWZmX3NlY29uZHMAAAAAAAAGAAAAHFZlc3RpbmcgZHVyYXRpb24gaW4gc2Vjb25kcy4AAAAQZHVyYXRpb25fc2Vjb25kcwAAAAYAAAAuQWRkcmVzcyB0aGF0IGNyZWF0ZWQgYW5kIGZ1bmRlZCB0aGlzIHNjaGVkdWxlLgAAAAAAB2dyYW50b3IAAAAAEwAAAAAAAAACaWQAAAAAAAYAAAAAAAAABGtpbmQAAAfQAAAAC1Zlc3RpbmdLaW5kAAAAACtMb2NrdXAgcGVyaW9kIGluIHNlY29uZHMgZnJvbSBgc3RhcnRfdGltZWAuAAAAAA9sb2NrdXBfZHVyYXRpb24AAAAABgAAADdNaWxlc3RvbmUgdHJhbmNoZXMgZm9yIGBWZXN0aW5nS2luZDo6R3JhZGVkYCBzY2hlZHVsZXMuAAAAAAptaWxlc3RvbmVzAAAAAAPqAAAH0AAAAA9HcmFkZWRNaWxlc3RvbmUAAAAAKldoZXRoZXIgdGhpcyBzY2hlZHVsZSBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAAABnBhdXNlZAAAAAAAAQAAAD5UaW1lc3RhbXAgd2hlbiB0aGUgc2NoZWR1bGUgd2FzIGxhc3QgcGF1c2VkICgwIGlmIG5vdCBwYXVzZWQpLgAAAAAACXBhdXNlZF9hdAAAAAAAAAYAAAA6Q3VtdWxhdGl2ZSB0aW1lIChpbiBzZWNvbmRzKSB0aGUgc2NoZWR1bGUgaGFzIGJlZW4gcGF1c2VkLgAAAAAAD3BhdXNlZF9kdXJhdGlvbgAAAAAGAAAAL1doZXRoZXIgdGhlIGdyYW50b3IgY2FuIHJldm9rZSB1bnZlc3RlZCB0b2tlbnMuAAAAAAlyZXZvY2FibGUAAAAAAAABAAAAJ1doZXRoZXIgdGhpcyBzY2hlZHVsZSBoYXMgYmVlbiByZXZva2VkLgAAAAAHcmV2b2tlZAAAAAABAAAAI1VuaXggdGltZXN0YW1wIHdoZW4gdmVzdGluZyBiZWdpbnMuAAAAAApzdGFydF90aW1lAAAAAAAGAAAANk11bHRpcGxlIHRva2VucyB3aXRoIHRoZWlyIGFtb3VudHMgYW5kIGNsYWltIHRyYWNraW5nLgAAAAAABnRva2VucwAAAAAD6gAAB9AAAAAMVG9rZW5UcmFuY2hlAAAANFRva2VucyB0aGF0IHdlcmUgdmVzdGVkIGF0IHRoZSBtb21lbnQgb2YgcmV2b2NhdGlvbi4AAAAQdmVzdGVkX2F0X3Jldm9rZQAAAAs=",
        "AAAAAAAAAIJSZXR1cm4gc2NoZWR1bGUgSURzIHdoZXJlIHRoZSBnaXZlbiBhZGRyZXNzIGlzIHRoZSBiZW5lZmljaWFyeS4KClJldHVybnMgYW4gZW1wdHkgdmVjIGlmIHRoZSBhZGRyZXNzIGhhcyBubyBiZW5lZmljaWFyeSBzY2hlZHVsZXMuAAAAAAAcZ2V0X3NjaGVkdWxlc19ieV9iZW5lZmljaWFyeQAAAAEAAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAYpJbml0aWFsaXplIHRoZSBhZGRyZXNzIHRoYXQgbWF5IGFubm91bmNlIGFuZCBleGVjdXRlIGNvbnRyYWN0IHVwZ3JhZGVzLgoKVGhpcyBtYXkgb25seSBiZSBjYWxsZWQgb25jZSwgYW5kIHRoZSBjaG9zZW4gYXV0aG9yaXR5IG11c3QgYXV0aG9yaXplCnRoZSBjYWxsLiBPbmNlIGluaXRpYWxpemVkLCBldmVyeSBjb250cmFjdCBXQVNNIG1pZ3JhdGlvbiBtdXN0IGJlCmFubm91bmNlZCB3aXRoIFtgYW5ub3VuY2VfdXBncmFkZWBdIGFuZCB3YWl0IGF0IGxlYXN0IDQ4IGhvdXJzIGJlZm9yZQpbYGV4ZWN1dGVfdXBncmFkZWBdIGNhbiBhcHBseSBpdC4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlVwZ3JhZGUgYXV0aG9yaXR5IGFscmVhZHkgaW5pdGlhbGl6ZWQiYCBpZiBjYWxsZWQgYWdhaW4uAAAAAAAcaW5pdGlhbGl6ZV91cGdyYWRlX2F1dGhvcml0eQAAAAEAAAAAAAAACWF1dGhvcml0eQAAAAAAABMAAAAA",
        "AAAAAAAAAXJFbmFibGUgcGVyZm9ybWFuY2UtYmFzZWQgdmVzdGluZyBmb3IgYSBzY2hlZHVsZSAoZ3JhbnRvciBvbmx5KS4KCk9uY2UgZW5hYmxlZCwgdGhlIGJlbmVmaWNpYXJ5IGNhbiBvbmx5IGNsYWltIHRva2VucyBhZnRlciB0aGUgb3JhY2xlCmF0dGVzdHMgdGhlIHJlcXVpcmVkIG1pbGVzdG9uZXMuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJTY2hlZHVsZSBub3QgZm91bmQiYCBpZiBgc2NoZWR1bGVfaWRgIGRvZXMgbm90IGV4aXN0LgpQYW5pY3Mgd2l0aCBgIk5vdCB0aGUgZ3JhbnRvciJgIGlmIGNhbGxlciBpcyBub3QgdGhlIGdyYW50b3IuClBhbmljcyB3aXRoIGAiTWlsZXN0b25lcyBhbHJlYWR5IGVuYWJsZWQiYCBpZiBhbHJlYWR5IGVuYWJsZWQuAAAAAAAdZW5hYmxlX3BlcmZvcm1hbmNlX21pbGVzdG9uZXMAAAAAAAACAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAAAAAAptaWxlc3RvbmVzAAAAAAPqAAAABAAAAAA=",
        "AAAAAAAAAMRJbml0aWFsaXplIHRoZSBvcmFjbGUgYWRkcmVzcyBhdXRob3JpemVkIHRvIGF0dGVzdCBwZXJmb3JtYW5jZSBtaWxlc3RvbmVzLgoKQ2FuIG9ubHkgYmUgY2FsbGVkIG9uY2UgYnkgdGhlIHVwZ3JhZGUgYXV0aG9yaXR5LgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiT3JhY2xlIGFscmVhZHkgaW5pdGlhbGl6ZWQiYCBpZiBjYWxsZWQgYWdhaW4uAAAAHWluaXRpYWxpemVfcGVyZm9ybWFuY2Vfb3JhY2xlAAAAAAAAAQAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    claim: this.txFromJSON<Result<void>>,
        revoke: this.txFromJSON<Result<void>>,
        version: this.txFromJSON<u32>,
        claimable: this.txFromJSON<i128>,
        is_revoked: this.txFromJSON<boolean>,
        get_proposal: this.txFromJSON<Option<ScheduleProposal>>,
        get_schedule: this.txFromJSON<Result<VestingSchedule>>,
        nft_contract: this.txFromJSON<Option<string>>,
        total_locked: this.txFromJSON<i128>,
        vesting_type: this.txFromJSON<Option<VestingKind>>,
        vested_amount: this.txFromJSON<i128>,
        cancel_upgrade: this.txFromJSON<null>,
        claimable_bulk: this.txFromJSON<Array<i128>>,
        get_delegation: this.txFromJSON<Option<ClaimDelegation>>,
        get_milestones: this.txFromJSON<Option<Array<PerformanceMilestone>>>,
        pause_schedule: this.txFromJSON<null>,
        schedule_count: this.txFromJSON<u64>,
        create_schedule: this.txFromJSON<Result<u64>>,
        execute_upgrade: this.txFromJSON<null>,
        expire_proposal: this.txFromJSON<Result<void>>,
        extend_duration: this.txFromJSON<Result<void>>,
        fully_vested_at: this.txFromJSON<Option<u64>>,
        merge_schedules: this.txFromJSON<Result<u64>>,
        pending_upgrade: this.txFromJSON<Option<PendingUpgrade>>,
        resume_schedule: this.txFromJSON<null>,
        announce_upgrade: this.txFromJSON<PendingUpgrade>,
        attest_milestone: this.txFromJSON<null>,
        claimable_amount: this.txFromJSON<i128>,
        destroy_schedule: this.txFromJSON<null>,
        propose_schedule: this.txFromJSON<Result<u64>>,
        transfer_grantor: this.txFromJSON<Result<void>>,
        bump_schedule_ttl: this.txFromJSON<Result<void>>,
        claim_as_delegate: this.txFromJSON<Result<void>>,
        claim_multi_token: this.txFromJSON<Result<void>>,
        create_delegation: this.txFromJSON<Result<u32>>,
        fund_and_activate: this.txFromJSON<Result<u64>>,
        get_grantor_multi: this.txFromJSON<Array<u64>>,
        irrevocable_count: this.txFromJSON<u64>,
        revoke_delegation: this.txFromJSON<Result<void>>,
        upgrade_authority: this.txFromJSON<string>,
        get_schedule_batch: this.txFromJSON<Array<Option<VestingSchedule>>>,
        get_upgrade_status: this.txFromJSON<Option<readonly [Buffer, u64]>>,
        performance_oracle: this.txFromJSON<Option<string>>,
        vested_amount_bulk: this.txFromJSON<Array<i128>>,
        cliff_unlock_amount: this.txFromJSON<i128>,
        locked_at_timestamp: this.txFromJSON<i128>,
        acknowledge_proposal: this.txFromJSON<Result<void>>,
        grantor_schedule_ids: this.txFromJSON<Array<u64>>,
        transfer_beneficiary: this.txFromJSON<Result<void>>,
        claimable_multi_token: this.txFromJSON<Array<i128>>,
        get_beneficiary_multi: this.txFromJSON<Array<u64>>,
        vested_amount_current: this.txFromJSON<i128>,
        claimable_at_timestamp: this.txFromJSON<i128>,
        create_graded_schedule: this.txFromJSON<Result<u64>>,
        initialize_nft_contract: this.txFromJSON<null>,
        beneficiary_schedule_ids: this.txFromJSON<Array<u64>>,
        get_multi_token_schedule: this.txFromJSON<Option<MultiTokenVestingSchedule>>,
        get_schedules_by_grantor: this.txFromJSON<Array<u64>>,
        transfer_upgrade_authority: this.txFromJSON<null>,
        create_multi_token_schedule: this.txFromJSON<Result<u64>>,
        get_schedules_by_beneficiary: this.txFromJSON<Array<u64>>,
        initialize_upgrade_authority: this.txFromJSON<null>,
        enable_performance_milestones: this.txFromJSON<null>,
        initialize_performance_oracle: this.txFromJSON<null>
  }
}