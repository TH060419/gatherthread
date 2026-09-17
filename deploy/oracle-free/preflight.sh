#!/usr/bin/env bash
set -euo pipefail

domain="${1:-}"
[[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || {
  echo "usage: sudo deploy/oracle-free/preflight.sh gatherthread.example.com" >&2
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

check "GatherThread systemd service is active" systemctl is-active --quiet gatherthread.service
check "Caddy systemd service is active" systemctl is-active --quiet caddy.service
check "daily backup timer is active" systemctl is-active --quiet gatherthread-backup.timer
check "loopback health reports SQLite WAL" bash -c \
  "curl --fail --silent --show-error http://127.0.0.1:18787/health | grep -q '\"journal_mode\":\"wal\"'"
check "public HTTPS health reports SQLite WAL" bash -c \
  "curl --fail --silent --show-error --max-time 15 https://$domain/health | grep -q '\"journal_mode\":\"wal\"'"
check "application does not listen on a non-loopback address" bash -c \
  "! ss -H -ltn 'sport = :18787' | awk '{ print \$4 }' | grep -Ev '^(127\\.0\\.0\\.1|\\[::1\\]):18787$' | grep -q ."
check "private database directory is mode 0700" bash -c \
  "[[ \$(stat -c '%a' /var/lib/gatherthread) == 700 ]]"
check "private environment is not world-readable" bash -c \
  "[[ \$((8#\$(stat -c '%a' /etc/gatherthread/gatherthread.env) & 8#007)) == 0 ]]"

if ((failures > 0)); then
  echo "$failures preflight check(s) failed." >&2
  exit 1
fi
echo "Oracle deployment preflight passed."
