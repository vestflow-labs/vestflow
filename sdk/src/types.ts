// ===========================================================================
// VestFlow SDK — Types
// Issue #95: @vestflow/sdk
//
// All public-facing types for the VestFlow vesting protocol.
// ===========================================================================

/**
 * The type of vesting curve applied to a schedule.
 * Mirrors the VestingKind enum in the Soroban contract.
 */
export type VestingKind = "Linear" | "Cliff" | "LinearWithCliff";

/**
 * A vesting schedule that has been revoked by the grantor.
 * `isScheduleRevoked` narrows `ScheduleData` to this type.
 */
export interface RevokedSchedule extends ScheduleData {
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
export function isScheduleRevoked(s: ScheduleData): s is RevokedSchedule {
  return s.revoked === true;
}

/**
 * A fully parsed vesting schedule returned from the contract.
 */
export interface ScheduleData {
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
 * Result returned by {@link VestflowClient.collect}.
 *
 * When there are no claimable tokens the transaction is not submitted:
 * `collected` is `0n` and `txHash` is an empty string.
 */
export interface CollectResult {
  /** Tokens transferred to the beneficiary, in stroops. */
  collected: bigint;
  /** Transaction hash, or an empty string when nothing was collected. */
  txHash: string;
}

/**
 * Result returned by {@link VestflowClient.receiveStreams}.
 *
 * When no past cycles are pending the transaction is not submitted:
 * `received` is `0n` and `txHash` is an empty string.
 */
export interface ReceiveStreamsResult {
  /** Total tokens settled from past cycles, in stroops. */
  received: bigint;
  /** Transaction hash, or an empty string when no cycles were settled. */
  txHash: string;
}

/**
 * Result returned by {@link VestflowClient.squeezeStreams}.
 *
 * When nothing can be squeezed the transaction is not submitted:
 * `collected` is `0n` and `txHash` is an empty string.
 */
export interface SqueezeStreamsResult {
  /** Tokens collected from the current, unfinished cycle, in stroops. */
  collected: bigint;
  /** Transaction hash, or an empty string when nothing was squeezed. */
  txHash: string;
}

/**
 * Result returned by {@link VestflowClient.topUp}.
 */
export interface TopUpResult {
  /** Transaction hash. */
  txHash: string;
}

/**
 * Result returned by {@link VestflowClient.withdraw}.
 *
 * When there is nothing to withdraw the transaction is not submitted:
 * `withdrawn` is `0n` and `txHash` is an empty string.
 */
export interface WithdrawResult {
  /** Tokens returned to the sender's wallet, in stroops. */
  withdrawn: bigint;
  /** Transaction hash, or an empty string when nothing was withdrawn. */
  txHash: string;
}

/**
 * Configuration for the VestflowClient.
 */
export interface VestflowConfig {
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
  /**
   * Override the VestFlow indexer base URL.
   * Used by `getStreams` to query the `/streams` endpoint.
   * Defaults to the public testnet indexer for the selected network.
   */
  indexerUrl?: string;
}

/**
 * A single active outgoing stream returned by the indexer's `/streams` endpoint.
 *
 * Mirrors the Drips-style stream shape: tokens flow from `sender` to `receiver`
 * at a constant `ratePerSec`, ceasing at `maxEndTime`.
 */
export interface Stream {
  /** Stellar address of the account that opened the stream (the sender). */
  sender: string;
  /** Stellar address receiving the streamed tokens. */
  receiver: string;
  /** Stellar Asset Contract address of the streamed token. */
  token: string;
  /** Constant flow rate in stroops (base units) per second. */
  ratePerSec: bigint;
  /** Unix timestamp (seconds) at which the stream stops. */
  maxEndTime: number;
}

/**
 * A receiver in a sender's stream configuration, as recorded in
 * {@link StreamsHistory}.
 */
export interface StreamReceiver {
  /** Stellar address receiving the streamed tokens. */
  receiver: string;
  /** Constant flow rate in stroops (base units) per second. */
  ratePerSec: bigint;
}

/**
 * One entry of a sender's streams history: a receiver configuration and the
 * window it was in effect for. Passed oldest first to
 * {@link VestflowClient.squeezeStreams}.
 */
export interface StreamsHistory {
  /** Receivers configured by this entry. */
  receivers: StreamReceiver[];
  /** Unix timestamp (seconds) at which this configuration took effect. */
  updateTime: number;
  /** Unix timestamp (seconds) at which this configuration's balance runs out. */
  maxEnd: number;
}

/**
 * Outcome of a submitted and settled write transaction.
 */
export interface TransactionResult {
  /** Transaction hash. */
  hash: string;
  /** Settlement status as reported by the Soroban RPC. */
  status: "SUCCESS" | "FAILED";
}

/**
 * Live streaming balance for an account/token pair, read directly via
 * Soroban simulation rather than from indexed state.
 */
export interface BalanceResult {
  /** Total tokens streamed to the account so far but not yet collected. */
  streamingBalance: bigint;
  /** Portion of the streaming balance currently collectable. */
  collectableAmount: bigint;
  /** Current inbound streaming rate, in base units per second. */
  streamingRatePerSec: bigint;
}

/**
 * A single receiver in a splits configuration.
 */
export interface SplitsReceiver {
  /** Stellar address of the receiver. */
  address: string;
  /** Share of incoming funds this receiver gets, in basis points (out of 10 000). */
  weightBps: number;
}

/**
 * An account's current splits configuration, as returned by the indexer.
 */
export interface SplitsConfig {
  /** Configured receivers. Empty when no splits are configured. */
  receivers: SplitsReceiver[];
  /** Hash identifying this splits configuration, or "" when unconfigured. */
  hash: string;
}

/**
 * A single historical one-time direct payment ("give") involving an address.
 */
export interface GiveRecord {
  /** Unique identifier of the give event. */
  id: string;
  /** Stellar address that sent the funds. */
  sender: string;
  /** Stellar address that received the funds. */
  receiver: string;
  /** Stellar Asset Contract address of the token. */
  token: string;
  /** Amount transferred, in the token's base units. */
  amount: bigint;
  /** Ledger in which the give was included. */
  ledger: number;
  /** Unix timestamp (seconds) of the give. */
  timestamp: number;
}

/** A paginated page of give history returned by the indexer. */
export interface GiveHistoryPage {
  items: GiveRecord[];
  nextCursor?: string;
}

/** Filters accepted by `VestflowClient.getGiveHistory`. */
export interface GiveHistoryOptions {
  asSender?: boolean;
  asReceiver?: boolean;
  token?: string;
  limit?: number;
  cursor?: string;
}

/**
 * A Drips list owned by an address, as summarised on a profile.
 */
export interface DripsListSummary {
  /** Unique list identifier. */
  id: string;
  /** Human-readable list name. */
  name: string;
  /** Stellar address that owns the list. */
  owner: string;
  /** Stellar Asset Contract address the list is funded with. */
  token: string;
  /** Number of active members. */
  memberCount: number;
}

/**
 * Aggregated activity for a single address, returned by
 * `VestflowClient.getProfile`.
 *
 * Addresses with no on-chain/indexed activity yield empty arrays, an empty
 * splits config and zeroed totals.
 */
export interface ProfileSummary {
  /** The queried Stellar address. */
  address: string;
  /** Network the profile was read from. */
  network: "testnet" | "mainnet";
  /** Outgoing streams opened by the address. */
  streams: Stream[];
  /** The address's current splits configuration. */
  splits: SplitsConfig;
  /** Recent give activity (sent or received) by the address. */
  gives: GiveRecord[];
  /** Drips lists owned by the address. */
  dripsLists: DripsListSummary[];
  /** Counts and totals — all zero for addresses with no activity. */
  totals: {
    /** Number of outgoing streams. */
    streams: number;
    /** Number of configured splits receivers. */
    splitsReceivers: number;
    /** Number of give records. */
    gives: number;
    /** Sum of give amounts sent by this address, in base units. */
    totalGiven: bigint;
    /** Number of Drips lists owned. */
    dripsLists: number;
  };
}

/**
 * Error thrown by `getProfile` for invalid input or unexpected indexer
 * responses. `status` mirrors the HTTP status the caller should treat it as
 * (e.g. 400 for an invalid address).
 */
export class ProfileError extends Error {
  /** HTTP-style status code associated with this failure. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProfileError";
    this.status = status;
  }
}

/**
 * Parameters for creating a new vesting schedule.
 */
export interface CreateScheduleParams {
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
export interface GradedMilestone {
  /** Days after startTime when this tranche unlocks. */
  offsetDays: number;
  /** Basis points (out of 10 000) of total amount that unlock at this milestone. */
  bps: number;
}

/**
 * Lifecycle of an escrow schedule proposal.
 * Mirrors the ProposalState enum in the Soroban contract.
 */
export type ProposalState =
  | "Pending"
  | "Acknowledged"
  | { tag: "Activated"; scheduleId: number }
  | "Expired";

/**
 * A two-phase escrow proposal returned from the contract.
 */
export interface ScheduleProposal {
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
export interface ProposeScheduleParams extends CreateScheduleParams {
  /** Lockup duration in days. Defaults to 0. Must be >= cliffDays. */
  lockupDays?: number;
}

/**
 * A delegation of claim rights from a schedule's beneficiary to a
 * third-party address, optionally bounded by amount and/or ledger expiry.
 * Mirrors the ClaimDelegation struct in the Soroban contract.
 */
export interface ClaimDelegation {
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
export interface CreateGradedScheduleParams {
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
