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
  formatRate,
  formatCycleDuration,
} from "./utils";
export type { ScheduleSummary } from "./utils";
export { isScheduleRevoked, ProfileError } from "./types";
export type {
  ScheduleData,
  RevokedSchedule,
  VestflowConfig,
  Stream,
  StreamReceiver,
  StreamsHistory,
  CreateScheduleParams,
  CreateGradedScheduleParams,
  ProposeScheduleParams,
  ScheduleProposal,
  ProposalState,
  GradedMilestone,
  VestingKind,
  ClaimDelegation,
  CollectResult,
  ReceiveStreamsResult,
  SqueezeStreamsResult,
  TopUpResult,
  WithdrawResult,
  TransactionResult,
  BalanceResult,
  SplitsReceiver,
  SplitsConfig,
  GiveRecord,
  GiveHistoryPage,
  GiveHistoryOptions,
  DripsListSummary,
  ProfileSummary,
} from "./types";
export { waitForTransaction, TimeoutError } from "./waitForTransaction";
export type {
  WaitForTransactionOptions,
  GetTransactionResponse,
  GetTransactionFn,
} from "./waitForTransaction";
