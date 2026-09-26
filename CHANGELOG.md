# Changelog

All notable changes to GatherThread are documented here. The project follows Semantic Versioning while pre-release APIs may still change.

## [Unreleased]

- Add a back-to-bottom control to the shared conversation timeline. It appears once the reader scrolls away from the newest event, hides again at the bottom, and follows the reader's reduced-motion preference when it jumps.
- Prepared public-repository documentation and discoverability updates: bilingual README introductions, documentation/release indexes, private security-reporting policy, product-home metadata, and clearer Alpha access guidance. This does not itself deploy the hosted site or publish a new package.
- The npm Alpha 7 packages were published separately and were not rebuilt when the Git tag moved to the verified server source.
- Add ZCode as a third harness through the standalone `@gatherthread/zcode-connect` connector: headless CLI discovery and structural preflight probing, one execution runtime per writable session, claimed Web Agent request execution in a bounded headless ZCode child, incremental canonical-history hydration with native session resume, and versioned private binding state (see [ADR-0031](docs/adr/0031-add-zcode-as-a-third-harness-through-a-standalone-headless-connector.md)).
- Add a ZCode Protocol app-server client and event parser, plus the `zcode` harness name, to the shared adapters and bridge registries. Execution uses the official `zcode app-server` stdio protocol with live preflight handshake, protocol-version refusal, and durable write-ahead execution journaling so retries replay a finished native turn exactly once.
- Add ZCode to the Web workspace: agent harness selection, runtime resolution, connector command dialog, and bilingual copy.

### Known limitations

- The ZCode connector covers the Web Agent execution loop only. Local direct-ZCode turn capture through reviewed ZCode hooks, per-conversation upload preferences, visible-history import, snapshots, and first-prompt discovery remain future phases; the connector never reads ZCode's private session store.
- Headless ZCode behavior (permission prompts, model availability) requires a real-device smoke test before release.

## [0.1.0-alpha.7] - 2026-09-24

### Added

- Separate operator-issued, single-use Alpha test qualification from project invitations. A qualified account can create projects; an invitation-only guest can work only in invited projects and cannot create one through current or compatibility APIs.
- Let the operator issue or revoke unclaimed test qualifications locally, and let users set their own display and device names above either first-use login path. Existing device-token login can update those names without changing project permissions.
- Keep accounts whose browser explicitly chose **Remember this device** in a local sign-in chooser, with editable last-used display and device names. Signing out ends the active session but leaves the remembered account available; **Forget this account** removes its shortcut.
- Show a blocking, in-page cloud Git notice the first time a browser device enters the workspace, before code controls are used. It explains project-only collaboration, member-wide branch visibility, local opt-in, disablement, and cleanup without requesting browser notification permission.
- Add a 128 MiB per-user logical active cloud-code quota alongside the 256 MiB project and 1 GiB deployment caps, plus role-scoped Settings cleanup: members can clear their own branch and project owners can also clear all cloud Git data for their project. Local Git is never deleted.
- Add an Issue-only Alpha access request entry in the product home, bilingual README, and GitHub Issue template; no server-side applicant form or personal-profile collection is introduced.

### Changed

- Make the product home server-first for the invitation-only `gatherthread.cn` Alpha, describe optional cloud Git, and publish GitHub Issues plus `coolhezi@sjtu.edu.cn` as contact paths. Keep public registration and public Beta closed.
- Refresh current setup and operations guides to distinguish the live invitation-only service from the separately reviewed release/tag/package lifecycle. Historical release notes remain unchanged.

### Security and privacy

- Test-access Issues may include an applicant email only when that applicant is comfortable publishing it. Credentials, qualification codes, device tokens, private transcripts, and private source must never be posted; approved codes are delivered only through a private channel.
- Cloud Git cleanup revokes API access and releases active logical quota, but physical Git objects and earlier backups remain until separate operator-approved retention cleanup. The ECS backup has a paired Git-object companion that must rotate and restore with SQLite; cleanup is not immediate secure erasure of every copy.

### Migration and compatibility

- Existing device credentials and project memberships remain valid. The first account and existing project owners retain project-creation permission; existing invite-only accounts without an owned project become project-scoped guests. The activation token is not reusable for login: its recipient receives a separate device token.

### Initial Alpha 7 preview (2026-09-23)

#### Added

- Opt-in project code collaboration backed by standard bare Git storage, with per-member branches, bounded source checkpoints, review requests, owner-approved three-way merges and safe updates from main.
- Independent local code-upload consent and automatic-upload preference for Codex and the native DSH plugin. Manual upload, clean download and recovery into a new sibling directory are available through exact-runtime control jobs; DSH also exposes them in its settings panel.
- A compact Web code dialog with source-change review, stale-version checks, bilingual recovery guidance and explicit runtime selection. Conversation upload, native-history import and context injection remain independent.
- Writer-initiated shared history summaries from selected public messages or earlier completed summaries, using the writer's own local Agent. The Web workspace preserves raw history and older versions, provides a compact/original switch, and offers per-user project context policy (summary by default) and customizable/resettable instructions. The derived context API and MCP read are separate from canonical replay.

