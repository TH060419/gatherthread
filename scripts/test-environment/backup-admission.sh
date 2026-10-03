#!/usr/bin/env bash
# Admission has no collaboration/code schema; do not use the collaboration backup helper.
set -euo pipefail
umask 077
task_database=/var/lib/gatherthread-test/admission.sqlite
task_backups=/var/backups/gatherthread-test/admission
[[ -f "$task_database" && ! -L "$task_database" ]] || { echo 'Test admission database unavailable.' >&2; exit 1; }
mkdir -p "$task_backups"
task_backup="$task_backups/admission-$(date -u +%Y%m%dT%H%M%SZ)-$$.db"
sqlite3 "$task_database" '.timeout 5000' ".backup '$task_backup'"
[[ "$(sqlite3 "$task_backup" 'PRAGMA integrity_check;')" == ok ]] || { echo 'Admission backup failed integrity check.' >&2; exit 1; }
sha256sum "$task_backup" > "$task_backup.sha256"
# Admission backups have their own retention, including checksums.
find "$task_backups" -maxdepth 1 -type f -name 'admission-*.db*' -mtime +12 -delete
echo 'Test admission backup verified.'
