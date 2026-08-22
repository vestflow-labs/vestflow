// ===========================================================================
// VestFlow SDK — Public API
// Issue #95: @vestflow/sdk
//
// Everything exported from this file is part of the public API.
// ===========================================================================

export { VestflowClient } from "./client";
export {
  xlmToStroops,
  stroopsToXlm,
  truncate,
  vestingProgress,
  formatDate,
  parseContractError,
  formatSchedule,
} from "./utils";
export type { ScheduleSummary } from "./utils";
export { isScheduleRevoked } from "./types";
export type {
  ScheduleData,
  RevokedSchedule,
  VestflowConfig,
  CreateScheduleParams,
  CreateGradedScheduleParams,
  ProposeScheduleParams,
  ScheduleProposal,
  ProposalState,
  GradedMilestone,
  VestingKind,
  ClaimDelegation,
} from "./types";
