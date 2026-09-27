FROM redis:7-alpine

RUN apk add --no-cache openssl

COPY deploy/staging/redis-tls/entrypoint.sh /usr/local/bin/staging-redis-entrypoint
RUN chmod 0555 /usr/local/bin/staging-redis-entrypoint

ENTRYPOINT ["/usr/local/bin/staging-redis-entrypoint"]
