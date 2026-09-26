-- Hourly per-token summary of active Drips streams, written by the
-- materialization worker (see indexer/src/analytics.ts) for the streaming
-- TVL chart. Hours the worker did not run in carry the previous hour's
-- values forward.
--
-- Mirrors the SQLite table added to indexer/schema.sql so both deployment
-- targets expose the same columns.
--
-- Rollback:
--   DROP TABLE IF EXISTS stream_hourly_snapshots CASCADE;

CREATE TABLE IF NOT EXISTS stream_hourly_snapshots (
  token               TEXT NOT NULL,
  hour                TIMESTAMPTZ NOT NULL,
  active_stream_count INT NOT NULL DEFAULT 0,
  total_rate_per_sec  NUMERIC(39, 0) NOT NULL DEFAULT 0,
  total_balance       NUMERIC(39, 0) NOT NULL DEFAULT 0,
  PRIMARY KEY (token, hour)
);
