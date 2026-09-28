#!/usr/bin/env bash
set -euo pipefail

backup_directory="${1:-}"
if [[ -z "$backup_directory" || ! -d "$backup_directory" || -L "$backup_directory" ]]; then
  echo "usage: scripts/prune-sqlite-backups.sh EXISTING_BACKUP_DIRECTORY" >&2
  exit 64
fi
backup_directory="$(cd -- "$backup_directory" && pwd -P)"
backup_name='^collaboration-[0-9]{8}T[0-9]{6}Z-[0-9]+\.db$'
# Prune at 13 days, leaving one day of margin for the six-hour timer and
# transient failures before the published 14-day ceiling.
retention_minutes=18720

prune_code_directory() {
  local code_path="$1"
  if [[ -e "$code_path" || -L "$code_path" ]]; then
    if [[ ! -d "$code_path" || -L "$code_path" ]]; then
      echo "refusing unexpected code backup companion: $code_path" >&2
      return 1
    fi
    find "$code_path" -depth -delete
  fi
}

# Exact-name backup sets are private copies even when incomplete. Retire old
# sets together; a failed companion cleanup leaves the database for review.
while IFS= read -r -d '' backup_path; do
  backup_file="${backup_path##*/}"
  [[ "$backup_file" =~ $backup_name ]] || continue
  prune_code_directory "$backup_path.code"
  if [[ -e "$backup_path.sha256" && ! -L "$backup_path.sha256" ]]; then
    rm -- "$backup_path.sha256"
  fi
  if [[ -e "$backup_path.incomplete" && ! -L "$backup_path.incomplete" ]]; then
    rm -- "$backup_path.incomplete"
  fi
  rm -- "$backup_path"
done < <(find "$backup_directory" -maxdepth 1 -type f -name 'collaboration-*.db' -mmin +"$retention_minutes" -print0)

# A failed backup may have left only a marker or Git companion. Remove these
# after the same retention window; never traverse unrecognized names or links.
while IFS= read -r -d '' marker; do
  backup_path="${marker%.incomplete}"
  backup_file="${backup_path##*/}"
  [[ "$backup_file" =~ $backup_name ]] || continue
  [[ ! -e "$backup_path" ]] || continue
  prune_code_directory "$backup_path.code"
  if [[ -e "$backup_path.sha256" && ! -L "$backup_path.sha256" ]]; then
    rm -- "$backup_path.sha256"
  fi
  rm -- "$marker"
done < <(find "$backup_directory" -maxdepth 1 -type f -name 'collaboration-*.db.incomplete' -mmin +"$retention_minutes" -print0)

# Earlier ECS units rotated only .db and .sha256. Retire those orphaned Git
# companions too, but never a young backup.
while IFS= read -r -d '' code_path; do
  backup_path="${code_path%.code}"
  backup_file="${backup_path##*/}"
  [[ "$backup_file" =~ $backup_name ]] || continue
  [[ ! -e "$backup_path" && ! -e "$backup_path.incomplete" ]] || continue
  prune_code_directory "$code_path"
done < <(find "$backup_directory" -maxdepth 1 -type d -name 'collaboration-*.db.code' -mmin +"$retention_minutes" -print0)
