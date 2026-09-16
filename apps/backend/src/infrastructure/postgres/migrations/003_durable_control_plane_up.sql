CREATE TABLE partition_leases (
  instrument_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_epoch BIGINT NOT NULL CHECK (fencing_epoch > 0),
  lease_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX partition_leases_expiry_idx ON partition_leases (lease_until);

CREATE TABLE sequencer_partitions (
  instrument_id TEXT PRIMARY KEY,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  durable_high_watermark BIGINT NOT NULL DEFAULT 0 CHECK (durable_high_watermark >= 0),
  fencing_epoch BIGINT NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
  recovery_status TEXT NOT NULL DEFAULT 'READY'
    CHECK (recovery_status IN ('RECOVERING', 'READY', 'DRAINING')),
  admission_open BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE trading_snapshots (
  snapshot_id BIGSERIAL PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  last_sequence BIGINT NOT NULL CHECK (last_sequence >= 0),
  boundary_event_offset BIGINT NOT NULL CHECK (boundary_event_offset >= 0),
  fencing_epoch BIGINT NOT NULL CHECK (fencing_epoch > 0),
  payload JSONB NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (instrument_id, last_sequence)
);

CREATE INDEX trading_snapshots_restore_idx
  ON trading_snapshots (instrument_id, last_sequence DESC);

CREATE TABLE admission_controls (
  control_type TEXT NOT NULL
    CHECK (control_type IN ('GLOBAL', 'USER', 'ACCOUNT', 'INSTRUMENT')),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ALLOW', 'FROZEN', 'PAUSED', 'OPEN')),
  version BIGINT NOT NULL CHECK (version > 0),
  effective_at TIMESTAMPTZ NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (control_type, target_id)
);

CREATE TABLE admission_control_history (
  command_id TEXT PRIMARY KEY,
  control_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version BIGINT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  compensation_for TEXT REFERENCES admission_control_history(command_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE projection_versions (
  projection_name TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  status TEXT NOT NULL CHECK (status IN ('BUILDING', 'ACTIVE', 'RETIRED')),
  applied_sequence BIGINT NOT NULL DEFAULT 0 CHECK (applied_sequence >= 0),
  source_sequence BIGINT NOT NULL DEFAULT 0 CHECK (source_sequence >= applied_sequence),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  activated_at TIMESTAMPTZ,
  PRIMARY KEY (projection_name, version)
);

CREATE UNIQUE INDEX projection_single_active_idx
  ON projection_versions (projection_name) WHERE status = 'ACTIVE';

INSERT INTO projection_versions
  (projection_name, version, schema_version, status, activated_at)
VALUES ('query-api', 1, 1, 'ACTIVE', clock_timestamp());

CREATE TABLE projection_processed_events (
  projection_name TEXT NOT NULL,
  projection_version BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (projection_name, projection_version, event_id),
  UNIQUE (projection_name, projection_version, sequence),
  FOREIGN KEY (projection_name, projection_version)
    REFERENCES projection_versions(projection_name, version) ON DELETE CASCADE
);

CREATE TABLE projection_orders (
  projection_version BIGINT NOT NULL,
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  status TEXT NOT NULL,
  remaining_quantity TEXT NOT NULL,
  updated_at_sequence BIGINT NOT NULL,
  PRIMARY KEY (projection_version, order_id)
);

CREATE INDEX projection_orders_owner_idx
  ON projection_orders (projection_version, user_id, updated_at_sequence, order_id);

CREATE TABLE projection_trades (
  projection_version BIGINT NOT NULL,
  trade_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  user_ids TEXT[] NOT NULL,
  maker_order_id TEXT NOT NULL,
  taker_order_id TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  PRIMARY KEY (projection_version, trade_id)
);

CREATE INDEX projection_trades_owner_idx
  ON projection_trades USING GIN (user_ids);

CREATE TABLE projection_balances (
  projection_version BIGINT NOT NULL,
  account_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  available TEXT NOT NULL,
  reserved TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  PRIMARY KEY (projection_version, account_id, asset_id)
);

CREATE INDEX projection_balances_owner_idx
  ON projection_balances (projection_version, account_id, sequence, asset_id);

REVOKE UPDATE, DELETE ON admission_control_history FROM PUBLIC;

CREATE TRIGGER admission_control_history_is_immutable
  BEFORE UPDATE OR DELETE ON admission_control_history
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_change();
