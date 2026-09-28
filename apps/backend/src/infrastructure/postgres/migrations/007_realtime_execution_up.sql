CREATE TABLE realtime_commands (
  command_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  identity_key TEXT NOT NULL,
  idempotency_key_digest TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT NOT NULL REFERENCES realtime_instruments(id),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity NUMERIC(78,18) NOT NULL CHECK (quantity > 0),
  expected_quote_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'FILLED'),
  public_result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (identity_key, idempotency_key_digest)
);

CREATE INDEX realtime_commands_owner_created_idx
  ON realtime_commands(owner_id, created_at DESC, order_id);

CREATE TABLE realtime_execution_quotes (
  order_id TEXT PRIMARY KEY REFERENCES realtime_commands(order_id),
  quote_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'TwelveData'),
  provider_symbol TEXT NOT NULL,
  exchange TEXT,
  price NUMERIC(78,18) NOT NULL CHECK (price > 0),
  price_type TEXT NOT NULL CHECK (price_type = 'LAST'),
  provider_timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  checksum TEXT NOT NULL,
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1)
);

CREATE TABLE realtime_executions (
  execution_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES realtime_commands(order_id),
  quote_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity NUMERIC(78,18) NOT NULL CHECK (quantity > 0),
  price NUMERIC(78,18) NOT NULL CHECK (price > 0),
  notional NUMERIC(78,18) NOT NULL CHECK (notional > 0),
  fee NUMERIC(78,18) NOT NULL CHECK (fee >= 0),
  user_account_id TEXT NOT NULL REFERENCES accounts(id),
  liquidity_account_id TEXT NOT NULL REFERENCES accounts(id),
  settlement_operation_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE realtime_execution_controls (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  paused BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO realtime_execution_controls(id, paused) VALUES (true, true);

CREATE TRIGGER realtime_execution_quotes_are_immutable
  BEFORE UPDATE OR DELETE ON realtime_execution_quotes
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_change();
CREATE TRIGGER realtime_executions_are_immutable
  BEFORE UPDATE OR DELETE ON realtime_executions
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_change();

REVOKE UPDATE, DELETE ON realtime_execution_quotes FROM PUBLIC;
REVOKE UPDATE, DELETE ON realtime_executions FROM PUBLIC;
