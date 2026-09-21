# Changelog

All notable changes to GatherThread are documented here. The project follows Semantic Versioning while pre-release APIs may still change.

## [Unreleased]

### Added

- Lease Agent claims and bound exact-runtime recovery. A claim is renewed only by accepted progress, a lapsed claim may be reclaimed only by its recorded runtime, stale attempts are fenced, and a request that exhausts its recovery budget fails visibly instead of staying pending.
- Show a failed Agent response as a failure in the timeline, with a retry that replays the request's exact recorded harness, provider, model, and runtime.

### Fixed

- Recover a request whose claiming runtime died, hung, or was rebuilt on another device, instead of leaving it unanswered forever.
- Stop an abandoned claim from permanently consuming its runtime's single active-claim slot and blocking every later request on that runtime.

## [0.1.0-alpha.5] - 2026-09-16

### Added

- Add repository-wide Agent instructions, contribution and interface-contract governance, Code Owner review routing, and a pull-request checklist for multi-developer work.
- Add explicit, icon-only workspace controls for collapsing either sidebar and opening session status details.

### Changed

- Make every manual Codex visible-history import create and verify a new local task, switch the Desktop binding and Hook allowlist only after verification, and leave the previous task for the user to archive.
- Limit automatic visible-history import to the first local creation of each cloud session or disable it entirely; realtime canonical context injection remains independent and always available while connected.
- Compact the workspace header, move project and session context into the top bar, improve the session-status presentation and translations, and hide Codex history/upload controls whenever Codex is disabled for the current project.
- Advance the fixed Codex connector, DeepSeek Harness plugin, Web onboarding, deployment preview, and release-verification metadata to `0.1.0-alpha.5` without overwriting immutable Alpha 4 artifacts.

### Fixed

- Avoid replace-in-place history imports that Codex Desktop can reject because the previous task is active or archived.
- Preserve a single authoritative binding after a successful import while preventing duplicate local projections from taking over the session.

### Security

- Verify each imported task is readable before persisting its binding, without taking over, deleting, or archiving a Desktop-held task.
- Keep empty-session visibility markers local-only and compact oversized snapshots within the configured context budget.

### Known limitations

- A manual import intentionally creates a new Codex task; the user reviews it and archives the previous task themselves.
- The hosted GatherThread service and public Beta remain closed; this Alpha supports local, private LAN HTTPS, private Tailscale, and operator-managed self-hosting.
- The fixed Git plugin reference requires a matching reviewed `v0.1.0-alpha.5` tag; npm publication alone does not create that Git ref.

## [0.1.0-alpha.4] - 2026-09-15

### Added

- Add a verified Codex Desktop visible-history import with manual refresh, empty-session support, and bounded automatic compaction.
- Add a project-level choice to import once when each session is first created locally or disable automatic visible-history import. New projects default to the first-session import.

### Changed

- Advance the fixed Codex connector, DeepSeek Harness plugin, Web onboarding, deployment preview, and release-verification metadata to `0.1.0-alpha.4` without overwriting immutable Alpha 3 artifacts.

### Security

- Verify each imported task is readable before persisting its binding, without trying to take over or delete a Desktop-held task.
- Keep empty-session visibility markers local-only and compact oversized snapshots within the configured context budget.

### Known limitations

- The hosted GatherThread service and public Beta remain closed; this Alpha supports local, private LAN HTTPS, private Tailscale, and operator-managed self-hosting.
- The fixed Git plugin reference requires a matching reviewed `v0.1.0-alpha.4` tag; npm publication alone does not create that Git ref.
- Alpha 4's replace-in-place import path may be rejected when the prior Codex task has an active writer or is archived; Alpha 5 replaces this with verified new-task import semantics.

## [0.1.0-alpha.3] - 2026-09-15

### Added

- Add an independent automatic-upload preference for every bound Codex and DeepSeek Harness conversation, enabled by default.
- Add explicit manual upload recovery that scans completed native turns even when a Codex Hook or DSH event was missed, while preserving the user's automatic-upload preference.
- Expose Codex upload controls through the user-only GatherThread MCP and DSH controls directly in the native GatherThread settings surface.

### Changed

- Keep cloud-to-local projection and Web Agent execution independent from the local-to-cloud upload preference.
- Serialize DSH polling and manual upload so slow transports cannot race the durable local-turn outbox.

### Security

- Route Codex controls through the existing capability-protected local relay without exposing the device credential to the plugin MCP.
- Reuse the authenticated, idempotent local-turn commit path for manual recovery and treat Hook-missed historical bases conservatively.

### Known limitations

- Codex manual recovery requires the connector to remain running in reviewed `--plugin-hooks` mode and accepts only completed, identifiable native turns.
- The hosted GatherThread service and public Beta remain closed; this Alpha supports local, private LAN HTTPS, private Tailscale, and operator-managed self-hosting.

## [0.1.0-alpha.2] - 2026-09-08

### Changed

- Label newly managed Codex Desktop, background, and immutable snapshot conversations with their initial uppercase `MULTI` or `SOLO` session type while preserving the suffix under Codex title truncation.
- Keep snapshot completion metadata identical to the actual native Codex title.
- Advance all fixed-version Codex connector, DeepSeek Harness plugin, Web onboarding, private deployment, and release-verification references to `0.1.0-alpha.2` without replacing the immutable `alpha.1` artifacts.

### Fixed

- Make the Codex plugin Hook relay preserve the connector's lexical workspace key before trying a canonical fallback and compare Windows paths case-insensitively.
- Make DSH path contract tests platform-aware so the Windows release gate validates native paths rather than POSIX-only fixture strings.
- Normalize checkout line endings in the Web onboarding contract test so Windows validates the same command text as POSIX.

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
- Attachments, retention workers, offline Web outbox, and open registration are not implemented.
- The DSH package is prepared but not published by this candidate; its verified npm Host surface is `@deepseek-ai/dsh@0.1.2-rc.1`, and DSH does not yet expose a stable root-version service or public plugin marketplace.
- Alibaba Cloud deployment is intended for a small, invitation-only beta and requires operator-managed domain, filing, security-group, monitoring, and restore checks.
- Public npm scope ownership, public plugin-directory distribution, and remote OAuth 2.1/PKCE MCP remain release follow-ups.

[0.1.0-alpha.5]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.1
