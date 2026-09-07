# Changelog

All notable changes to GatherThread are documented here. The project follows Semantic Versioning while pre-release APIs may still change.

## [0.1.0-alpha.2] - 2026-09-08

### Changed

- Label newly managed Codex Desktop, background, and immutable snapshot conversations with their initial uppercase `MULTI` or `SOLO` session type while preserving the suffix under Codex title truncation.
- Keep snapshot completion metadata identical to the actual native Codex title.
- Advance all fixed-version Codex connector, DeepSeek Harness plugin, Web onboarding, private deployment, and release-verification references to `0.1.0-alpha.2` without replacing the immutable `alpha.1` artifacts.

### Fixed

- Make the Codex plugin Hook relay preserve the connector's lexical workspace key before trying a canonical fallback and compare Windows paths case-insensitively.
- Make DSH path contract tests platform-aware so the Windows release gate validates native paths rather than POSIX-only fixture strings.

### Known limitations

- The hosted GatherThread service and public Beta remain closed; this Alpha supports local, private LAN HTTPS, private Tailscale, and operator-managed self-hosting.
- Existing local Agent task titles remain independently editable and are not overwritten when a cloud session is later renamed or changes mode.

## [0.1.0-alpha.1] - 2026-09-07

### Added

- Invitation-only projects with creator, participant, and viewer permissions; creator-scoped cloud session and project deletion never removes local work.
- Live Agent work updates that collapse after completion, safe GitHub-flavored Markdown, tables, task lists, code, links, and bundled KaTeX math rendering.
- Remembered 30-day browser sessions, automatic device names, and authenticated device renaming while retaining HttpOnly Cookie, Origin, revocation, and one-use WebSocket-ticket boundaries.
- Local-only, private LAN HTTPS, private Tailscale Serve, and an Alibaba Cloud ECS deployment profile.
- An opt-in DeepSeek Harness Web plugin with short-code pairing, exact runtime/model routing, native status controls, durable project-session recovery, and a browser-safe three-step connection fallback.
- Separate `/health/live` and `/health/ready` probes, systemd hardening, Caddy TLS termination, daily verified SQLite backups, and release consistency checks.
- Fixed-version, self-contained `@gatherthread/codex-connect` npm/npx packaging and a repo-local **共序 / GatherThread** Codex plugin with private-IPC stdio MCP tools and explicit Hook trust.

### Changed

- Reworked the bilingual Web UI with the current GatherThread brand, responsive liquid-glass hierarchy, resizable panes, accessible custom selects, stronger contrast, and Safari/Chromium fallbacks.
- Simplified Agent provenance metadata and refreshed bilingual onboarding, Connect Codex, role, device, connection, and operations copy.
- Pinned the tested server deployment runtime to Node.js 24.16.0.
- Separated user MCP collaboration tools from internal runtime tools and kept device credentials inside the running connector.

### Known limitations

- The Alpha is a single Node.js process with one SQLite database and no automatic failover or multi-process WebSocket fan-out.
- Agent progress is item-level rather than token-level streaming. Hidden reasoning is never uploaded.
- Attachments, retention workers, abandoned claim recovery, offline Web outbox, and open registration are not implemented.
- The DSH package is prepared but not published by this candidate; its verified npm Host surface is `@deepseek-ai/dsh@0.1.2-rc.1`, and DSH does not yet expose a stable root-version service or public plugin marketplace.
- Alibaba Cloud deployment is intended for a small, invitation-only beta and requires operator-managed domain, filing, security-group, monitoring, and restore checks.
- Public npm scope ownership, public plugin-directory distribution, and remote OAuth 2.1/PKCE MCP remain release follow-ups.

[0.1.0-alpha.2]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.1
