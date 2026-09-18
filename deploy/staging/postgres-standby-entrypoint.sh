#!/bin/sh
set -eu

if [ "${CHAOS_ENVIRONMENT:-}" != 'staging' ] || [ "${CHAOS_ACK:-}" != 'isolated-test-only' ]; then
  echo 'postgres standby refused to start outside isolated staging' >&2
  exit 78
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h postgres -U exchange -d exchange >/dev/null 2>&1; do sleep 1; done
  rm -rf "${PGDATA:?}"/*
  export PGPASSWORD='staging-replica-only-password'
  pg_basebackup \
    --host=postgres \
    --username=staging_replica \
    --pgdata="$PGDATA" \
    --wal-method=stream \
    --checkpoint=fast \
    --write-recovery-conf
  chmod 0700 "$PGDATA"
fi

exec docker-entrypoint.sh postgres \
  -c hot_standby=on \
  -c max_connections="${STAGING_POSTGRES_MAX_CONNECTIONS:-64}"
