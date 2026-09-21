# Security policy and threat model

## Scope and current status

This document defines the first-release security boundary for the collaboration server, browser client, MCP surface, local bridge, transcript adapters, and operational tooling.

The repository contains an executable single-process `0.1.0-alpha.5` server and owner-host tooling. Automated checks cover core contracts, but passing `npm run release:verify` does not certify a host, network policy, operating system, filing status, backup location, or Internet-facing deployment. Public ingress is prepared only through the documented invitation-only Alibaba Cloud ECS profile and still requires operator preflight and monitoring; no official hosted service is open in this Alpha.

## Assets and trust boundaries

Protected assets are canonical event content, membership and visibility state, bearer credentials, runtime registrations, snapshot jobs and result metadata, local transcript paths, connector cursors and outboxes, hook registry/spool content, attachments, model/provider metadata, retention settings, backups, and audit records.

The main trust boundaries are:

1. Browser or CLI to collaboration server over HTTPS and WebSocket.
2. Local bridge to server over HTTPS and MCP Streamable HTTP.
3. Collaboration server to SQLite and attachment storage.
4. Bridge to local harness transcripts, provider context, filesystem, and tool approvals.
5. CI and dependency sources to the build and release artifacts.
6. The selected network edge: a dedicated Caddy listener on a trusted LAN interface, Tailscale identity and grants, or the restricted Caddy edge on the Alibaba Cloud ECS profile.
7. Codex project hooks and local App Server processes to the connector's private socket, registry, spool, and native-thread state.
8. The ZCode headless connector to its spawned CLI child processes, binding state files, and the local ZCode installation they execute.

The collaboration service never inherits authority to approve local tools. Transcript access is opt-in and path-scoped. A remote request cannot broaden filesystem access or bypass the harness approval boundary.

## Security invariants

- Projects are private by default. Public discovery and anonymous access are disabled.
- Public registration and production HTTP bootstrap are disabled. The first owner is created directly on the host.
- Invitation and device-authorization secrets are single-use, expire, are stored only as peppered digests, and never appear in URLs or logs.
- Browser session secrets are stored only as peppered HMAC digests. The default session has a 24-hour absolute lifetime and a non-persistent Cookie; an explicit **Remember this device** choice uses a 30-day persistent Cookie. Both use `HttpOnly; SameSite=Strict; Path=/`, add `Secure` and `__Host-` under HTTPS, and are revoked by logout, device revocation, or device-token rotation.
- The server derives actor and runtime identity from authenticated credentials. A runtime is bound to the exact authenticated device, not merely another device belonging to the same user.
- Device revocation also revokes its runtimes and unused delegated authorizations, removes unused realtime tickets, and closes or revalidates active sockets.
- Authorization is checked on every implemented project, session, replay page, subscribe, live fan-out, socket heartbeat, append, claim, completion, invitation, and device operation. Membership removal closes affected sockets before another event or cursor is emitted.
- A project participant can write `multi`; an owner or participant can write only a Solo whose immutable creator ID matches the authenticated actor. A project viewer reads every session. Rejection happens before sequence allocation or fan-out.
- Only the project owner can create `multi`, issue invitations, or change another member's project role. Owners and participants can create personal `solo`; a project owner has no write override on another member's Solo. Role changes cover current and future sessions and revoke newly ineligible runtimes.
- A session's immutable creator or the project owner may delete its cloud copy; only the project owner may delete a cloud project. Authorization and deletion occur in one transaction, dependent cloud data is removed by foreign-key cascade, and affected sockets and unused realtime tickets are invalidated. No server deletion path invokes local filesystem or native-task deletion.
- Agent requests can be claimed only by an eligible runtime owned by the initiating user. Claim and completion transitions are atomic.
- A direct local harness turn is accepted only from the authenticated actor's exact execution runtime. Its request, bounded tool events, and response commit in one transaction; an exact retry returns the original event set and a mismatched retry conflicts.
- Runtime purpose is server-validated. A `snapshot_connector` may read and project only its authenticated user's requested frozen session snapshot; it cannot claim an Agent request or publish a local turn.
- Snapshot jobs are private requester-scoped control-plane records, not canonical conversation events. Every job is charged a conservative 1 KiB metadata allowance, one completion/failure result is limited to 8 KiB UTF-8 JSON, and cumulative storage defaults to 4 MiB per user, 8 MiB per session, and 64 MiB per deployment. Unfinished jobs are additionally capped at 64 per user, 256 per session, and 4096 per deployment.
- Immutable snapshot jobs require read access; Desktop-visible import jobs additionally require current write access. An import refuses pending or unuploaded local turns, verifies the new native task before switching, updates the private Hook allowlist without exposing credentials, and treats its generated empty-session marker and compact summary as local-only data. It never deletes or archives the previous native task.
- Events become visible only after the database transaction commits. The durable log, not WebSocket delivery, is authoritative.
- Secrets, raw thinking, and private system or developer instructions are removed before persistence, logs, metrics, traces, and fan-out.
- Fidelity labels are server-validated. Reconstructed history cannot claim `provider_request` fidelity.
- Shared attribution keeps the username, harness, provider, model, and fidelity needed for collaboration. A non-owner reading another user's activity receives placeholders instead of local device, runtime, and native-session identifiers; canonical event storage never retains a raw native-session identifier.
- The built-in Codex connector treats prior shared events as untrusted data, accepts execution only for the server-verified initiating user's request, retains a bounded local sandbox, and disables automatic privilege escalation.
- Codex hook installation is explicit and subject to project trust review. A private registry allowlists managed execution thread IDs before relay or offline spooling; unrelated tasks and immutable snapshot threads are rejected locally.
- Compatible Codex 0.151 native projection rechecks that the Desktop task is idle before a brief rejoin and `thread/inject_items`; active turns queue the update, incompatible clients retain the Hook capsule, and ambiguous multiple Codex runtimes fail closed.
- DSH canonical projection uses only public Session append/flush services, persists projected event IDs before advancing its cursor, and uploads native turns through a durable outbox plus one authenticated `commitLocalTurn`. During a claimed prompt, only generic metadata-free progress derived from newly durable DSH events may renew the lease.
- An `agent_request` is executable only by its selected authenticated runtime. Other harness connectors may passively project the canonical result but cannot claim the request.
- Conversation reconciliation can replace only the connector's native-thread binding. It does not reset, check out, or overwrite the local source working tree, and the previous thread is preserved as an offline fork.
- Conversation synchronization is not a global lock for source files; concurrently running harnesses in one working directory can still produce ordinary filesystem conflicts.

