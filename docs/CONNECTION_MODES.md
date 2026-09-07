# Connection modes without a cloud account

GatherThread has three ready-to-use connection modes that do not require a public server. All three run the same single authoritative process, SQLite database, and authorization model. Switching modes updates only network-related values in the private `.env`; it preserves the credential pepper, database, users, quotas, and history.

| Mode | Best for | Client requirement | Entry point |
|---|---|---|---|
| Local | One-person development and full-flow testing | Node.js on the host | `http://127.0.0.1:8787` |
| LAN HTTPS | A trusted home, lab, or office network | Caddy on the host; the dedicated local CA trusted by clients | `https://private-address:8443` |
| Tailscale Serve | A small known group across networks | Tailscale on every device | `https://host.tailnet.ts.net` |

For a stable shared entry point, use the separate invitation-only [Alibaba Cloud ECS profile](ALIYUN_ECS.md). Never turn the LAN or Tailscale profiles into router port forwarding, Tailscale Funnel, or an unauthenticated public tunnel.

## Shared initialization

```bash
npm ci
npm run owner-host:init -- \
  --display-name "Your name" \
  --device-name "This computer"
```

Use the explicit `owner-host:init` step for local-only, Tailscale, or manual LAN setup. `lan:start` performs the same initialization interactively when the database does not yet exist. Initialize a database only once. Save the one-time device token in a password manager; do not place it in a URL, chat, screenshot, command argument, or Git file.

## Local-only

```bash
npm run connection:local
npm run owner-host
```

Open `http://127.0.0.1:8787`. This mode accepts no other computer. Do not replace the loopback bind with `0.0.0.0`.

## LAN HTTPS

Reserve a stable RFC1918 address for the host in DHCP, for example `192.168.50.20`. Advanced local DNS setups may map `gatherthread.home.arpa` to that address. Install [Caddy 2](https://caddyserver.com/docs/install), then configure an unprivileged HTTPS port:

A campus network is normally institution-managed LAN infrastructure, so this mode can work on campus when policy permits inbound peer traffic and the devices can reach each other. Campus Wi-Fi frequently applies client isolation, VLAN separation, or firewall rules; sharing the same SSID alone does not establish reachability or trust. When direct access is blocked, use the deployment's configured remote entry point. Tailscale is available now; prefer the unified hosted server after it is deployed.

For normal use, one command discovers private interfaces, asks for a choice only when necessary, configures the exact origin, initializes a new database interactively, builds the app, and starts both GatherThread and Caddy:

```bash
npm run lan:start
```

To make the choice deterministic:

```bash
npm run lan:start -- --address 192.168.50.20 --port 8443
```

The manual equivalent remains available for advanced troubleshooting:

```bash
npm run connection:lan -- \
  --url https://192.168.50.20:8443
```

Start the application and proxy in separate terminals:

```bash
npm run owner-host
npm run owner-host:lan
```

GatherThread remains on `127.0.0.1:8787`. The helper binds Caddy only to the selected private interface and gives it no GatherThread, Codex, or model credentials. Its dedicated local CA root is generated at:

```text
.local/network/lan/caddy-data/caddy/pki/authorities/local/root.crt
```

Transfer that public root certificate to each known test device by a trusted local channel, verify its SHA-256 out of band, and install it in the device trust store. Safari, Chrome, and Edge generally use the operating-system store; Firefox and mobile devices may need a separate import. Never bypass a certificate warning. Never copy the CA private key or the rest of the Caddy data directory.

Allow only the chosen TCP port from the trusted LAN in the host firewall. Do not enable router forwarding or UPnP. Test `https://192.168.50.20:8443/health` before claiming an invitation.

The full certificate installation and troubleshooting procedure is in the [Simplified Chinese guide](CONNECTION_MODES.zh-CN.md).

## Tailscale Serve

After installing and authenticating Tailscale on the host and collaborator devices:

```bash
npm run connection:tailscale -- \
  --url https://gatherthread-host.example-tailnet.ts.net
npm run owner-host
```

In another terminal:

```bash
npm run owner-host:tailscale-serve
tailscale serve status
```

The status must say **within your tailnet**. The helper never enables Funnel. Tailnet membership is an extra network boundary and never replaces GatherThread invitations, device credentials, project roles, or session ACLs. See [owner hosting](SELF_HOSTING.md) for grants, backup, and migration details.

## Switching modes

Stop the host and current proxy, run the new `connection:*` command, and restart both processes. Browser cookies do not cross origins, so sign in at the new exact URL. Stop and reconnect any Codex connector that still points to the old URL using the new command generated by the Web UI.

Each configure command clears `GATHERTHREAD_ALLOWED_ORIGINS`, deliberately narrowing browser and WebSocket acceptance to the newly selected entry point. Back up SQLite online and protect the matching pepper separately regardless of the selected mode.
