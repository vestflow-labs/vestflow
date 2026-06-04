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
  /** Total amount to vest in XLM (converted to stroops internally). */
  totalAmountXlm: number;
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
