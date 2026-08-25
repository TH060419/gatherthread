# Zero-cost owner hosting with Tailscale

This is the supported first-release topology for a small, known, non-commercial group. One participant's computer runs the authoritative Relayroom process and SQLite database. Every participant continues to run their own local harness and bridge.

Tailscale Personal currently permits up to six users for personal, non-commercial use. Check the [current plan terms](https://tailscale.com/pricing) before relying on that limit. Tailscale Serve makes a loopback service available only inside the tailnet; Relayroom does not enable Funnel or router port forwarding.

## Availability and trust

The host operator is inside the plaintext trust boundary defined by [ADR-0001](adr/0001-trusted-self-hosted-collaboration-server.md). The deployment is unavailable while the host sleeps, shuts down, loses its network connection, or stops Relayroom. Durable history remains in SQLite, but the first release has no automatic failover or multi-primary replication.

## Requirements

- Node.js 24 or newer.
- Tailscale installed and authenticated on the host and every collaborator device.
- A Tailscale HTTPS/MagicDNS name for the host.
- A private directory on the host for `.env`, SQLite, and backups.

Do not expose port 8787 through a router, firewall, Tailscale Funnel, or a public tunnel.

## Install and configure

Install the pinned dependencies and create a private environment file:

```bash
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at least:

```dotenv
NODE_ENV=production
ACP_SERVER_HOST=127.0.0.1
ACP_SERVER_PORT=8787
ACP_DATABASE_PATH=.local/collaboration.sqlite
ACP_STATIC_DIRECTORY=apps/web/dist
ACP_PUBLIC_BASE_URL=https://your-host.your-tailnet.ts.net
ACP_ALLOWED_ORIGINS=
ACP_AUTH_TOKEN_PEPPER=replace-with-a-random-secret-of-at-least-32-bytes
ACP_TLS_TERMINATED_BY_PROXY=true
ACP_ALLOW_HTTP_BOOTSTRAP=false
ACP_MAX_EVENT_BYTES=262144
ACP_MAX_USER_EVENT_BYTES=268435456
ACP_MAX_SESSION_EVENT_BYTES=536870912
ACP_MAX_TOTAL_EVENT_BYTES=2147483648
```

Generate the pepper with a cryptographic password generator, store it in a password manager, and paste it into `.env`. Never commit it. Losing or changing the pepper invalidates every device credential, so back it up separately from the database.

The application refuses production startup if the public origin is not HTTPS, the pepper is missing or looks like a placeholder, HTTP bootstrap is enabled, the bind address is not loopback, event limits are invalid, or the database directory grants group/other access. The shown storage limits allow 256 MiB of attributed events per user, 512 MiB per session, and 2 GiB for the deployment. Increase them only after checking disk capacity and backup time; they prevent new writes rather than deleting history.

## Create the first owner

Bootstrap operates directly on the local SQLite database. There is no production network bootstrap endpoint.

```bash
npm run owner-host:init -- \
  --display-name "Owner name" \
  --device-name "Owner Mac"
```

The command prints the first device credential once. Put it in a password manager. Do not paste it into chat, an invitation, a URL, a command-line argument, or a committed file.

## Start the private service

Start Relayroom in one terminal:

```bash
npm run owner-host
```

The command builds the Web client and TypeScript packages, validates production configuration, and starts one same-origin Web/API/WebSocket service on loopback.

In another terminal, configure private HTTPS through Tailscale Serve:

```bash
npm run owner-host:tailscale-serve
```

This helper runs `tailscale serve` in background mode and explicitly does not run Funnel. Confirm the result with:

```bash
tailscale serve status
```

Collaborators open the exact `ACP_PUBLIC_BASE_URL`. Relayroom still requires its own invitation, device credential, session role, and one-use WebSocket ticket; tailnet membership is only an additional network boundary.

## Restrict tailnet access

Do not retain a broad allow-all tailnet policy. Use Tailscale grants to allow only the named collaborators to reach TCP 443 on the Relayroom host. Keep SSH, file sharing, and unrelated host ports outside that grant. Review the [Tailscale grants documentation](https://tailscale.com/docs/features/access-control/grants) and test the policy before removing your administrative recovery path.

Relayroom does not trust Tailscale identity headers as application identity. User, device, runtime, and session authorization always come from Relayroom credentials and ACLs.

## Invitations and devices

- The owner creates a one-use invitation for `participant` or `viewer`.
- Expiry choices are one hour, 24 hours, or seven days; the default is 24 hours.
- A new collaborator claims the invitation and receives their own first device credential.
- An existing user authenticates before accepting an invitation and receives no new credential.
- A new device uses a separate ten-minute, one-use device authorization token.
- The inviter never receives the invitee's device credential.

Invitation and device authorization secrets are accepted in request bodies, never in URLs. The server stores only peppered HMAC digests and rate-limits unauthenticated claim endpoints.

## Bridge and MCP processes

Each collaborator runs the bridge locally with their own device credential and runtime metadata. The bridge requires an HTTPS Relayroom URL for remote hosts, rejects credentials embedded in URLs, persists cursors locally, and does not forward the Relayroom credential to a harness adapter process.

See [bridge configuration](../packages/bridge/README.md) and [MCP configuration](../packages/mcp/README.md). Keep credentials in local environment or an operating-system secret store, never in MCP JSON committed to the project.

## Backup and host migration

Use the SQLite online backup helper; never copy only the main database while WAL writes are active:

```bash
scripts/backup-sqlite.sh .local/collaboration.sqlite .local/backups
scripts/verify-sqlite-backup.sh .local/backups/collaboration-YYYYMMDDTHHMMSSZ-PID.db
```

Keep at least one encrypted backup outside the host's main disk and protect the matching credential pepper separately. A new host can restore a verified backup, copy the same pepper securely, update `ACP_PUBLIC_BASE_URL`, and restart the single authoritative deployment. Test restore before treating a backup as recoverable.

## Security checklist

- Host OS, Node.js, Tailscale, and Relayroom dependencies are patched.
- Full-disk encryption and a locked user account protect the host.
- Relayroom binds only to loopback; no public port or Funnel exists.
- Tailscale grants permit only named collaborators to TCP 443.
- `.env`, SQLite, pepper, and backups are readable only by the host account.
- Public registration and network bootstrap remain disabled.
- Invitations and unused device authorizations are revoked when no longer needed.
- Lost devices are revoked immediately. Revocation terminates their realtime sockets, runtimes, and unused delegated device authorizations; each remaining device rotates only its own credential.
- Event-storage quota alerts are investigated before raising limits, and free disk space remains above the database and WAL safety margin.
- Backups pass integrity checks and a periodic restore drill.
- Logs contain no tokens, invitations, prompts, transcripts, or event payloads.
