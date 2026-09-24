#!/usr/bin/env bash
set -euo pipefail

backup_directory="${1:-}"
if [[ -z "$backup_directory" || ! -d "$backup_directory" || -L "$backup_directory" ]]; then
  echo "usage: scripts/prune-sqlite-backups.sh EXISTING_BACKUP_DIRECTORY" >&2
  exit 64
fi
backup_directory="$(cd -- "$backup_directory" && pwd -P)"
backup_name='^collaboration-[0-9]{8}T[0-9]{6}Z-[0-9]+\.db$'

prune_code_directory() {
  local code_path="$1"
  if [[ -e "$code_path" || -L "$code_path" ]]; then
    if [[ ! -d "$code_path" || -L "$code_path" ]]; then
      echo "refusing unexpected code backup companion: $code_path" >&2
      return 1
    fi
    if [[ -e "$code_path/.incomplete" ]]; then
      echo "leaving incomplete code backup for operator review: $code_path" >&2
      return 1
    fi
    find "$code_path" -depth -delete
  fi
}

# Only a complete, old SQLite backup is eligible. Remove its Git companion
# first; a failed companion cleanup must leave the SQLite file for inspection.
while IFS= read -r -d '' backup_path; do
  backup_file="${backup_path##*/}"
  [[ "$backup_file" =~ $backup_name ]] || continue
  [[ ! -e "$backup_path.incomplete" ]] || continue
  prune_code_directory "$backup_path.code"
  if [[ -e "$backup_path.sha256" && ! -L "$backup_path.sha256" ]]; then
    rm -- "$backup_path.sha256"
  fi
  rm -- "$backup_path"
done < <(find "$backup_directory" -maxdepth 1 -type f -name 'collaboration-*.db' -mtime +14 -print0)

# Earlier ECS units rotated only .db and .sha256. Retire those orphaned Git
# companions too, but never an incomplete or young backup.
while IFS= read -r -d '' code_path; do
  backup_path="${code_path%.code}"
  backup_file="${backup_path##*/}"
  [[ "$backup_file" =~ $backup_name ]] || continue
  [[ ! -e "$backup_path" && ! -e "$backup_path.incomplete" ]] || continue
  prune_code_directory "$code_path"
done < <(find "$backup_directory" -maxdepth 1 -type d -name 'collaboration-*.db.code' -mtime +14 -print0)