## Threat model

| ID | Threat | Required mitigation | Verification gate |
|---|---|---|---|
| T1 | Forged actor or runtime provenance | derive identity from credential; bind device and runtime server-side; reject client actor overrides | authorization and runtime-claim E2E |
| T2 | Cross-project or cross-session IDOR | project-membership check for every project/session resource, including replay cursors and attachments | two-user negative API tests |
| T3 | Project role or solo-mode privilege escalation | project role and session mode check at the mutation boundary; owner-only role changes | participant/viewer and solo/multi E2E |
| T4 | Idempotency poisoning | scope uniqueness to session; require the same actor, operation, and canonical payload hash on retry; return conflict for mismatches | retry and mismatch tests |
| T5 | Runtime claim theft or duplicate work | bind request, user, device, session, and exact runtime; atomic claim; one active turn per runtime; lease renewal only by accepted progress; require the current claim attempt on progress, completion, and request-linked tool events; reject request-linked Agent responses on the generic append route; generate terminal-failure idempotency keys inside the server transaction | runtime claim, device-binding, exact-runtime reclaim, stale-attempt tool/progress/completion, generic-completion bypass, single-slot, idempotency-poisoning, and bounded-recovery tests |
| T6 | Reorder, gap, or phantom event | allocate sequence in a write transaction; publish after commit; detect gaps and replay over authenticated HTTP | concurrent append and reconnect E2E |
| T7 | Credential or private-context exfiltration | structural allowlist, key-based and pattern redaction, excluded roles, size limits, and no payload logging | redaction E2E and secret scan |
| T8 | Transcript path escape | explicit owner opt-in; canonicalize path; deny symlink escape; allow regular files under approved roots only | adapter filesystem tests |
| T9 | Browser session theft, CSRF, or socket hijack | opaque HttpOnly session cookie; SameSite Strict; Secure and `__Host-` under HTTPS; exact allowed Origin required for every cookie-authenticated write; one-use subprotocol socket ticket; CSP; no token in URL or Web Storage | browser security tests |
| T10 | Resource exhaustion | request/JSON complexity and event limits; per-device/per-IP rate limits; per-user/project/deployment session-count limits; per-user/session/deployment storage quotas; byte-bounded replay; socket backpressure | limit and reconnect tests |
| T11 | SQLite corruption or inconsistent backup | WAL and foreign keys; bounded transactions; online SQLite backup API; integrity check and restore drill | operational restore drill |
| T12 | Dependency or CI compromise | lockfiles, dependency review, license gate, secret scan, least-privilege workflow permissions, reviewed updates | CI checks and release review |
| T13 | Shared-history prompt injection causes unintended local action | separate the authenticated current request from prior untrusted context; claim only the initiating user's request; retain read-only/workspace-write sandbox; disable automatic escalation; allow final-answer-only sharing | Codex prompt/argument tests and real CLI smoke test |
| T14 | Local turn retry triggers duplicate shared work or loses cloud order | durable stable-ID outbox; atomic local-turn commit; exact-retry payload match; server reports divergence; rebuild and verify canonical projection before switching | local-turn idempotency, offline-divergence, and rebuild tests |
| T15 | Project hook captures an unrelated or read-only Codex task | explicit hook installation/trust; private workspace-bound registry; allowlist execution thread IDs before relay/spool; reject snapshot thread IDs | hook merge, registry, unrelated-task, and snapshot-isolation tests |
| T16 | Snapshot worker gains write authority or exhausts storage | distinct runtime purpose; same-user/device/session checks; frozen sequence; no canonical event; per-row metadata charge; active-count, per-result, and cumulative quotas; byte-bounded listing | snapshot ACL, purpose, idempotency, quota, and integration tests |
| T17 | A role downgrade or project removal later uploads work created while read-only | reconcile only from a successful authoritative ACL response; remove affected execution bindings and clear unpublished local state; preserve but never retroactively upload the native transcript; explicit 403/404 project cleanup | owner-to-viewer, participant-solo, removal, transient-failure, and regrant tests |
| T18 | Hook discovery creates a cloud Solo from an unrelated, viewer-owned, background, or snapshot task | exact workspace match; authoritative project-role recheck; viewer discovery disabled; explicit background/snapshot purposes; stable hashed creation key; server-side creator ACL | first-prompt discovery, viewer no-op, purpose isolation, and idempotent retry tests |
| T19 | Passive projection echoes a canonical event or another harness executes the same request | durable per-runtime cursor and projected event IDs; server-bound selected runtime; atomic idempotent local-turn commit; ambiguous Codex selection fails closed | cross-harness replay, echo-suppression, runtime-selection, and switch tests |

