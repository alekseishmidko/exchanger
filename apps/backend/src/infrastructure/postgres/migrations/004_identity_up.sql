CREATE TABLE identity_users (
  id TEXT PRIMARY KEY DEFAULT ('usr_' || gen_random_uuid()::text),
  email_normalized TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  roles TEXT[] NOT NULL DEFAULT ARRAY['USER']::TEXT[],
  scopes TEXT[] NOT NULL DEFAULT ARRAY['profile:read','profile:write','sessions:manage','trading:read','trading:write']::TEXT[],
  email_verified_at TIMESTAMPTZ,
  password_reset_required BOOLEAN NOT NULL DEFAULT FALSE,
  security_version INTEGER NOT NULL DEFAULT 1 CHECK (security_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT identity_users_email_normalized CHECK (email_normalized = lower(email_normalized))
);

CREATE UNIQUE INDEX identity_users_email_ci_unique ON identity_users (lower(email_normalized));

CREATE TABLE identity_challenges (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('EMAIL_VERIFY','PASSWORD_RESET')),
  token_digest TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  security_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX identity_challenges_expiry_idx ON identity_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE machine_api_keys (
  key_id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('USER','SERVICE','SYSTEM')),
  role TEXT NOT NULL CHECK (role IN ('trader','admin','risk_manager','auditor','support')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX machine_api_keys_owner_idx ON machine_api_keys (owner_id, status, expires_at);

CREATE TABLE identity_admin_commands (
  actor_id TEXT NOT NULL,
  idempotency_key_digest TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, idempotency_key_digest)
);

REVOKE SELECT (password_hash) ON identity_users FROM PUBLIC;
REVOKE SELECT (secret_digest) ON machine_api_keys FROM PUBLIC;
REVOKE SELECT (token_digest) ON identity_challenges FROM PUBLIC;
