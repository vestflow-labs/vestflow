-- VestFlow PostgreSQL Schema Migration
-- Adds support for PostgreSQL alongside existing SQLite implementation
-- Includes vesting_schedules, claim_events, and revoke_events tables

-- Enable UUID extension for potential future use
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Vesting schedules table
-- Stores the current state of each vesting schedule
CREATE TABLE IF NOT EXISTS vesting_schedules (
  schedule_id BIGINT PRIMARY KEY,
  grantor VARCHAR(56) NOT NULL,
  beneficiary VARCHAR(56) NOT NULL,
  token VARCHAR(56) NOT NULL,
  total_amount NUMERIC(38, 0) NOT NULL,
  claimed NUMERIC(38, 0) NOT NULL DEFAULT 0,
  start_time BIGINT NOT NULL,
  duration BIGINT NOT NULL,
  cliff_duration BIGINT NOT NULL DEFAULT 0,
  vesting_kind VARCHAR(20) NOT NULL CHECK (vesting_kind IN ('Linear', 'Cliff', 'LinearWithCliff')),
  revocable BOOLEAN NOT NULL DEFAULT false,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ledger_created BIGINT NOT NULL,
  ledger_closed_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Indexes for vesting_schedules
CREATE INDEX IF NOT EXISTS idx_vesting_schedules_grantor ON vesting_schedules(grantor);
CREATE INDEX IF NOT EXISTS idx_vesting_schedules_beneficiary ON vesting_schedules(beneficiary);
CREATE INDEX IF NOT EXISTS idx_vesting_schedules_token ON vesting_schedules(token);
CREATE INDEX IF NOT EXISTS idx_vesting_schedules_revoked ON vesting_schedules(revoked);
CREATE INDEX IF NOT EXISTS idx_vesting_schedules_created_at ON vesting_schedules(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vesting_schedules_grantor_beneficiary ON vesting_schedules(grantor, beneficiary);

-- Claim events table
-- Records all claim transactions
CREATE TABLE IF NOT EXISTS claim_events (
  id VARCHAR(100) PRIMARY KEY,
  schedule_id BIGINT NOT NULL,
  beneficiary VARCHAR(56) NOT NULL,
  amount NUMERIC(38, 0) NOT NULL,
  ledger BIGINT NOT NULL,
  ledger_closed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  transaction_hash VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  raw_topics TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  CONSTRAINT fk_claim_schedule FOREIGN KEY (schedule_id) 
    REFERENCES vesting_schedules(schedule_id) 
    ON DELETE CASCADE
);

-- Indexes for claim_events
CREATE INDEX IF NOT EXISTS idx_claim_events_schedule_id ON claim_events(schedule_id);
CREATE INDEX IF NOT EXISTS idx_claim_events_beneficiary ON claim_events(beneficiary);
CREATE INDEX IF NOT EXISTS idx_claim_events_ledger ON claim_events(ledger DESC);
CREATE INDEX IF NOT EXISTS idx_claim_events_created_at ON claim_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_events_beneficiary_schedule ON claim_events(beneficiary, schedule_id);

-- Revoke events table
-- Records all revoke transactions
CREATE TABLE IF NOT EXISTS revoke_events (
  id VARCHAR(100) PRIMARY KEY,
  schedule_id BIGINT NOT NULL,
  grantor VARCHAR(56) NOT NULL,
  revoked_amount NUMERIC(38, 0) NOT NULL,
  ledger BIGINT NOT NULL,
  ledger_closed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  transaction_hash VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  raw_topics TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  CONSTRAINT fk_revoke_schedule FOREIGN KEY (schedule_id) 
    REFERENCES vesting_schedules(schedule_id) 
    ON DELETE CASCADE
);

-- Indexes for revoke_events
CREATE INDEX IF NOT EXISTS idx_revoke_events_schedule_id ON revoke_events(schedule_id);
CREATE INDEX IF NOT EXISTS idx_revoke_events_grantor ON revoke_events(grantor);
CREATE INDEX IF NOT EXISTS idx_revoke_events_ledger ON revoke_events(ledger DESC);
CREATE INDEX IF NOT EXISTS idx_revoke_events_created_at ON revoke_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revoke_events_grantor_schedule ON revoke_events(grantor, schedule_id);

-- Checkpoint table for tracking sync progress
CREATE TABLE IF NOT EXISTS checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger BIGINT NOT NULL DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Insert initial checkpoint if not exists
INSERT INTO checkpoint (id, last_ledger, last_updated) 
VALUES (1, 0, NOW())
ON CONFLICT (id) DO NOTHING;

-- Analytics cache table
CREATE TABLE IF NOT EXISTS analytics_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_value_locked NUMERIC(38, 0) NOT NULL DEFAULT 0,
  total_claimed NUMERIC(38, 0) NOT NULL DEFAULT 0,
  active_schedules INTEGER NOT NULL DEFAULT 0,
  unique_beneficiaries INTEGER NOT NULL DEFAULT 0,
  total_schedules_created INTEGER NOT NULL DEFAULT 0,
  total_revoked INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Insert initial analytics cache if not exists
INSERT INTO analytics_cache (id) 
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Daily stats for trend tracking
CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE NOT NULL PRIMARY KEY,
  total_value_locked NUMERIC(38, 0) NOT NULL,
  total_claimed NUMERIC(38, 0) NOT NULL,
  active_schedules INTEGER NOT NULL,
  unique_beneficiaries INTEGER NOT NULL,
  total_schedules_created INTEGER NOT NULL,
  total_revoked INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for daily stats
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date DESC);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on vesting_schedules
CREATE TRIGGER update_vesting_schedules_updated_at
  BEFORE UPDATE ON vesting_schedules
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE vesting_schedules IS 'Current state of all vesting schedules indexed from the blockchain';
COMMENT ON TABLE claim_events IS 'Historical record of all token claims from vesting schedules';
COMMENT ON TABLE revoke_events IS 'Historical record of all schedule revocations';
COMMENT ON COLUMN vesting_schedules.schedule_id IS 'Unique schedule identifier from the smart contract';
COMMENT ON COLUMN vesting_schedules.grantor IS 'Stellar address of the account that created the schedule';
COMMENT ON COLUMN vesting_schedules.beneficiary IS 'Stellar address of the account receiving vested tokens';
COMMENT ON COLUMN vesting_schedules.total_amount IS 'Total tokens locked in the schedule (in stroops)';
COMMENT ON COLUMN vesting_schedules.claimed IS 'Total tokens already claimed by beneficiary';

-- Beneficiary index table for O(1) lookup of schedules by recipient address
-- Mirrors the BeneficiarySchedules(Address) storage in the smart contract
CREATE TABLE IF NOT EXISTS beneficiary_schedules (
  beneficiary VARCHAR(56) NOT NULL,
  schedule_id BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (beneficiary, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_beneficiary_schedules_beneficiary ON beneficiary_schedules(beneficiary);

COMMENT ON TABLE beneficiary_schedules IS 'Index mapping beneficiary addresses to their schedule IDs for O(1) lookup';

CREATE TABLE IF NOT EXISTS current_streams (
  account        VARCHAR(56) NOT NULL,
  token          VARCHAR(56) NOT NULL,
  receivers_json JSONB NOT NULL,
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (account, token)
);

CREATE TABLE IF NOT EXISTS stream_history (
  id        VARCHAR(160) PRIMARY KEY,
  event_id  VARCHAR(100) NOT NULL,
  sender    VARCHAR(56) NOT NULL,
  receiver  VARCHAR(56) NOT NULL,
  token     VARCHAR(56) NOT NULL,
  ledger    BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  old_rate  NUMERIC(38, 0) NOT NULL,
  new_rate  NUMERIC(38, 0) NOT NULL,
  action    VARCHAR(20) NOT NULL CHECK (action IN ('open', 'rate_change', 'close'))
);

CREATE INDEX IF NOT EXISTS idx_stream_history_lookup
  ON stream_history (sender, receiver, token, ledger, id);

CREATE TABLE IF NOT EXISTS gives (
  id             VARCHAR(100) PRIMARY KEY,
  sender         VARCHAR(56) NOT NULL,
  receiver       VARCHAR(56) NOT NULL,
  token          VARCHAR(56) NOT NULL,
  amount_stroops NUMERIC(38, 0) NOT NULL,
  ledger         BIGINT NOT NULL,
  timestamp      TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gives_sender_timestamp
  ON gives (sender, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gives_receiver_timestamp
  ON gives (receiver, timestamp DESC, id DESC);

CREATE TABLE IF NOT EXISTS collected_totals (
  account                  VARCHAR(56) NOT NULL,
  token                    VARCHAR(56) NOT NULL,
  total_collected_stroops  NUMERIC(38, 0) NOT NULL DEFAULT 0,
  updated_at               TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (account, token)
);

COMMENT ON TABLE current_streams IS 'Current stream receiver configuration projected from stream_set events';
COMMENT ON TABLE gives IS 'Append-only give history projected from given events';
COMMENT ON TABLE collected_totals IS 'Per-account collected totals projected from collected events';
