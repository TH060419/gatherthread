#!/usr/bin/env bash
set -euo pipefail
umask 077

database_path="${1:-${DATABASE_PATH:-}}"
backup_directory="${2:-${BACKUP_DIRECTORY:-}}"

if [[ -z "$database_path" || -z "$backup_directory" ]]; then
  echo "usage: scripts/backup-sqlite.sh DATABASE_PATH BACKUP_DIRECTORY" >&2
  exit 64
fi
if [[ "$database_path" == ":memory:" || ! -f "$database_path" ]]; then
  echo "database must be an existing on-disk SQLite file" >&2
  exit 66
fi
if [[ "$backup_directory" == *'"'* || "$backup_directory" == *$'\n'* ]]; then
  echo "backup directory contains unsupported characters" >&2
  exit 65
fi
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 69; }

mkdir -p "$backup_directory"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$backup_directory/collaboration-$timestamp-$$.db"
if [[ -e "$backup_path" ]]; then
  echo "refusing to overwrite existing backup: $backup_path" >&2
  exit 73
fi

sqlite3 "$database_path" ".timeout 5000" ".backup \"$backup_path\""
integrity="$(sqlite3 "$backup_path" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "backup integrity check failed: $integrity" >&2
  exit 74
fi
chmod 600 "$backup_path"

if command -v sha256sum >/dev/null; then
  sha256sum "$backup_path" > "$backup_path.sha256"
else
  shasum -a 256 "$backup_path" > "$backup_path.sha256"
fi
chmod 600 "$backup_path.sha256"
echo "$backup_path"