## Authentication and authorization requirements

High-entropy bearer tokens are generated by a cryptographic random source and stored as HMAC-SHA256 digests with a separately managed pepper. Passwords, if introduced, require a password hashing algorithm such as Argon2id and must not reuse the bearer-token path. Device credentials track issuance, last use, expiry, token version, rotation, and revocation.

The private owner-host exchanges a manually entered device bearer for a separate opaque browser session, then clears the bearer from JavaScript. The browser token is never returned in JSON and is available only through an `HttpOnly; SameSite=Strict; Path=/` Cookie. Without an explicit remember choice, its database record has a 24-hour absolute expiry and the Cookie has no persistent expiry directive. **Remember this device** extends both to 30 days with `Max-Age` and `Expires`. Only an HMAC-SHA256 digest is stored. Production HTTPS adds `Secure` and the `__Host-` prefix without a `Domain` attribute. A new login atomically revokes the previous browser session for that device before issuing a replacement. Every cookie-authenticated state-changing request requires an exact configured `Origin`, while WebSocket upgrades require an allowed Origin and use a separate 30-second one-use session-scoped ticket carried in a subprotocol. Logout revokes the current browser session and expires the cookie. Device revocation and token rotation revoke every browser session for that device. Tokens must never appear in URLs, Web Storage, logs, or telemetry.

Invitation claim plus optional browser-session issuance is one SQLite transaction, so a Cookie issuance failure cannot consume the invitation while losing the new identity. The newly issued device token is still returned once to the invitee and displayed in a blocking copy dialog; it is not persisted by the page. This credential is the recovery path after the browser session ends.

Invitation tokens are project-scoped, single-purpose, one-use, and stored as peppered digests. Owners choose `participant` or `viewer` and an expiry of one hour, 24 hours, or seven days, with 24 hours as the default. Acceptance is transactional and audits the inviter, recipient, role, project, and time without logging the token. Owners may later change another member's role; that authorization is enforced across current and future sessions. Additional devices use a separate ten-minute one-use authorization.

