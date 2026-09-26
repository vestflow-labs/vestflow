import type { NetworkName } from "./config";

export type EventType =
  | "schedule_created"
  | "claimed"
  | "revoked"
  | "proposal_created"
  | "proposal_acknowledged"
  | "proposal_activated"
  | "proposal_expired"
  | "stream_set"
  | "given"
  | "collected"
  | "stream_received"
  | "squeezed"
  | "unknown";

export interface StreamCycleRow {
  account: string;
  token: string;
  cycle_end_ledger: number;
  cycle_end_timestamp: number;
  amount_received: string;
  created_at?: number;
}

export interface SqueezeEventRow {
  id: string;
  receiver: string;
  sender: string;
  token: string;
  amount_stroops: string;
  cycle_id: number;
  ledger: number;
  timestamp: number;
  history_hash?: string | null;
  is_duplicate: number;
}

export interface StreamConfigDetails {
  sender: string;
  receiver: string;
  token: string;
  rate: string;
  start_time: number;
  balance: string;
  max_end_time: number | null;
}

export interface StreamHistoryRow {
  ledger: number;
  timestamp: number;
  old_rate: string;
  new_rate: string;
  action: "open" | "rate_change" | "close";
}

export interface TopReceiverRow {
  account: string;
  total_incoming_rate_per_sec: string;
  sender_count: number;
}

export interface TopSenderRow {
  account: string;
  total_rate_per_sec: string;
  receiver_count: number;
}

/** A single indexed contract event row. */
export interface IndexedEvent {
  id: string;
  event_type: EventType;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  /** Proposal id for escrow proposal events; null/absent for schedule events. */
  proposal_id?: number | null;
  grantor: string | null;
  beneficiary: string | null;
  /** Claimed amount as a decimal string (bigint); null for non-claim events. */
  amount: string | null;
  /** Asset contract address when available. */
  token: string | null;
  /** Original schedule amount as a decimal string (bigint); null for non-create events. */
  created_amount: string | null;
  raw_topics: string; // JSON
  raw_value: string;  // JSON
  created_at: number; // Unix seconds
}

/** Parameters accepted by the events query endpoint. */
export interface EventQueryParams {
  /** Match events where grantor OR beneficiary equals this address. */
  address?: string;
  grantor?: string;
  beneficiary?: string;
  event_type?: EventType | string;
  schedule_id?: number;
  from_ledger?: number;
  to_ledger?: number;
  limit?: number;  // max 200
  offset?: number;
  network?: NetworkName;
}

export interface TvlAssetStats {
  asset: string;
  total_created: string;
  total_claimed: string;
  total_revoked_unvested: string;
  total_value_locked: string;
  active_schedules: number;
}

export interface TvlStats {
  network: NetworkName;
  assets: TvlAssetStats[];
  total_value_locked: string;
  last_updated: number;
}

/** A single indexed give event row. */
export interface GiveEvent {
  id: string;
  sender: string;
  receiver: string;
  token: string;
  amount: string;
  timestamp: number;
  ledger: number;
  raw_topics: string;
  raw_value: string;
  created_at: number;
}

/** Parameters accepted by the GET /gives endpoint. */
export interface GiveQueryParams {
  sender?: string;
  receiver?: string;
  token?: string;
  /** ISO 8601 date/timestamp — lower bound on ledger_closed_at */
  from?: string;
  /** ISO 8601 date/timestamp — upper bound on ledger_closed_at */
  to?: string;
  /** Max 100. Default 20. */
  limit?: number;
  /** Pagination cursor: last seen `id` from previous page */
  cursor?: string;
  network?: NetworkName;
}
