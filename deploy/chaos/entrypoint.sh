#!/bin/sh
set -eu

if [ "${CHAOS_ENVIRONMENT:-}" != "staging" ] || [ "${CHAOS_ACK:-}" != "isolated-test-only" ]; then
  echo "fault-agent refused to start outside isolated staging" >&2
  exit 78
fi

exec sleep infinity
