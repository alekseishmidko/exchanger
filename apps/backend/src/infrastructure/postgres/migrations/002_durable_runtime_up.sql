CREATE TABLE command_journal (
  command_id TEXT PRIMARY KEY,
  idempotency_key_digest TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  command_payload JSONB NOT NULL,
  owner_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('PLACE_ORDER', 'CANCEL_ORDER')),
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'ACCEPTED', 'PROCESSING', 'APPLIED', 'REJECTED', 'RECOVERY_REQUIRED')),
  public_result JSONB,
  correlation_id TEXT,
  causation_id TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (instrument_id, sequence)
);

CREATE INDEX command_journal_owner_created_idx
  ON command_journal (owner_id, accepted_at, command_id);
CREATE INDEX command_journal_status_updated_idx
  ON command_journal (status, updated_at);

CREATE TABLE command_status_history (
  command_id TEXT NOT NULL REFERENCES command_journal(command_id),
  transition_number SMALLINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'ACCEPTED', 'PROCESSING', 'APPLIED', 'REJECTED', 'RECOVERY_REQUIRED')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason_code TEXT,
  PRIMARY KEY (command_id, transition_number)
);

CREATE TABLE api_idempotency_records (
  identity_key TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  command_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED')),
  public_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '30 days'),
  PRIMARY KEY (identity_key, key_digest),
  CHECK ((status = 'APPLIED' AND public_result IS NOT NULL) OR status <> 'APPLIED')
);

CREATE INDEX api_idempotency_expiry_idx ON api_idempotency_records (expires_at);

CREATE TABLE outbox_events (
  event_offset BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code TEXT
);

CREATE INDEX outbox_pending_idx
  ON outbox_events (next_attempt_at, event_offset)
  WHERE published_at IS NULL;

CREATE TABLE consumer_offsets (
  consumer_name TEXT PRIMARY KEY,
  committed_offset BIGINT NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE processed_events (
  consumer_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE dead_letter_events (
  consumer_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_offset BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  error_code TEXT NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  replayed_at TIMESTAMPTZ,
  replayed_by TEXT,
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE ledger_operations (
  operation_id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  compensation_for TEXT REFERENCES ledger_operations(operation_id),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (compensation_for IS NULL OR compensation_for <> operation_id)
);

CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES ledger_operations(operation_id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  amount NUMERIC(78, 18) NOT NULL CHECK (amount > 0),
  remaining_amount NUMERIC(78, 18) NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= amount),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'SETTLED')),
  release_operation_id TEXT REFERENCES ledger_operations(operation_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE audit_records (
  id TEXT PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  command_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  retain_until TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '7 years')
);

CREATE INDEX audit_records_command_idx ON audit_records (command_id, sequence);
CREATE INDEX audit_records_target_idx ON audit_records (target_id, sequence);
REVOKE UPDATE, DELETE ON audit_records FROM PUBLIC;
REVOKE UPDATE, DELETE ON postings FROM PUBLIC;

CREATE FUNCTION prevent_immutable_row_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable rows cannot be updated or deleted' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_are_immutable
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_change();

CREATE TRIGGER audit_records_are_immutable
  BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_change();

CREATE FUNCTION assert_balanced_ledger_operation() RETURNS trigger AS $$
DECLARE
  unbalanced_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unbalanced_count
  FROM (
    SELECT asset_id
    FROM postings
    WHERE operation_id = NEW.operation_id
    GROUP BY asset_id
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
  ) AS unbalanced;
  IF unbalanced_count <> 0 THEN
    RAISE EXCEPTION 'posting set is not balanced for operation %', NEW.operation_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_must_balance
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_balanced_ledger_operation();

CREATE FUNCTION enforce_command_status_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'RECEIVED' AND NEW.status IN ('ACCEPTED', 'REJECTED', 'RECOVERY_REQUIRED')) OR
    (OLD.status = 'ACCEPTED' AND NEW.status IN ('PROCESSING', 'REJECTED', 'RECOVERY_REQUIRED')) OR
    (OLD.status = 'PROCESSING' AND NEW.status IN ('APPLIED', 'REJECTED', 'RECOVERY_REQUIRED')) OR
    (OLD.status = 'RECOVERY_REQUIRED' AND NEW.status IN ('PROCESSING', 'APPLIED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid command status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER command_status_is_monotonic
  BEFORE UPDATE OF status ON command_journal
  FOR EACH ROW EXECUTE FUNCTION enforce_command_status_transition();

CREATE FUNCTION record_command_status_transition() RETURNS trigger AS $$
BEGIN
  INSERT INTO command_status_history (command_id, transition_number, status)
  VALUES (
    NEW.command_id,
    COALESCE((SELECT MAX(transition_number) + 1 FROM command_status_history WHERE command_id = NEW.command_id), 1),
    NEW.status
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER command_status_history_on_insert
  AFTER INSERT ON command_journal
  FOR EACH ROW EXECUTE FUNCTION record_command_status_transition();

CREATE TRIGGER command_status_history_on_update
  AFTER UPDATE OF status ON command_journal
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION record_command_status_transition();
