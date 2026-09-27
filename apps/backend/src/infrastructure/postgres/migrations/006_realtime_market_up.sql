CREATE TABLE realtime_instruments (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'TwelveData'),
  provider_symbol TEXT NOT NULL,
  display_symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('CRYPTO', 'FOREX', 'STOCK', 'COMMODITY')),
  exchange TEXT,
  mic_code TEXT,
  base_asset_id TEXT NOT NULL,
  quote_asset_id TEXT NOT NULL,
  price_enabled BOOLEAN NOT NULL DEFAULT false,
  trade_enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  synced_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, provider_symbol, exchange)
);

CREATE INDEX realtime_instruments_catalog_idx
  ON realtime_instruments (asset_class, status, id);
CREATE INDEX realtime_instruments_streamable_idx
  ON realtime_instruments (status, price_enabled) WHERE price_enabled=true;

CREATE TABLE realtime_instrument_staging (
  sync_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  display_symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('CRYPTO', 'FOREX', 'STOCK', 'COMMODITY')),
  exchange TEXT,
  mic_code TEXT,
  base_asset_id TEXT NOT NULL,
  quote_asset_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sync_id, id)
);

CREATE TABLE realtime_catalog_sync_runs (
  id TEXT PRIMARY KEY,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('CRYPTO', 'FOREX', 'STOCK', 'COMMODITY')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  received_count INTEGER NOT NULL DEFAULT 0 CHECK (received_count >= 0),
  inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  deactivated_count INTEGER NOT NULL DEFAULT 0 CHECK (deactivated_count >= 0),
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ
);

REVOKE UPDATE, DELETE ON realtime_catalog_sync_runs FROM PUBLIC;
