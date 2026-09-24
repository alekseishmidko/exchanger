ALTER TABLE identity_challenges
  ADD COLUMN IF NOT EXISTS security_version INTEGER NOT NULL DEFAULT 1;

UPDATE identity_challenges c
   SET security_version = u.security_version
  FROM identity_users u
 WHERE c.user_id = u.id
   AND c.consumed_at IS NULL;

ALTER TABLE identity_users
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'profile:read','profile:write','sessions:manage','trading:read','trading:write'
  ]::TEXT[];

CREATE INDEX IF NOT EXISTS identity_challenges_user_kind_active_idx
  ON identity_challenges (user_id, kind, created_at DESC)
  WHERE consumed_at IS NULL;
