#!/bin/sh
set -eu

if [ -z "${POSTGRES_APP_PASSWORD:-}" ]; then
  echo 'POSTGRES_APP_PASSWORD is required' >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE exchange_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE exchange TO exchange_app;
SQL
