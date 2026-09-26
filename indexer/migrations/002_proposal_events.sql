-- Index escrow proposal events emitted by propose/ack/fund/expire entrypoints.

ALTER TABLE vesting_schedules
  ADD COLUMN IF NOT EXISTS proposal_id BIGINT;

CREATE TABLE IF NOT EXISTS proposal_events (
  id VARCHAR(100) PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL CHECK (event_type IN (
    'proposal_created',
    'proposal_acknowledged',
    'proposal_activated',
    'proposal_expired'
  )),
  proposal_id BIGINT NOT NULL,
  schedule_id BIGINT,
  grantor VARCHAR(56),
  beneficiary VARCHAR(56),
  token VARCHAR(56),
  amount NUMERIC(38, 0),
  ledger BIGINT NOT NULL,
  ledger_closed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  raw_topics TEXT NOT NULL,
  raw_value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_id ON proposal_events(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_events_schedule_id ON proposal_events(schedule_id);
CREATE INDEX IF NOT EXISTS idx_proposal_events_grantor ON proposal_events(grantor);
CREATE INDEX IF NOT EXISTS idx_proposal_events_beneficiary ON proposal_events(beneficiary);
CREATE INDEX IF NOT EXISTS idx_proposal_events_type ON proposal_events(event_type);

COMMENT ON TABLE proposal_events IS 'Escrow proposal lifecycle events indexed from the VestFlow contract';
