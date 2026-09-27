# GatherThread 0.1.0-beta.1 release candidate

> **Superseded planning record.** This pre-Alpha candidate was not published as a Git tag or GitHub Release. It is retained for historical review and is not the current hosted deployment or setup guide.

`0.1.0-beta.1` is the first deployment candidate for a small, invitation-only GatherThread beta. It combines the current collaboration, security, Codex bridge, Markdown/math, device-session, connection-mode, branding, and UI work in one versioned release.

## Candidate scope

- One creator-operated deployment; projects remain private and new users enter through single-use invitations.
- Solo and Multi ACLs, cloud-only deletion, durable sequence/replay, WebSocket live delivery, and isolated local Agent execution projections.
- Safe Markdown, GFM tables and task lists, bundled KaTeX formulas, live public work updates, and collapsed completed work logs.
- Default 24-hour browser session or explicit 30-day remembered device, automatic device naming, renaming, rotation, and revocation.
- Opt-in DeepSeek Harness Web plugin with short-lived browser pairing, exact device/provider/model routing, project Session discovery, durable recovery, and no Codex fallback; the package is prepared but not published by this candidate.
- Local-only, trusted LAN HTTPS, private Tailscale Serve, and Alibaba Cloud ECS deployment profiles.
- Versioned Alibaba release directory, loopback application bind, Caddy HTTPS, hardened systemd service, readiness checks, and daily SQLite online backup.
- A fixed `@gatherthread/codex-connect@0.1.0-beta.1` npm artifact that runs from a clean Git-less install, plus the repo-local **共序 / GatherThread** Codex plugin with user-only stdio MCP tools and explicitly trusted Hooks.

## Release gates

Run from a clean candidate checkout with Node.js 24.16.0:

```sh
npm ci
npm run release:verify
npm run test:dsh-npm-plugin:real # optional pinned DSH/Loader/browser gate; local cache required
npm pack --workspace @gatherthread/codex-connect
git diff --check
```

Install the generated tarball in a fresh Git-less temporary directory and verify the executable's `--help`, dependency resolution, local no-production-credential preflight, plugin structure, and MCP/runtime-tool isolation. Validate `plugins/gatherthread` with the installed plugin-creator validator on the release host; do not encode a developer-specific absolute path in release instructions.

The ordinary Beta Codex path requires the fixed-version connector to remain running. The plugin MCP uses leased, non-secret active registrations plus separate per-run-capability IPC rather than relying on Finder to inherit `GATHERTHREAD_TOKEN`. It collapses same-endpoint crash/restart overlap to the newest lease, aggregates distinct active projects, routes by unique project/session ID, and fails closed on cross-endpoint ambiguity or an offline target. Full Desktop-turn synchronization additionally requires `--plugin-hooks`, an online connector throughout each turn, and an explicit Codex Hook review/trust decision; only the project-Hook compatibility path has an offline spool. Safari, Chrome, and Edge only copy commands and do not launch a local Codex process.

The release repository includes `.agents/plugins/marketplace.json`, which points to the real `./plugins/gatherthread` bundle. After the fixed release ref has been published, add only the required catalog and plugin paths:

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-beta.1 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

The second command installs **共序 / GatherThread** from the configured fixed-ref source. Restart Codex Desktop, then review its MCP server and Hooks before enabling them. The Web page only copies these commands, and the connector never edits global Codex configuration. Switching from the persistent `--install-hooks` project file to `--plugin-hooks` leaves that user-reviewed file intact but changes a private source gate: exactly one source can receive context, and only project Hook mode drains the compatibility spool.

Before any publication, confirm ownership and publishing authority for the `@gatherthread` npm scope and `@gatherthread/codex-connect` package, create and verify the exact `v0.1.0-beta.1` Git ref used by the marketplace command, decide whether to submit to the future public Codex plugin directory, and repeat the clean tarball checks against the exact publish candidate. Do not claim remote OAuth MCP until the server has a real account system and OAuth 2.1/PKCE implementation.

The POSIX release gate verifies `0700` IPC directories, `0600` socket/capability files, stale-socket probing, and rejection of a second live connector. Cross-platform unit tests lock PowerShell quoting, Windows path normalization, named-pipe naming, and the requirement for an unpredictable per-run capability. Before public Windows support is announced, run a native Windows smoke test under two local accounts to confirm the user-profile capability ACL and named-pipe default DACL reject the other account; the implementation never treats the predictable pipe name alone as write authority.

Before serving real users, the operator must also complete the ECS preflight, create and verify an online backup, restore that backup in an isolated location, and run a two-browser invitation/replay/Agent-request smoke test.

## Supported hosted topology

The beta server binds only to `127.0.0.1:8787`. Caddy is the only public listener and terminates HTTPS on ports 80/443. Port 8787 must never be opened in the cloud security group. HTTP bootstrap and anonymous registration remain disabled.

See [Alibaba Cloud ECS deployment](../ALIYUN_ECS.md) or [阿里云 ECS 部署](../ALIYUN_ECS.zh-CN.md).

## Rollback boundary

The active code is selected by `/opt/gatherthread/current`. Before every upgrade, take and verify a SQLite online backup. Repointing the symlink is safe only when the older code supports the resulting schema; otherwise stop the service and restore a verified pre-upgrade database to a new path. Never overwrite the incident database or its WAL/SHM evidence.

## Deliberately excluded

Design prototypes, review screenshots, abandoned Oracle deployment drafts, local credentials, databases, generated builds, and dependency directories are not release artifacts.
