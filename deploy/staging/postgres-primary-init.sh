#!/bin/sh
set -eu

# Репликационный credential существует только внутри ephemeral staging-контура.
# SCRAM и отдельная replication-запись не открывают доступ обычным базам.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE staging_replica WITH REPLICATION LOGIN PASSWORD 'staging-replica-only-password'"

printf '%s\n' 'host replication staging_replica all scram-sha-256' >>"$PGDATA/pg_hba.conf"
