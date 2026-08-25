# Security policy and threat model

## Scope and current status

This document defines the first-release security boundary for the collaboration server, browser client, MCP surface, local bridge, transcript adapters, and operational tooling.

The repository contains an executable single-process alpha server and owner-host tooling. Automated checks cover core contracts, but passing `npm run verify` does not certify a host, tailnet policy, operating system, backup location, or Internet-facing deployment. Public ingress is unsupported for the first release.

## Assets and trust boundaries

Protected assets are canonical event content, membership and visibility state, bearer credentials, runtime registrations, local transcript paths, attachments, model/provider metadata, retention settings, backups, and audit records.

The main trust boundaries are:

1. Browser or CLI to collaboration server over HTTPS and WebSocket.
2. Local bridge to server over HTTPS and MCP Streamable HTTP.
3. Collaboration server to SQLite and attachment storage.
4. Bridge to local harness transcripts, provider context, filesystem, and tool approvals.
5. CI and dependency sources to the build and release artifacts.
6. Tailscale identity and grants to the loopback-only owner host exposed through Serve.

The collaboration service never inherits authority to approve local tools. Transcript access is opt-in and path-scoped. A remote request cannot broaden filesystem access or bypass the harness approval boundary.

## Security invariants

- Sessions are private by default. Public discovery and anonymous access are disabled.
- Public registration and production HTTP bootstrap are disabled. The first owner is created directly on the host.
- Invitation and device-authorization secrets are single-use, expire, are stored only as peppered digests, and never appear in URLs or logs.
- The server derives actor and runtime identity from authenticated credentials. A runtime is bound to the exact authenticated device, not merely another device belonging to the same user.
- Device revocation also revokes its runtimes and unused delegated authorizations, removes unused realtime tickets, and closes or revalidates active sockets.
- Authorization is checked on every implemented read, replay, subscribe, append, claim, completion, invitation, and device operation.
- A solo viewer cannot append any event. Rejection happens before sequence allocation or fan-out.
- Agent requests can be claimed only by an eligible runtime owned by the initiating user. Claim and completion transitions are atomic.
- Events become visible only after the database transaction commits. The durable log, not WebSocket delivery, is authoritative.
- Secrets, raw thinking, and private system or developer instructions are removed before persistence, logs, metrics, traces, and fan-out.
- Fidelity labels are server-validated. Reconstructed history cannot claim `provider_request` fidelity.

## Threat model

| ID | Threat | Required mitigation | Verification gate |
|---|---|---|---|
| T1 | Forged actor or runtime provenance | derive identity from credential; bind device and runtime server-side; reject client actor overrides | authorization and runtime-claim E2E |
| T2 | Cross-session IDOR | membership check for every session-scoped resource, including replay cursors and attachments | two-user negative API tests |
| T3 | Solo viewer write or privilege escalation | role and mode check in the append transaction; owner-only membership changes | solo viewer E2E |
| T4 | Idempotency poisoning | scope uniqueness to session; require the same actor, operation, and canonical payload hash on retry; return conflict for mismatches | retry and mismatch tests |
| T5 | Runtime claim theft or duplicate work | bind request, user, device, session, and runtime; atomic claim; one active turn per runtime | runtime claim and device-binding tests; abandoned-claim recovery remains open |
| T6 | Reorder, gap, or phantom event | allocate sequence in a write transaction; publish after commit; detect gaps and replay over authenticated HTTP | concurrent append and reconnect E2E |
| T7 | Credential or private-context exfiltration | structural allowlist, key-based and pattern redaction, excluded roles, size limits, and no payload logging | redaction E2E and secret scan |
| T8 | Transcript path escape | explicit owner opt-in; canonicalize path; deny symlink escape; allow regular files under approved roots only | adapter filesystem tests |
| T9 | Browser session theft, CSRF, or socket hijack | memory-only bearer for private alpha; one-use subprotocol socket ticket; strict production Origin checks; CSP; no token in URL; public ingress blocked until cookie/CSRF design | browser security tests |
| T10 | Resource exhaustion | request/JSON complexity and event limits; per-device/per-IP rate limits; per-user/session/deployment storage quotas; byte-bounded replay; socket backpressure | limit and reconnect tests |
| T11 | SQLite corruption or inconsistent backup | WAL and foreign keys; bounded transactions; online SQLite backup API; integrity check and restore drill | operational restore drill |
| T12 | Dependency or CI compromise | lockfiles, dependency review, license gate, secret scan, least-privilege workflow permissions, reviewed updates | CI checks and release review |

## Authentication and authorization requirements

High-entropy bearer tokens are generated by a cryptographic random source and stored as HMAC-SHA256 digests with a separately managed pepper. Passwords, if introduced, require a password hashing algorithm such as Argon2id and must not reuse the bearer-token path. Device credentials track issuance, last use, expiry, token version, rotation, and revocation.

The private owner-host alpha keeps a manually entered bearer only in browser memory, obtains a 30-second one-use session-scoped WebSocket ticket, and carries that ticket in a WebSocket subprotocol rather than a URL. When an Origin allowlist is configured, WebSocket upgrades without an allowed `Origin` fail closed. A future Internet-facing deployment must replace this flow with `HttpOnly; Secure; SameSite=Strict` cookies plus CSRF protection and undergo a separate review. Tokens must never appear in URLs.

Invitation tokens are single-purpose, one-use, and stored as peppered digests. Owners choose one hour, 24 hours, or seven days, with 24 hours as the default. Acceptance is transactional and audits the inviter, recipient, role, session, and time without logging the token. Additional devices use a separate ten-minute one-use authorization.

## Persistence and redaction requirements

Validate all events against a strict schema and reject unknown fields where practical. Enforce request byte, JSON depth/node, single-event, replay-page, and cumulative storage limits. Per-user, per-session, and deployment event usage is charged in the same SQLite transaction as sequence allocation and insertion. Database queries use parameters and SQLite foreign keys are enabled.

Redaction must happen at the earliest trusted boundary, before persistence and fan-out. It should combine an event-type allowlist with recursive sensitive-key handling and credential patterns. Regex-only redaction is insufficient. Redaction failures must fail closed for transcript and provider-context uploads. Store a redaction policy version and fidelity label, not the removed value.

Logs may contain request ID, hashed user or session identifier, event type, sequence, status, latency, byte count, and redaction count. Logs must not contain authorization headers, cookies, invitation tokens, raw request bodies, event payloads, transcript paths, query strings, model prompts, tool arguments, tool results, stack traces returned to clients, or database rows.

## Default private deployment

The application binds to loopback, serves Web/API/WebSocket on one origin, sets session visibility to private, and disables anonymous/public sessions and network bootstrap. Production startup fails without declared HTTPS termination, an exact public origin, a non-placeholder credential pepper, explicit HTTP/WebSocket origins, a static build, and a writable database directory with restrictive permissions.

The supported alpha path is Tailscale Serve inside a private tailnet. The application port remains on loopback, Funnel is disabled, and tailnet grants allow only named collaborators to TCP 443. HTTP and WebSocket paths still require GatherThread authentication and ACL checks. Direct Internet exposure is unsupported. See `SELF_HOSTING.md` and `OPERATIONS.md` for the preflight and backup gates.

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
