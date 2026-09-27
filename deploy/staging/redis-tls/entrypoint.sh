#!/bin/sh
set -eu

: "${STAGING_REDIS_PASSWORD:?STAGING_REDIS_PASSWORD is required}"

mkdir -p /tls

# Сертификаты создаются заново внутри ephemeral Compose volume. CA не покидает
# isolated topology и передаётся backend replicas только для проверки Redis TLS.
if [ ! -s /tls/ca.crt ] || [ ! -s /tls/server.crt ] || [ ! -s /tls/server.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -keyout /tls/ca.key \
    -out /tls/ca.crt \
    -subj '/CN=exchange-isolated-staging-redis-ca'
  openssl req -newkey rsa:2048 -nodes \
    -keyout /tls/server.key \
    -out /tls/server.csr \
    -subj '/CN=redis'
  printf '%s\n' 'subjectAltName=DNS:redis' 'extendedKeyUsage=serverAuth' >/tls/server.ext
  openssl x509 -req -days 2 \
    -in /tls/server.csr \
    -CA /tls/ca.crt \
    -CAkey /tls/ca.key \
    -CAcreateserial \
    -out /tls/server.crt \
    -extfile /tls/server.ext
  chmod 0444 /tls/ca.crt /tls/server.crt
  chmod 0400 /tls/ca.key /tls/server.key
fi

cat >/tmp/redis.conf <<EOF
bind 0.0.0.0
protected-mode yes
port 0
tls-port 6379
tls-cert-file /tls/server.crt
tls-key-file /tls/server.key
tls-ca-cert-file /tls/ca.crt
tls-auth-clients no
requirepass ${STAGING_REDIS_PASSWORD}
appendonly no
save ""
EOF

exec redis-server /tmp/redis.conf
