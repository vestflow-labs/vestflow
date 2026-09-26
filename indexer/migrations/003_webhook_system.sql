-- Production webhook delivery system: registrations, signed deliveries,
-- exponential-backoff retries and a dead-letter queue.
--
-- Mirrors the SQLite tables in indexer/schema.sql so both deployment
-- targets expose the same columns and state machine.
--
-- Rollback:
--   DROP TABLE IF EXISTS webhook_deliveries CASCADE;
--   DROP TABLE IF EXISTS webhook_registrations CASCADE;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS webhook_registrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address    VARCHAR(56) NOT NULL,
  endpoint_url     TEXT NOT NULL,
  -- scrypt hash of the signing secret; the plaintext is never stored.
  secret_hash      TEXT NOT NULL,
  -- AES-256-GCM ciphertext of the secret (key: WEBHOOK_ENCRYPTION_KEY),
  -- decrypted in memory only to sign outgoing requests.
  secret_encrypted TEXT NOT NULL,
  event_types      TEXT[] NOT NULL,
  challenge        TEXT,
  verified_at      TIMESTAMPTZ,
  disabled_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_reg_owner
  ON webhook_registrations (owner_address);
CREATE INDEX IF NOT EXISTS idx_webhook_reg_active
  ON webhook_registrations (verified_at, disabled_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  -- Stable delivery ID: identical across every retry attempt so receivers
  -- can deduplicate on X-VestFlow-Delivery-ID.
  id               UUID PRIMARY KEY,
  registration_id  UUID NOT NULL REFERENCES webhook_registrations (id) ON DELETE CASCADE,
  event_id         TEXT NOT NULL,
  event_type       VARCHAR(64) NOT NULL,
  payload          JSONB NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_flight',
    'delivered',
    'failed',
    'dead_lettered'
  )),
  attempt_count    INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT,
  last_status_code INT,
  claimed_at       TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (registration_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_registration
  ON webhook_deliveries (registration_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON webhook_deliveries (event_id);

COMMENT ON TABLE webhook_registrations IS
  'HTTP endpoints subscribed to VestFlow contract events; events flow only after the handshake sets verified_at';
COMMENT ON TABLE webhook_deliveries IS
  'Durable per-endpoint delivery queue: pending -> in_flight -> delivered | failed | dead_lettered';
