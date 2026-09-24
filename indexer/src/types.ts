import type { NetworkName } from "./config";

export type EventType = "schedule_created" | "claimed" | "revoked" | "given" | "unknown";

/** A single indexed contract event row. */
export interface IndexedEvent {
  id: string;
  event_type: EventType;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
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
