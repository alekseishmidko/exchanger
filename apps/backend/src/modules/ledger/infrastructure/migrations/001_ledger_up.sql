CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  scale SMALLINT NOT NULL CHECK (scale >= 0 AND scale <= 18)
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE balances (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  available NUMERIC(78, 18) NOT NULL CHECK (available >= 0),
  reserved NUMERIC(78, 18) NOT NULL CHECK (reserved >= 0),
  PRIMARY KEY (account_id, asset_id),
  CHECK (reserved >= 0)
);

CREATE TABLE postings (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount NUMERIC(78, 18) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX postings_operation_idx ON postings(operation_id);

CREATE TABLE idempotency_records (
  operation_id TEXT PRIMARY KEY,
  posting_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