The browser-session controls follow the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), the [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), and [MDN Set-Cookie guidance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

## Persistence and redaction requirements

Validate all events against a strict schema and reject unknown fields where practical. Enforce request byte, JSON depth/node, single-event, replay-page, snapshot-result, active-job, and cumulative storage limits. Per-user, per-session, and deployment event usage is charged in the same SQLite transaction as sequence allocation and insertion. Snapshot row metadata is charged at creation and completion/failure bytes are added atomically to a separate cumulative ledger; list responses are newest-first and bounded to 128 KiB by default. Database queries use parameters and SQLite foreign keys are enabled.

Redaction must happen at the earliest trusted boundary, before persistence and fan-out. It should combine an event-type allowlist with recursive sensitive-key handling and credential patterns. Regex-only redaction is insufficient. Redaction failures must fail closed for transcript and provider-context uploads. Store a redaction policy version and fidelity label, not the removed value.

Agent progress accepts only bridge-generated lifecycle status and public `agentMessage` commentary from the harness. Hidden reasoning items and chain-of-thought are neither persisted nor rendered. Markdown rendering keeps raw HTML and dangerous URL protocols disabled; generated links are protocol-checked, isolated with `noopener noreferrer`, and remote Markdown images are replaced with inert labels to avoid implicit third-party requests. KaTeX is bundled locally with trust disabled and bounded macro expansion and sizing. Its generated positioning requires inline style attributes, but scripts remain restricted to same-origin static assets.

Logs may contain request ID, hashed user or session identifier, event type, sequence, status, latency, byte count, and redaction count. Logs must not contain authorization headers, cookies, invitation tokens, raw request bodies, event payloads, transcript paths, query strings, model prompts, tool arguments, tool results, stack traces returned to clients, or database rows.

## Local connector and hook boundary

The connector strips GatherThread credentials from the Codex child environment and never writes them to hook configuration, process arguments, native threads, registry, or spool. Local projection state, outbox, registry, and spool files are written atomically with mode `0600`; containing directories and the Unix socket path must be private. These files can contain local or shared conversation content even when they contain no bearer token, so host-account and disk protection remain required.

Headless Codex execution declines MCP form and URL elicitations without opening links or supplying data. Command, file-change, permission, and unknown App Server interactions continue to fail closed.

The preferred `--plugin-hooks` mode activates only the reviewed `UserPromptSubmit` and `Stop` definitions shipped with the **共序 / GatherThread** plugin. The built-in no-dependency forwarder calls the running connector directly and never invokes `npx` per turn. It has no offline spool. `--install-hooks` remains an explicit compatibility mode that merges equivalent definitions into the existing project configuration and provides a bounded private spool. Both modes require a user Hook review and trust decision before automatic publication. A per-conversation durable preference gates Hook outbox commits. The connector scans native App Server history only after an explicit manual-upload action, accepts only one identifiable user message plus a completed final answer, excludes connector-authored turns and known bindings, and uses an unknown canonical base for Hook-missed turns. The two Hook modes remain mutually exclusive. If a previously generated `.codex/hooks.json` remains after switching to plugin mode, the connector does not delete it: a private registry plus relay source envelope authorizes exactly one Hook source, so the retained project Hook returns no context, cannot spool, and is never drained in plugin mode.

The registry is bound to the selected workspace and labels known native threads as `execution`, `background_execution`, `snapshot_connector`, or `local_only`. An unknown thread can reach first-prompt discovery only while the current authoritative role is owner or participant; a viewer disables discovery. Known background, snapshot, and local-only threads remain rejected even during discovery. A visible-history import marks the previous task local-only before authorizing the verified replacement, so continuing the retained task cannot create a new GatherThread binding or cloud session. The raw native thread ID is not sent to the server: a device/project/thread hash supplies the stable creation key. Hook input, response, and additional context are bounded, malformed events fail closed, and an active non-stale relay socket is never replaced. Relay bodies are marked as untrusted data, split only on UTF-8 boundaries, and tied to event ID plus SHA-256 digest. The delivery cursor advances only after a completed Stop; cancellation or uncertain delivery repeats the same persisted capsule rather than skipping content.

The plugin's user MCP surface reaches one or more running connectors through a separate local relay. Its active registry contains only leased instance, endpoint, and project routing metadata. An unpredictable per-run capability is stored separately with current-user filesystem protections; neither record contains the GatherThread bearer. Read discovery aggregates every active registration, and both reads and writes fail closed if the result would be ambiguous or incomplete. Runtime registration, request claiming/completion, and snapshot upload stay on a separate internal MCP profile and are not model-callable through the user plugin. On Windows the named-pipe path is not treated as authorization; the random capability is mandatory, and a native two-account ACL test remains a public-release gate.

A hook draft queues fallback-capsule acknowledgement, local-turn upload, compaction, and reconciliation until the matching Desktop `Stop` exposes the final turn. On compatible Codex 0.151 clients, passive canonical projection is separate: it first observes the Desktop task as idle, briefly rejoins it, persists `thread/inject_items`, and releases the client; an active turn queues the update. App Server thread status is a point-in-time safety check, not a proven atomic lock across independent App Server processes, so a failed rejoin or ambiguous runtime must stop without mutation. `thread/unsubscribe` is lifecycle cleanup and must not be treated as a lock. Web-triggered execution stays in the background projection.

The DSH plugin stores its server cursor, projected-event IDs, local-turn outbox, and per-conversation automatic-upload preference in private persistent state. Automatic capture checks that preference before staging or sending a local turn. An explicit manual action may scan the same allowlisted completed-turn surface and flush it without changing the preference. The connector advances projection only after public `Session.append` with `surfaceOp: "append"` and flush succeed, and advances an outgoing turn only after the authenticated server returns its canonical event bindings. An unselected DSH or Codex runtime may receive passive canonical updates but cannot claim the request. These controls prevent duplicate conversation execution; they do not serialize tools or direct file edits performed by different harnesses.

The ZCode connector holds the GatherThread device credential only in its own process, strips every GatherThread credential from the headless child environment, and never writes credentials to binding state, prompts, logs, or commands. It resolves the ZCode CLI without a shell, probes required headless capabilities structurally plus a live ZCode Protocol handshake before connecting, and refuses unsupported builds instead of degrading. Server-initiated permission, user-input, and provider-header interactions are declined: the connector never grants local tool approval remotely. Binding state is versioned, written atomically with private permissions, and contains native session ids, cursors, and the execution journal but never credentials; the write-ahead journal records the native result before the bridge appends anything canonical, so a restart or transport failure replays the recorded answer exactly once and an interrupted execution refuses to re-run. Prior shared events, excluding the connector's own earlier output, are quoted into the headless prompt as untrusted data; only the final answer can return to canonical history by default, and redacted tool events only after explicit operator opt-in for tools on the reviewed exact-name allowlist with bounded values, so hidden reasoning, private provider traffic, and ZCode's private session store never enter the server. Its executed request remains bound to the authenticated initiating user's exact runtime through the shared claim contract, and it publishes nothing from local turns in this slice.

## Default private deployment

The application binds to loopback, serves Web/API/WebSocket on one origin, keeps projects private, and disables anonymous/public discovery and network bootstrap. Production startup fails without declared HTTPS termination, an exact public origin, a non-placeholder credential pepper, explicit HTTP/WebSocket origins, a static build, and a writable database directory with restrictive permissions.

The supported beta paths are local-only loopback, private LAN HTTPS through the supplied Caddy profile, Tailscale Serve inside a private tailnet, and the invitation-only Alibaba Cloud ECS profile. The application port remains on loopback in every mode. Public ECS traffic terminates only at Caddy on 80/443, HTTP bootstrap and anonymous registration remain disabled, and every HTTP/WebSocket operation still requires GatherThread authentication and ACL checks. Arbitrary direct exposure, default port 18787 ingress, router port forwarding, certificate-warning bypasses, Funnel, and unauthenticated public tunnels are unsupported. See `CONNECTION_MODES.md`, `ALIYUN_ECS.md`, `SELF_HOSTING.md`, and `OPERATIONS.md` for the preflight and backup gates.

## Supply chain, attribution, and licenses

Run these checks on every pull request:

```sh
npm run audit:references
npm run audit:licenses
npm run audit:secrets
npm run audit:vulnerabilities
```

`docs/REFERENCES.md` is research attribution, not permission to copy. Before adapting code, record project, exact upstream URL and path, immutable commit, applicable SPDX license, copyright notice, modifications, and the destination source header. Preserve required notices in the distribution. A reviewer must verify license compatibility before merge.

Installed dependencies are checked against a conservative allowlist. Copyleft, source-available, custom, dual-license, `SEE LICENSE IN`, and missing metadata require human review. CI dependency review blocks known denied licenses and moderate-or-higher disclosed vulnerabilities. Commit the package-manager lockfile whenever dependencies are introduced.

Baseline finding on 2026-08-25: the `acp-memory-server` reference says only `See upstream repository`; its exact license must be resolved before any adaptation. No production dependency tree exists yet, so the current license scan cannot establish future compatibility.

## Vulnerability handling

Do not open a public issue containing an exploit, token, private transcript, or personal data. Report privately to the deployment owner through the configured security contact. The owner should acknowledge, preserve redacted evidence, revoke affected credentials, contain exposure, patch, restore or replay from trusted state, and publish a scoped incident summary after remediation.
