FROM alpine:3.20

RUN apk add --no-cache curl iproute2 stress-ng util-linux

COPY deploy/chaos/entrypoint.sh /usr/local/bin/chaos-entrypoint
RUN chmod 0555 /usr/local/bin/chaos-entrypoint

ENTRYPOINT ["/usr/local/bin/chaos-entrypoint"]
