#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  printf '%s\n' 'Usage: sudo deploy/aliyun-ecs/test-access.sh issue [--ttl 1h|24h|7d] [--count 1..50]'
  printf '%s\n' '       sudo deploy/aliyun-ecs/test-access.sh revoke --grant-id ID'
}

action="${1:-}"
if [[ "$action" == "--help" || "$action" == "-h" ]]; then
  usage
  exit 0
fi
[[ "${EUID}" -eq 0 ]] || { printf '%s\n' 'Run this command with sudo.' >&2; exit 77; }
[[ -r /etc/gatherthread/gatherthread.env ]] || {
  printf '%s\n' 'GatherThread is not installed; the environment file is missing.' >&2
  exit 66
}
[[ -r /opt/gatherthread/current/apps/server/dist/src/cli.js ]] || {
  printf '%s\n' 'The active GatherThread release is incomplete.' >&2
  exit 66
}
cd /opt/gatherthread/current

case "$action" in
  issue)
    ttl="7d"
    count="1"
    seen_ttl=0
    seen_count=0
    shift
    while (($# > 0)); do
      case "$1" in
        --ttl) (($# >= 2 && !seen_ttl)) || { usage >&2; exit 64; }; ttl="$2"; seen_ttl=1; shift 2 ;;
        --count) (($# >= 2 && !seen_count)) || { usage >&2; exit 64; }; count="$2"; seen_count=1; shift 2 ;;
        *) usage >&2; exit 64 ;;
      esac
    done
    [[ "$ttl" == "1h" || "$ttl" == "24h" || "$ttl" == "7d" ]] || { usage >&2; exit 64; }
    [[ "$count" =~ ^([1-9]|[1-4][0-9]|50)$ ]] || { usage >&2; exit 64; }
    runuser -u gatherthread -- /usr/bin/env \
      GATHERTHREAD_ENV_FILE=/etc/gatherthread/gatherthread.env \
      GATHERTHREAD_TEST_ACCESS_TTL="$ttl" \
      GATHERTHREAD_TEST_ACCESS_COUNT="$count" \
      /bin/bash -c '
        set -euo pipefail
        set -a
        # shellcheck disable=SC1090
        source "$GATHERTHREAD_ENV_FILE"
        set +a
        exec /usr/local/bin/node /opt/gatherthread/current/apps/server/dist/src/cli.js issue-test-access \
          --ttl "$GATHERTHREAD_TEST_ACCESS_TTL" --count "$GATHERTHREAD_TEST_ACCESS_COUNT" --format share
      '
    ;;
  revoke)
    [[ $# -eq 3 && "$2" == "--grant-id" && -n "$3" && "$3" != --* ]] || { usage >&2; exit 64; }
    runuser -u gatherthread -- /usr/bin/env \
      GATHERTHREAD_ENV_FILE=/etc/gatherthread/gatherthread.env \
      GATHERTHREAD_TEST_ACCESS_GRANT_ID="$3" \
      /bin/bash -c '
        set -euo pipefail
        set -a
        # shellcheck disable=SC1090
        source "$GATHERTHREAD_ENV_FILE"
        set +a
        exec /usr/local/bin/node /opt/gatherthread/current/apps/server/dist/src/cli.js revoke-test-access \
          --grant-id "$GATHERTHREAD_TEST_ACCESS_GRANT_ID"
      '
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
