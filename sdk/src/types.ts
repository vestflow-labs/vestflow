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
  /** Cumulative time (in seconds) the schedule has been paused. */
  paused_duration: number;
  /** Unix timestamp when the schedule was last paused (0 if not paused). */
  paused_at: number;
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
