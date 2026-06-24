// ===========================================================================
// VestFlow SDK — Public API
// Issue #95: @vestflow/sdk
//
// Everything exported from this file is part of the public API.
// ===========================================================================

export { VestflowClient } from "./client";
export { stroopsToXlm, xlmToStroops, truncate, vestingProgress, formatDate, formatCliffDate, parseContractError } from "./utils";
export type {
  ScheduleData,
  VestflowConfig,
  CreateScheduleParams,
  VestingKind,
} from "./types";

export { connectWallet } from "./wallet";
