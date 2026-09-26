-- Materialized daily analytics snapshots, incrementally folded in by the
-- indexer as new ledgers are processed (see indexer/src/analytics.ts).
--
-- Mirrors the SQLite tables added to indexer/schema.sql so both deployment
-- targets expose the same columns.
--
-- Rollback:
--   DROP TABLE IF EXISTS grantor_daily_stats CASCADE;
--   DROP TABLE IF EXISTS token_daily_tvl CASCADE;
--   DROP TABLE IF EXISTS schedule_daily_snapshots CASCADE;
--   DROP TABLE IF EXISTS analytics_watermark CASCADE;

CREATE TABLE IF NOT EXISTS schedule_daily_snapshots (
  schedule_id           BIGINT NOT NULL,
  day                   DATE NOT NULL,
  total_vested_stroops  NUMERIC(39, 0) NOT NULL DEFAULT 0,
  total_claimed_stroops NUMERIC(39, 0) NOT NULL DEFAULT 0,
  claimable_stroops     NUMERIC(39, 0) NOT NULL DEFAULT 0,
  locked_stroops        NUMERIC(39, 0) NOT NULL DEFAULT 0,
  PRIMARY KEY (schedule_id, day)
);

CREATE INDEX IF NOT EXISTS idx_schedule_daily_snapshots_day
  ON schedule_daily_snapshots (day);

CREATE TABLE IF NOT EXISTS token_daily_tvl (
  token_address         TEXT NOT NULL,
  day                   DATE NOT NULL,
  total_locked_stroops  NUMERIC(39, 0) NOT NULL DEFAULT 0,
  active_schedule_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (token_address, day)
);

CREATE INDEX IF NOT EXISTS idx_token_daily_tvl_day ON token_daily_tvl (day);

CREATE TABLE IF NOT EXISTS grantor_daily_stats (
  grantor_address           TEXT NOT NULL,
  day                       DATE NOT NULL,
  active_schedule_count     INT NOT NULL DEFAULT 0,
  total_distributed_stroops NUMERIC(39, 0) NOT NULL DEFAULT 0,
  PRIMARY KEY (grantor_address, day)
);

CREATE INDEX IF NOT EXISTS idx_grantor_daily_stats_day ON grantor_daily_stats (day);

-- Tracks the highest ledger already folded into the snapshot tables, per
-- network, so the materialization worker only processes new events on each
-- run instead of rescanning raw_events. A separate row is kept for
-- late-arriving replay events, whose ledger is below the watermark but still
-- needs its own targeted UPSERT (handled in application code, not here).
CREATE TABLE IF NOT EXISTS analytics_watermark (
  network            TEXT PRIMARY KEY,
  last_ledger        BIGINT NOT NULL DEFAULT 0,
  last_materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
