#!/usr/bin/env bash
set -euo pipefail
umask 027

node_version="${GATHERTHREAD_NODE_VERSION:-24.16.0}"
domain=""
acknowledge_public_beta=false

usage() {
  cat <<'EOF'
Usage: sudo deploy/oracle-free/install.sh \
  --domain gatherthread.example.com \
  --acknowledge-experimental-public-ingress

Run this from a clean GatherThread checkout at /opt/gatherthread/app on an
Ubuntu 22.04 or 24.04 Oracle Compute instance. DNS must point to the instance's
public IPv4 address before Caddy can obtain a public certificate.
EOF
}

while (($# > 0)); do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || { usage >&2; exit 64; }
      domain="$2"
      shift 2
      ;;
    --acknowledge-experimental-public-ingress)
      acknowledge_public_beta=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

[[ "$acknowledge_public_beta" == true ]] || {
  echo "Refusing public ingress without --acknowledge-experimental-public-ingress." >&2
  exit 64
}
[[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || {
  echo "--domain must be a DNS hostname without a scheme, port, path, or wildcard." >&2
  exit 64
}
domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"
(( ${#domain} <= 253 )) || { echo "--domain is longer than 253 characters." >&2; exit 64; }
[[ "${EUID}" -eq 0 ]] || { echo "Run this installer with sudo." >&2; exit 77; }

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_directory/../.." && pwd -P)"
expected_root="/opt/gatherthread/app"
[[ "$repository_root" == "$expected_root" ]] || {
  echo "Clone the repository at $expected_root before running this installer." >&2
  exit 78
}
[[ -f "$repository_root/package-lock.json" && -f "$repository_root/apps/server/src/cli.ts" ]] || {
  echo "The expected GatherThread source tree is incomplete." >&2
  exit 78
}

if [[ ! -r /etc/os-release ]]; then
  echo "This installer supports Ubuntu 22.04 and 24.04 only." >&2
  exit 69
fi
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]] || {
  echo "This installer supports Ubuntu 22.04 and 24.04 only." >&2
  exit 69
}

case "$(uname -m)" in
  aarch64|arm64) node_arch="arm64" ;;
  x86_64|amd64) node_arch="x64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 69 ;;
esac

temporary_directory="$(mktemp -d /tmp/gatherthread-oracle.XXXXXX)"
repository_claimed=false
cleanup() {
  if [[ "$repository_claimed" == true ]]; then
    chown -R root:root "$repository_root"
  fi
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl debian-archive-keyring debian-keyring git gnupg openssl sqlite3 xz-utils

curl --fail --silent --show-error --location \
  https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  --output "$temporary_directory/caddy.gpg.key"
gpg --batch --yes --dearmor \
  --output /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
  "$temporary_directory/caddy.gpg.key"
curl --fail --silent --show-error --location \
  https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  --output /etc/apt/sources.list.d/caddy-stable.list
chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

node_distribution="node-v${node_version}-linux-${node_arch}"
node_prefix="/opt/${node_distribution}"
if [[ ! -x "$node_prefix/bin/node" ]]; then
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" \
    --output "$temporary_directory/SHASUMS256.txt"
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/v${node_version}/${node_distribution}.tar.xz" \
    --output "$temporary_directory/${node_distribution}.tar.xz"
  expected_checksum="$(awk -v file="${node_distribution}.tar.xz" '$2 == file { print $1 }' "$temporary_directory/SHASUMS256.txt")"
  [[ "$expected_checksum" =~ ^[0-9a-f]{64}$ ]] || { echo "Node.js checksum was not found." >&2; exit 74; }
  actual_checksum="$(sha256sum "$temporary_directory/${node_distribution}.tar.xz" | awk '{ print $1 }')"
  [[ "$actual_checksum" == "$expected_checksum" ]] || { echo "Node.js archive checksum mismatch." >&2; exit 74; }
  install -d -m 0755 "$node_prefix"
  tar -xJf "$temporary_directory/${node_distribution}.tar.xz" -C "$node_prefix" --strip-components=1
fi
ln -sfn "$node_prefix/bin/node" /usr/local/bin/node
ln -sfn "$node_prefix/bin/npm" /usr/local/bin/npm
ln -sfn "$node_prefix/bin/npx" /usr/local/bin/npx

if ! id gatherthread >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gatherthread --shell /usr/sbin/nologin --user-group gatherthread
fi
install -d -o gatherthread -g gatherthread -m 0700 /var/lib/gatherthread /var/backups/gatherthread
install -d -o gatherthread -g gatherthread -m 0750 /var/cache/gatherthread-npm
install -d -o root -g gatherthread -m 0750 /etc/gatherthread

chown -R gatherthread:gatherthread "$repository_root"
repository_claimed=true
runuser -u gatherthread -- env \
  HOME=/var/lib/gatherthread \
  PATH=/usr/local/bin:/usr/bin:/bin \
  npm_config_cache=/var/cache/gatherthread-npm \
  npm ci
runuser -u gatherthread -- env \
  HOME=/var/lib/gatherthread \
  PATH=/usr/local/bin:/usr/bin:/bin \
  npm_config_cache=/var/cache/gatherthread-npm \
  npm run build
chown -R root:root "$repository_root"
chmod -R a+rX,go-w "$repository_root"
repository_claimed=false

environment_file="/etc/gatherthread/gatherthread.env"
if [[ ! -e "$environment_file" ]]; then
  authentication_pepper="$(openssl rand -hex 32)"
  cat > "$temporary_directory/gatherthread.env" <<EOF
NODE_ENV=production
GATHERTHREAD_SERVER_HOST=127.0.0.1
GATHERTHREAD_SERVER_PORT=18787
GATHERTHREAD_DATABASE_PATH=/var/lib/gatherthread/collaboration.sqlite
GATHERTHREAD_STATIC_DIRECTORY=$repository_root/apps/web/dist
GATHERTHREAD_PUBLIC_BASE_URL=https://$domain
GATHERTHREAD_ALLOWED_ORIGINS=
GATHERTHREAD_AUTH_TOKEN_PEPPER=${authentication_pepper}
GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true
GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false
GATHERTHREAD_MAX_EVENT_BYTES=262144
GATHERTHREAD_MAX_USER_EVENT_BYTES=268435456
GATHERTHREAD_MAX_SESSION_EVENT_BYTES=536870912
GATHERTHREAD_MAX_TOTAL_EVENT_BYTES=2147483648
GATHERTHREAD_MAX_USER_SESSIONS=512
GATHERTHREAD_MAX_PROJECT_SESSIONS=2048
GATHERTHREAD_MAX_TOTAL_SESSIONS=8192
EOF
  install -o root -g gatherthread -m 0640 "$temporary_directory/gatherthread.env" "$environment_file"
else
  configured_origin="$(grep -E '^GATHERTHREAD_PUBLIC_BASE_URL=' "$environment_file" || true)"
  [[ "$configured_origin" == "GATHERTHREAD_PUBLIC_BASE_URL=https://$domain" ]] || {
    echo "$environment_file already exists for a different or invalid public origin; refusing to overwrite it." >&2
    exit 73
  }
fi

sed \
  -e "s|@@REPOSITORY_ROOT@@|$repository_root|g" \
  "$script_directory/gatherthread.service.in" > "$temporary_directory/gatherthread.service"
install -o root -g root -m 0644 "$temporary_directory/gatherthread.service" /etc/systemd/system/gatherthread.service

sed \
  -e "s|@@REPOSITORY_ROOT@@|$repository_root|g" \
  "$script_directory/gatherthread-backup.service.in" > "$temporary_directory/gatherthread-backup.service"
install -o root -g root -m 0644 "$temporary_directory/gatherthread-backup.service" /etc/systemd/system/gatherthread-backup.service
install -o root -g root -m 0644 "$script_directory/gatherthread-backup.timer" /etc/systemd/system/gatherthread-backup.timer

sed -e "s|@@DOMAIN@@|$domain|g" "$script_directory/Caddyfile.in" > "$temporary_directory/Caddyfile"
caddy validate --config "$temporary_directory/Caddyfile" --adapter caddyfile
install -o root -g root -m 0644 "$temporary_directory/Caddyfile" /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now gatherthread.service gatherthread-backup.timer
systemctl enable --now caddy.service
systemctl reload caddy.service

for _ in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:18787/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:18787/health >/dev/null || {
  journalctl -u gatherthread.service --no-pager -n 50 >&2
  exit 70
}

cat <<EOF
GatherThread is healthy on loopback and Caddy is configured for https://$domain.

Next:
  1. In OCI, allow inbound TCP 80 and 443. Never open 18787.
  2. Run: sudo $repository_root/deploy/oracle-free/preflight.sh $domain
  3. Create the first owner with the command documented in docs/ORACLE_CLOUD.zh-CN.md.

The authentication pepper is stored only in $environment_file. Back it up separately.
EOF
