#!/bin/sh
set -eu

# Репликационный credential существует только внутри ephemeral staging-контура.
# SCRAM и отдельная replication-запись не открывают доступ обычным базам.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE staging_replica WITH REPLICATION LOGIN PASSWORD 'staging-replica-only-password'"

# Backend role не получает DDL/role privileges; grants выдаёт migration job.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE exchange_app WITH LOGIN PASSWORD :'app_password';
SQL

printf '%s\n' 'host replication staging_replica all scram-sha-256' >>"$PGDATA/pg_hba.conf"
