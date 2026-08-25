#!/usr/bin/env bash
set -euo pipefail

backup_path="${1:-}"
if [[ -z "$backup_path" || ! -f "$backup_path" ]]; then
  echo "usage: scripts/verify-sqlite-backup.sh BACKUP_PATH" >&2
  exit 64
fi
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 69; }

integrity="$(sqlite3 "$backup_path" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "backup integrity check failed: $integrity" >&2
  exit 74
fi

checksum_path="$backup_path.sha256"
if [[ -f "$checksum_path" ]]; then
  if command -v sha256sum >/dev/null; then
    (cd "$(dirname "$backup_path")" && sha256sum -c "$(basename "$checksum_path")")
  else
    (cd "$(dirname "$backup_path")" && shasum -a 256 -c "$(basename "$checksum_path")")
  fi
fi
echo "backup verified: $backup_path"
