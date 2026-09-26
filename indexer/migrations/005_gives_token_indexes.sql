-- Composite indexes on gives for GET /gives filtered by sender= or
-- receiver= together with token=, so those queries read the index in
-- result order instead of scanning the table.
--
-- Mirrors the SQLite indexes added to indexer/schema.sql.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_gives_receiver_token_timestamp;
--   DROP INDEX IF EXISTS idx_gives_sender_token_timestamp;

CREATE INDEX IF NOT EXISTS idx_gives_sender_token_timestamp
  ON gives (sender, token, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gives_receiver_token_timestamp
  ON gives (receiver, token, timestamp DESC, id DESC);
