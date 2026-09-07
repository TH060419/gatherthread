#!/usr/bin/env bash
set -euo pipefail

release_version="0.1.0-alpha.2"
domain="${1:-}"
[[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || {
  printf '%s\n' "Usage: sudo deploy/aliyun-ecs/preflight.sh gatherthread.example.com" >&2
  exit 64
}

failures=0
check() {
  local description="$1"
  shift
  if "$@"; then
    printf 'ok   %s\n' "$description"
  else
    printf 'FAIL %s\n' "$description" >&2
    failures=$((failures + 1))
  fi
}

check "active release is $release_version" bash -c \
  "grep -Eq '\"version\": \"$release_version\"' /opt/gatherthread/current/package.json"
check "GatherThread systemd service is active" systemctl is-active --quiet gatherthread.service
check "Caddy systemd service is active" systemctl is-active --quiet caddy.service
check "daily backup timer is active" systemctl is-active --quiet gatherthread-backup.timer
check "Caddy configuration is valid" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
check "loopback liveness responds" curl --fail --silent --show-error http://127.0.0.1:8787/health/live
check "loopback readiness confirms WAL, foreign keys, and writes" bash -c \
  "curl --fail --silent --show-error http://127.0.0.1:8787/health/ready | grep -Eq '\"journal_mode\":\"wal\".*\"foreign_keys\":true.*\"writable\":true'"
check "public HTTPS readiness succeeds" curl --fail --silent --show-error --max-time 15 "https://$domain/health/ready"
check "public HTTPS sends HSTS" bash -c \
  "curl --fail --silent --show-error --head --max-time 15 https://$domain/health/live | tr -d '\r' | grep -Eiq '^strict-transport-security:'"
check "application does not listen on a non-loopback address" bash -c \
  "! ss -H -ltn 'sport = :8787' | awk '{ print \$4 }' | grep -Ev '^(127\\.0\\.0\\.1|\\[::1\\]):8787$' | grep -q ."
check "HTTPS is listening" bash -c "ss -H -ltn 'sport = :443' | grep -q ."
check "private database directory is mode 0700" bash -c \
  "[[ \$(stat -c '%a' /var/lib/gatherthread) == 700 ]]"
check "private environment is not world-readable" bash -c \
  "[[ \$((8#\$(stat -c '%a' /etc/gatherthread/gatherthread.env) & 8#007)) == 0 ]]"
check "SQLite database passes integrity check" bash -c \
  "[[ \$(sqlite3 /var/lib/gatherthread/collaboration.sqlite 'PRAGMA integrity_check;') == ok ]]"

if ((failures > 0)); then
  printf '%s\n' "$failures preflight check(s) failed." >&2
  exit 1
fi
printf '%s\n' "Alibaba Cloud ECS deployment preflight passed for $release_version."
