DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_users) OR EXISTS (SELECT 1 FROM machine_api_keys) THEN
    RAISE EXCEPTION 'identity migration is forward-only while credential metadata exists';
  END IF;
END;
$$;

DROP TABLE IF EXISTS identity_admin_commands;
DROP TABLE IF EXISTS machine_api_keys;
DROP TABLE IF EXISTS identity_challenges;
DROP TABLE IF EXISTS identity_users;