#### Safety and current limits

- Code sync does not change an existing local Git branch, index or remote. Credentials, harness state, symlinks and unsafe paths are excluded or rejected. Stale devices cannot overwrite another uploaded version; automatic upload pauses on large deletions or an interrupted download.
- This Alpha uses one branch per member/project, not automatic task worktrees or a public Git smart-HTTP service. Concurrent Agents must not write the same directory. Only uploaded, eligible source files can be recovered.
- Shared summaries are explicitly lossy and never delete canonical source messages. Source selection, generated prompts, ancestry validation and derived reads have independent resource limits; oversized input fails instead of being silently shortened. Native Codex/DSH automatic compaction remains separate.

#### Audit fixes

- Reject known credentials consistently before local source upload and server Git persistence; reject malformed Unicode and filesystem aliases of private state.
- Preserve automatic-upload stability checks through the final inventory, treat incomplete Codex work conservatively, and recover from transient code locks or lost acknowledgements without interrupting conversation sync.
- Support bounded maximum-size file inventories and long portable filenames without breaking local state or temporary-file creation.
- Reject hard-linked transcript files and recheck file identity inside authorized roots.
- Serialize native DSH pairing/configuration, prevent late configuration from restoring a disconnected pairing, and refresh native permissions when project roles change.
- Bound MCP HTTP/stdio input and batch processing, validate JSON-RPC IDs before tool dispatch, and describe manual Codex history import accurately as a new, non-idempotent local task.
- Fence stale Web authentication/project/session responses, preserve newly edited drafts, prevent duplicate sends and require exact local-upload device selection. Bind review confirmations to their precise preview and reject cross-origin browser API overrides before forwarding credentials.
- Prefer Codex native model capacity and fresh last-request usage instead of a fixed 4K window or cumulative token spending; distinguish native compaction from text clipping. Preserve complete accepted incoming DSH public messages without altering native compaction/model preferences or outgoing privacy limits.
- Keep Codex injection token estimates conservative when App Server usage notifications arrive after an earlier chunk, while still accepting a distinct native turn or fresh post-compaction usage.
- Use Git for Windows-compatible null-device paths for isolated server and backup Git operations, and make the storage-quota regression independent of filesystem-specific directory sizes.
- Preserve Codex bindings when required native compaction fails or still exceeds the safe budget. Persist a recovery pause when no usable fresh usage is available, preventing repeated background compaction/rebuild; this exceptional pause has no reset control in the preview and cannot be bypassed by reconnecting with the same usage or changing the model.
- Clarify native context management and Codex's fallback-only estimate in both UI languages. Native compaction can use model quota; first oversized DSH imports remain subject to the pinned native engine's limitations.

## [0.1.0-alpha.6] - 2026-09-22

### Added

- Lease Agent claims and bound exact-runtime recovery. A claim is renewed only by accepted progress, a lapsed claim may be reclaimed only by its recorded runtime, stale attempts are fenced, and a request that exhausts its recovery budget fails visibly instead of staying pending.
- Show a failed Agent response as a failure in the timeline, with a retry that replays the request's exact recorded harness, provider, model, and runtime.
- Let compatible DeepSeek Harness runtimes advertise executable model and reasoning-effort combinations so each new Agent request can select them directly from the GatherThread work page.
- Persist runtime execution profiles across the protocol, server, bridge, Web client, and DSH plugin while retaining compatibility with older fixed-profile runtimes.

### Changed

- Discover `deepseek-official` models through the DSH Host's public LLM services and apply the selected model and reasoning effort only for the requested turn, restoring the prior native selection afterward.
- Advance the fixed Codex connector, DeepSeek Harness plugin, Web onboarding, deployment preview, and release-verification metadata to `0.1.0-alpha.6` without overwriting immutable Alpha 5 artifacts.

### Fixed

- Recover a request whose exact bound runtime restarts or resumes after a stalled execution, instead of leaving it unanswered forever.
- Stop an abandoned claim from permanently consuming its runtime's single active-claim slot and blocking every later request on that runtime.
- Keep legacy, unsupported, non-DeepSeek, and ambiguous DSH runtimes on their existing fixed model path rather than silently falling back or misrouting a request.

### Security

- Keep runtime, provider, model, and reasoning selection exact and fail closed at both the server claim boundary and the DSH execution boundary.

### Known limitations

- Dynamic model and reasoning selection is available only when an exact compatible DSH runtime advertises execution profiles; other providers continue to use their native fixed selection.
- The hosted GatherThread service and public Beta remain closed; this Alpha supports local, private LAN HTTPS, private Tailscale, and operator-managed self-hosting.

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

[0.1.0-alpha.7]: docs/releases/0.1.0-alpha.7.md
[0.1.0-alpha.6]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: docs/releases/0.1.0-alpha.4.md
[0.1.0-alpha.3]: docs/releases/0.1.0-alpha.3.md
[0.1.0-alpha.2]: https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: docs/releases/0.1.0-alpha.1.md
