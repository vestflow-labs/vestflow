-- VestFlow Event Indexer — SQLite schema
-- Idempotent: safe to re-run on an existing database.

CREATE TABLE IF NOT EXISTS schedule_events (
  -- Stellar-assigned event ID: "<ledger>-<txIndex>-<eventIndex>"
  id TEXT PRIMARY KEY,

  event_type TEXT NOT NULL CHECK (event_type IN (
    'schedule_created',
    'claimed',
    'revoked',
    'proposal_created',
    'proposal_acknowledged',
    'proposal_activated',
    'proposal_expired',
    'stream_set',
    'given',
    'collected',
    'unknown'
  )),

  ledger            INTEGER NOT NULL,
  ledger_closed_at  TEXT    NOT NULL, -- ISO 8601 (from Stellar RPC)

  schedule_id INTEGER,    -- parsed from topic[1]
  proposal_id INTEGER,    -- parsed from topic[1] for proposal_* events
  grantor     TEXT,       -- parsed from topic[2] for schedule_created / revoked
  beneficiary TEXT,       -- parsed from topic[2] for claimed; topic[3] for created
  amount      TEXT,       -- bigint as decimal string (claimed events only)
  token       TEXT,       -- parsed Stellar asset contract address when available
  created_amount TEXT,    -- bigint as decimal string (schedule_created events only)

  -- Vesting curve parameters, captured from schedule_created events only.
  -- Used by the analytics materialization worker to compute vested amounts
  -- without a contract call. NULL for every other event type, and for
  -- schedule_created events whose value shape predates this capture.
  start_time    INTEGER,  -- unix seconds
  duration      INTEGER,  -- seconds
  cliff_duration INTEGER, -- seconds (0 when the schedule has no cliff)
  vesting_kind  TEXT,     -- 'Linear' | 'LinearWithCliff' | 'Cliff' | 'Graded' | other contract variant

  -- Set once the analytics materialization worker has folded this event
  -- into schedule_daily_snapshots / token_daily_tvl / grantor_daily_stats.
  -- NULL means "not yet materialized" — this is how late-arriving replay
  -- events (inserted out of ledger order) get picked up and targeted at
  -- their own past day, independent of the highest ledger seen so far.
  materialized_at INTEGER,

  raw_topics TEXT NOT NULL, -- JSON array of native-decoded topic values
  raw_value  TEXT NOT NULL, -- JSON of native-decoded event value

  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_grantor      ON schedule_events (grantor);
CREATE INDEX IF NOT EXISTS idx_beneficiary  ON schedule_events (beneficiary);
CREATE INDEX IF NOT EXISTS idx_schedule_id  ON schedule_events (schedule_id);
CREATE INDEX IF NOT EXISTS idx_proposal_id  ON schedule_events (proposal_id);
CREATE INDEX IF NOT EXISTS idx_event_type   ON schedule_events (event_type);
CREATE INDEX IF NOT EXISTS idx_ledger       ON schedule_events (ledger);
CREATE INDEX IF NOT EXISTS idx_token        ON schedule_events (token);
CREATE INDEX IF NOT EXISTS idx_materialized_at ON schedule_events (materialized_at);

-- NOTE: The event deduplication unique index (idx_event_dedup) is NOT defined
-- here because it requires COALESCE expressions which must be created
-- programmatically by db.ts on first open (see ensureEventDedupIndex).
-- Defining it here would create a NULL-friendly version that conflicts with
-- the COALESCE version created at runtime.

-- Singleton checkpoint row — stores the highest fully-processed ledger.
CREATE TABLE IF NOT EXISTS checkpoint (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO checkpoint (id, last_ledger) VALUES (1, 0);

-- Analytics Cache — Updated periodically with aggregate stats
CREATE TABLE IF NOT EXISTS analytics_cache (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  total_value_locked      TEXT NOT NULL DEFAULT '0',    -- bigint as string
  total_claimed           TEXT NOT NULL DEFAULT '0',    -- bigint as string
  active_schedules        INTEGER NOT NULL DEFAULT 0,
  unique_beneficiaries    INTEGER NOT NULL DEFAULT 0,
  total_schedules_created INTEGER NOT NULL DEFAULT 0,
  total_revoked           INTEGER NOT NULL DEFAULT 0,
  last_updated            INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO analytics_cache (id) VALUES (1);

-- Daily snapshot for trend tracking
CREATE TABLE IF NOT EXISTS daily_stats (
  date                    TEXT NOT NULL PRIMARY KEY,  -- YYYY-MM-DD
  total_value_locked      TEXT NOT NULL,
  total_claimed           TEXT NOT NULL,
  active_schedules        INTEGER NOT NULL,
  unique_beneficiaries    INTEGER NOT NULL,
  total_schedules_created INTEGER NOT NULL,
  total_revoked           INTEGER NOT NULL,
  created_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date);

-- TVL cache per asset, refreshed by the poller and readable by /stats/tvl.
CREATE TABLE IF NOT EXISTS tvl_stats (
  asset                  TEXT PRIMARY KEY,
  total_created          TEXT NOT NULL,
  total_claimed          TEXT NOT NULL,
  total_revoked_unvested TEXT NOT NULL,
  total_value_locked     TEXT NOT NULL,
  active_schedules       INTEGER NOT NULL,
  last_updated           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Drips indexed state ────────────────────────────────────────────────
-- These tables hold the current state projected by the Drips event
-- indexer. They intentionally model state (rather than an event log) so
-- list and stream queries remain inexpensive as the event history grows.
CREATE TABLE IF NOT EXISTS drips_lists (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL,
  owner                      TEXT NOT NULL,
  token                      TEXT NOT NULL,
  total_funding_rate_per_sec TEXT NOT NULL DEFAULT '0',
  target_rate_per_sec        TEXT NOT NULL DEFAULT '0',
  created_at                 INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_drips_lists_owner_created
  ON drips_lists (owner, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS drips_list_members (
  list_id   TEXT NOT NULL REFERENCES drips_lists(id) ON DELETE CASCADE,
  address   TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at   INTEGER,
  PRIMARY KEY (list_id, address)
);

CREATE INDEX IF NOT EXISTS idx_drips_list_members_current
  ON drips_list_members (list_id, left_at, joined_at ASC, address ASC);

-- `ended_at` is populated when a stream is closed. An elapsed estimated end
-- time also makes a stream inactive even if an end event has not arrived yet.
CREATE TABLE IF NOT EXISTS drips_streams (
  id                 TEXT PRIMARY KEY,
  account            TEXT NOT NULL,
  receiver           TEXT NOT NULL,
  token              TEXT NOT NULL,
  rate_per_second    TEXT NOT NULL,
  estimated_end_time INTEGER,
  ended_at           INTEGER,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_drips_streams_active_account
  ON drips_streams (account, ended_at, estimated_end_time, created_at DESC, id DESC);

-- Current streaming balances are keyed by account and token. A zero balance
-- is retained so the projection can be updated idempotently by the indexer.
CREATE TABLE IF NOT EXISTS drips_streaming_balances (
  account    TEXT NOT NULL,
  token      TEXT NOT NULL,
  balance    TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (account, token)
);

CREATE INDEX IF NOT EXISTS idx_drips_streaming_balances_token
  ON drips_streaming_balances (token);

CREATE TABLE IF NOT EXISTS current_streams (
  account        TEXT NOT NULL,
  token          TEXT NOT NULL,
  receivers_json TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (account, token)
);

CREATE TABLE IF NOT EXISTS gives (
  id             TEXT PRIMARY KEY,
  sender         TEXT NOT NULL,
  receiver       TEXT NOT NULL,
  token          TEXT NOT NULL,
  amount_stroops TEXT NOT NULL,
  ledger         INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gives_sender_timestamp
  ON gives (sender, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gives_receiver_timestamp
  ON gives (receiver, timestamp DESC, id DESC);

CREATE TABLE IF NOT EXISTS collected_totals (
  account                  TEXT NOT NULL,
  token                    TEXT NOT NULL,
  total_collected_stroops  TEXT NOT NULL DEFAULT '0',
  updated_at               INTEGER NOT NULL,
  PRIMARY KEY (account, token)
);

-- Notification subscriptions
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  schedule_id INTEGER NOT NULL,
  beneficiary_address TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('cliff_reached', 'claimable', 'revoked', 'all')),
  is_active INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sub_email ON notification_subscriptions (email);
CREATE INDEX IF NOT EXISTS idx_sub_schedule ON notification_subscriptions (schedule_id);
CREATE INDEX IF NOT EXISTS idx_sub_beneficiary ON notification_subscriptions (beneficiary_address);
CREATE INDEX IF NOT EXISTS idx_sub_active ON notification_subscriptions (is_active);

-- Notification events/history
CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('cliff_reached', 'claimable', 'revoked')),
  schedule_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('queued', 'sent', 'failed', 'bounced')),
  error_message TEXT,
  FOREIGN KEY (subscription_id) REFERENCES notification_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_event_sub ON notification_events (subscription_id);
CREATE INDEX IF NOT EXISTS idx_notif_event_type ON notification_events (event_type);
CREATE INDEX IF NOT EXISTS idx_notif_event_status ON notification_events (status);
CREATE INDEX IF NOT EXISTS idx_notif_event_schedule ON notification_events (schedule_id);

-- Processed notification milestones (to avoid duplicate notifications)
CREATE TABLE IF NOT EXISTS notification_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  milestone_type TEXT NOT NULL CHECK (milestone_type IN ('cliff_reached', 'fully_vested', 'revoked')),
  processed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(schedule_id, milestone_type)
);

CREATE INDEX IF NOT EXISTS idx_milestone_schedule ON notification_milestones (schedule_id);

-- App notifications — one row per (wallet, indexed event). `id` is a global,
-- monotonically increasing cursor used by the SSE stream's Last-Event-ID
-- replay and is the `id:` field of every SSE frame.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet      TEXT    NOT NULL,
  event_type  TEXT    NOT NULL,  -- VestingStarted | CliffReached | FullyVested | Claimed | Revoked | PausedSchedule | ResumedSchedule
  schedule_id INTEGER,
  event_id    TEXT    NOT NULL,  -- Stellar-assigned event id, for idempotent dedup
  ledger      INTEGER NOT NULL DEFAULT 0,
  payload     TEXT    NOT NULL,  -- JSON
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (wallet, event_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_wallet_id ON notifications (wallet, id);

-- Read state, persisted per wallet (survives browser refresh and is tied to
-- the wallet address, not the session).
CREATE TABLE IF NOT EXISTS notification_reads (
  wallet          TEXT    NOT NULL,
  notification_id INTEGER NOT NULL,
  read_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_wallet ON notification_reads (wallet);

-- Beneficiary index table for O(1) lookup of schedules by recipient address
-- Mirrors the BeneficiarySchedules(Address) storage in the smart contract
CREATE TABLE IF NOT EXISTS beneficiary_schedules (
  beneficiary TEXT NOT NULL,
  schedule_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (beneficiary, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_beneficiary_schedules_beneficiary ON beneficiary_schedules (beneficiary);

-- Web Push subscriptions
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  schedule_id INTEGER NOT NULL,
  beneficiary_address TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_push_endpoint ON web_push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS idx_push_schedule ON web_push_subscriptions (schedule_id);
CREATE INDEX IF NOT EXISTS idx_push_beneficiary ON web_push_subscriptions (beneficiary_address);
CREATE INDEX IF NOT EXISTS idx_push_active ON web_push_subscriptions (is_active);

-- Auth nonces — short-lived challenges issued to wallets before signing,
-- consumed by /api/auth/verify to prevent replay.
CREATE TABLE IF NOT EXISTS nonces (
  nonce       TEXT PRIMARY KEY,
  public_key  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,     -- ISO 8601
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nonces_public_key ON nonces (public_key);

-- ── Webhooks ──────────────────────────────────────────────────────────
-- Registered HTTP endpoints that receive indexed contract events.
-- The signing secret is never stored in plaintext: `secret_hash` is a
-- scrypt hash used to authenticate a presented secret, and
-- `secret_encrypted` is AES-256-GCM ciphertext (key: WEBHOOK_ENCRYPTION_KEY)
-- that the delivery worker decrypts in memory to sign outgoing requests.
CREATE TABLE IF NOT EXISTS webhook_registrations (
  id               TEXT PRIMARY KEY,          -- UUID
  owner_address    TEXT NOT NULL,             -- wallet address from the auth token
  endpoint_url     TEXT NOT NULL,
  secret_hash      TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  event_types      TEXT NOT NULL,             -- JSON array, e.g. ["claimed"] or ["*"]
  challenge        TEXT,                      -- pending handshake challenge, cleared on verify
  verified_at      INTEGER,                   -- unix seconds; NULL until the handshake succeeds
  disabled_at      INTEGER,                   -- unix seconds; NULL while active
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_webhook_reg_owner ON webhook_registrations (owner_address);
CREATE INDEX IF NOT EXISTS idx_webhook_reg_active
  ON webhook_registrations (verified_at, disabled_at);

-- One row per (registration, event). `id` is the X-VestFlow-Delivery-ID and
-- stays stable across every retry attempt so receivers can deduplicate.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT PRIMARY KEY,
  registration_id  TEXT NOT NULL REFERENCES webhook_registrations (id) ON DELETE CASCADE,
  event_id         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          TEXT NOT NULL,             -- JSON body sent to the endpoint
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_flight',
    'delivered',
    'failed',
    'dead_lettered'
  )),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_error       TEXT,
  last_status_code INTEGER,
  claimed_at       INTEGER,                   -- lease timestamp for in_flight rows
  delivered_at     INTEGER,
  dead_lettered_at INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (registration_id, event_id)          -- fan-out is idempotent per event
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_registration
  ON webhook_deliveries (registration_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries (event_id);

-- ── Materialized analytics snapshots ────────────────────────────────────
-- Incrementally folded in by the materialization worker (analytics.ts)
-- after each processed ledger batch. Mirrors migrations/004_analytics_snapshots.sql
-- so both deployment targets (SQLite here, Postgres there) expose the same
-- columns and the same query semantics for the /analytics/* endpoints.

CREATE TABLE IF NOT EXISTS schedule_daily_snapshots (
  schedule_id           INTEGER NOT NULL,
  day                   TEXT    NOT NULL, -- YYYY-MM-DD
  total_vested_stroops  TEXT    NOT NULL DEFAULT '0', -- bigint as string
  total_claimed_stroops TEXT    NOT NULL DEFAULT '0',
  claimable_stroops     TEXT    NOT NULL DEFAULT '0',
  locked_stroops        TEXT    NOT NULL DEFAULT '0',
  PRIMARY KEY (schedule_id, day)
);

CREATE INDEX IF NOT EXISTS idx_schedule_daily_snapshots_day ON schedule_daily_snapshots (day);
CREATE INDEX IF NOT EXISTS idx_schedule_daily_snapshots_schedule ON schedule_daily_snapshots (schedule_id);

CREATE TABLE IF NOT EXISTS token_daily_tvl (
  token_address         TEXT NOT NULL,
  day                   TEXT NOT NULL, -- YYYY-MM-DD
  total_locked_stroops  TEXT NOT NULL DEFAULT '0',
  active_schedule_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_address, day)
);

CREATE INDEX IF NOT EXISTS idx_token_daily_tvl_day ON token_daily_tvl (day);

CREATE TABLE IF NOT EXISTS grantor_daily_stats (
  grantor_address           TEXT NOT NULL,
  day                       TEXT NOT NULL, -- YYYY-MM-DD
  active_schedule_count     INTEGER NOT NULL DEFAULT 0,
  total_distributed_stroops TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (grantor_address, day)
);

CREATE INDEX IF NOT EXISTS idx_grantor_daily_stats_day ON grantor_daily_stats (day);

-- Highest ledger already folded into the snapshot tables, per network.
-- Lets the materialization worker fold in only the newest events on each
-- run instead of rescanning schedule_events from scratch.
CREATE TABLE IF NOT EXISTS analytics_watermark (
  network              TEXT PRIMARY KEY,
  last_ledger          INTEGER NOT NULL DEFAULT 0,
  last_materialized_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- ── Gap Detection and Replay ─────────────────────────────────────────
-- Tracks ledger ranges that need to be replayed when gaps are detected
-- between the last processed ledger and the current Horizon ledger.
CREATE TABLE IF NOT EXISTS replay_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ledger INTEGER NOT NULL,             -- start of ledger range (inclusive)
  to_ledger INTEGER NOT NULL,               -- end of ledger range (inclusive)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_progress', 
    'completed',
    'failed'
  )),
  completed_ledger INTEGER,                 -- progress tracking: last successfully processed ledger in range
  started_at INTEGER,                       -- unix timestamp when processing started
  completed_at INTEGER,                     -- unix timestamp when range completed or failed
  error_message TEXT,                       -- error details if status = 'failed'
  retry_count INTEGER NOT NULL DEFAULT 0,   -- number of retry attempts
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  
  -- Constraints to prevent overlapping ranges and ensure logical ordering
  CHECK (from_ledger <= to_ledger),
  CHECK (completed_ledger IS NULL OR (completed_ledger >= from_ledger AND completed_ledger <= to_ledger))
);

CREATE INDEX IF NOT EXISTS idx_replay_queue_status ON replay_queue (status);
CREATE INDEX IF NOT EXISTS idx_replay_queue_created ON replay_queue (created_at);
CREATE INDEX IF NOT EXISTS idx_replay_queue_range ON replay_queue (from_ledger, to_ledger);

-- Gap detection metadata - tracks when gap detection last ran and any issues
CREATE TABLE IF NOT EXISTS gap_detection_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_checkpoint INTEGER NOT NULL,         -- checkpoint ledger when gap detection ran
  current_ledger INTEGER NOT NULL,          -- latest ledger from Horizon
  gaps_detected INTEGER NOT NULL DEFAULT 0, -- number of gap ranges found
  checked_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_gap_detection_checked ON gap_detection_log (checked_at);

-- ── Give events ───────────────────────────────────────────────────────
-- Tracks one-shot token give events emitted by the contract.
-- Optional sender=, receiver=, token=, from=, to= filters; paginated.
CREATE TABLE IF NOT EXISTS gives (
  id          TEXT PRIMARY KEY,          -- Stellar event ID "<ledger>-<txIndex>-<eventIndex>"
  sender      TEXT NOT NULL,
  receiver    TEXT NOT NULL,
  token       TEXT NOT NULL,
  amount      TEXT NOT NULL,             -- bigint as decimal string
  timestamp   INTEGER NOT NULL,          -- ledger_closed_at as unix seconds
  ledger      INTEGER NOT NULL,
  raw_topics  TEXT NOT NULL,
  raw_value   TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_gives_sender    ON gives (sender);
CREATE INDEX IF NOT EXISTS idx_gives_receiver  ON gives (receiver);
CREATE INDEX IF NOT EXISTS idx_gives_token     ON gives (token);
CREATE INDEX IF NOT EXISTS idx_gives_timestamp ON gives (timestamp);
CREATE INDEX IF NOT EXISTS idx_gives_ledger    ON gives (ledger);
