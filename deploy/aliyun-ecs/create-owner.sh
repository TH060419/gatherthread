#!/usr/bin/env bash
set -euo pipefail
umask 077

display_name=""
device_name=""

usage() {
  printf '%s\n' "Usage: sudo deploy/aliyun-ecs/create-owner.sh --display-name NAME --device-name NAME"
}

while (($# > 0)); do
  case "$1" in
    --display-name)
      [[ $# -ge 2 ]] || { usage >&2; exit 64; }
      display_name="$2"
      shift 2
      ;;
    --device-name)
      [[ $# -ge 2 ]] || { usage >&2; exit 64; }
      device_name="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || { printf '%s\n' "Run this command with sudo." >&2; exit 77; }
[[ -n "$display_name" && -n "$device_name" ]] || { usage >&2; exit 64; }
[[ -r /etc/gatherthread/gatherthread.env ]] || {
  printf '%s\n' "GatherThread is not installed; /etc/gatherthread/gatherthread.env is missing." >&2
  exit 66
}
[[ -r /opt/gatherthread/current/apps/server/dist/src/cli.js ]] || {
  printf '%s\n' "The active GatherThread release is incomplete." >&2
  exit 66
}

runuser -u gatherthread -- /usr/bin/env \
  GATHERTHREAD_ENV_FILE=/etc/gatherthread/gatherthread.env \
  GATHERTHREAD_DISPLAY_NAME="$display_name" \
  GATHERTHREAD_DEVICE_NAME="$device_name" \
  /bin/bash -c '
    set -euo pipefail
    set -a
    # shellcheck disable=SC1090
    source "$GATHERTHREAD_ENV_FILE"
    set +a
    exec /usr/local/bin/node /opt/gatherthread/current/apps/server/dist/src/cli.js bootstrap \
      --display-name "$GATHERTHREAD_DISPLAY_NAME" \
      --device-name "$GATHERTHREAD_DEVICE_NAME"
  '
