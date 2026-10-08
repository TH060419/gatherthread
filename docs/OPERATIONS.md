# Operations guide

## Release state

This guide covers the executable single-process profile, with source version identifier `0.1.0-beta.1`, and the operator-managed Alibaba Cloud ECS profile for `https://gatherthread.cn`. Beta 1 publication targets npm and the isolated `https://test.gatherthread.cn` service only; production promotion needs separate authorization and acceptance. The Beta account path uses verified-email registration and password sign-in, not an invitation-only account system. The canonical environment contract is `.env.example`; generic `HOST`, `PORT`, and `DATABASE_PATH` variables are intentionally ignored. Supported edges are local-only loopback, private LAN HTTPS, private Tailscale Serve, and the ECS HTTPS edge. The application remains on loopback in every mode. Documentation does not activate a deployment: complete the public-registration preflight below before opening signup, and keep the held Cloud Agent entry unchanged.

## Independent test service

The `test.gatherthread.cn` environment uses a separate process/user, env, database, cloud Git, admission store, backups, secrets and bounded resources. See [TEST_ENVIRONMENT.md](TEST_ENVIRONMENT.md) for templates, administrator code issuance, provider checks and the fixed-commit same-artifact test-to-production procedure. Testing never promotes automatically; the server-management chat executes each authorized deployment. Test signup/recovery reuse the current email-account system and require their own provider and rollout checks.

## Private-by-default startup

The safe local baseline is one process bound to loopback with an on-disk SQLite database under a directory readable only by the service account. Projects are private, public discovery is disabled, payload logging is disabled, and transcript upload excludes raw thinking and private instructions.

Copy `.env.example` to the ignored `.env` and restrict it to the host account. A blank Pepper is generated atomically by `owner-host:init`, or a stable value may be injected by a secret manager. Never commit the populated file. See `SELF_HOSTING.md` for private configuration and startup commands.

Production preflight must fail if any of these are absent or unsafe:

- `NODE_ENV=production` with `GATHERTHREAD_SERVER_HOST` restricted to loopback behind an approved HTTPS edge.
- A cryptographically random `GATHERTHREAD_AUTH_TOKEN_PEPPER` of at least 32 bytes.
- An exact HTTPS `GATHERTHREAD_PUBLIC_BASE_URL`, explicit origin allowlist, and `GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true`.
- Private session default and public sessions disabled.
- Existing writable database and backup directories owned by the service account.
- Request, event, replay-page, attachment, and WebSocket queue limits.
- A tested backup plus a restore drill completed for the release schema.

Email/password login creates an opaque server-side session without returning a user access token. Its Cookie is `HttpOnly; SameSite=Strict; Path=/`, with a peppered digest and a 24-hour absolute database expiry. Choosing **Remember this device** makes that Cookie persistent and extends the session to 30 days. Refresh restores the eligible email account session; closing the browser discards only a non-persistent Cookie. Logout revokes the active session and clears the Cookie. The retired remembered-account vault has no quick-login or account-listing route. Do not remember a session in a shared browser profile. Production HTTPS adds `Secure` and `__Host-`. Cookie-authenticated writes require the exact allowlisted public origin. Registration remains closed until its separate provider, security and rollout checks pass; private LAN and tailnet deployments retain their network boundary.

The default event limits are 256 KiB per event, 256 MiB per attributed user, 512 MiB per session, and 2 GiB for the deployment. They are logical event charges, not a guarantee of the SQLite/WAL file size. A quota breach returns `storage_quota_exceeded` without allocating a sequence or deleting history. Keep independent free-disk monitoring and raise a limit only with a verified backup and capacity plan.

Session metadata is separately capped at 512 creator-owned sessions per user, 2,048 sessions per project, and 8,192 sessions per deployment. A new session beyond a limit returns `session_quota_exceeded`; an exact idempotent retry of an already-created session still returns its original result. These row-count guards limit first-prompt auto-discovery abuse but do not replace host disk monitoring.

## Health and deployment gates

The server exposes unauthenticated `GET /health/live` and `GET /health/ready`; `GET /health` remains a readiness-compatible alias. Liveness proves only that the request loop runs. Readiness executes a bounded SQLite read, confirms WAL and foreign keys, and acquires then rolls back an immediate write transaction. Startup applies schema migrations before the listener opens. None of these endpoints exposes paths, versions, credentials, member counts, or event content.

A release sequence should:

1. Run `npm run release:verify`, which includes the full test, dependency, license, branding, secret, vulnerability, and release-metadata checks.
2. Review dependency and attribution changes, then commit the lockfile.
3. Create and verify an online backup.
4. Stop accepting new connections and drain active writes and runtime claims.
5. Apply forward-only migrations with a documented rollback or restore decision. The Alibaba profile activates a versioned release through `/opt/gatherthread/current` rather than overwriting old code.
6. Start the new version, wait for readiness, and run the integrated E2E driver.
7. Verify two-client replay and runtime claim completion before restoring traffic.

WebSocket clients must reconnect with their last durable sequence. Operators should not treat connected-socket counts as proof that clients are caught up.

## Backup

Never copy only the main database file while SQLite WAL writes are active. Use the SQLite online backup API through the provided script:

```sh
scripts/backup-sqlite.sh .local/collaboration.db /secure/backups/gatherthread
scripts/verify-sqlite-backup.sh /secure/backups/gatherthread/collaboration-YYYYMMDDTHHMMSSZ-PID.db
```

The backup script runs `PRAGMA integrity_check`, restricts file permissions, and writes a SHA-256 checksum. Store backups encrypted on a separate failure domain. Restrict access to the service operator and record backup creation, verification, schema version, and retention expiry without recording event content.

For the optional [code repository feature](CODE_SYNC.md), the same script also creates a companion `<backup.db>.code` directory. It packs immutable Git objects reachable from the **SQLite snapshot's** recorded heads, reconstructs those refs, and runs strict Git integrity checks before reporting success. Keep the database, companion directory and checksum together. A `.incomplete` marker means the backup is unusable. Node.js 24 is required; Git is additionally required when repositories exist. Do not run external Git garbage collection or mutate repository storage while this online backup runs. A custom programmatic `codeRepositoryDirectory` must be supplied as the script's third argument (or `CODE_REPOSITORY_DIRECTORY`); the default is `<absolute database path>.code`.

The ECS backup job and an independent six-hour retention timer call `scripts/prune-sqlite-backups.sh`. It removes each eligible database, checksum, matching Git companion, and incomplete set after 13 days; the one-day margin allows the 14-day maximum even if one run is delayed. Monitor both timers and alert on any failure: a failed timer does not itself enforce a maximum. Apply the same or shorter retention to encrypted off-host copies, restore-drill copies, snapshots, and incident copies unless a documented legal hold applies. Switching only `/opt/gatherthread/current` does not refresh installed systemd units; run the reviewed installer and `systemctl daemon-reload`.

At least monthly and before a schema migration, restore the newest backup into an isolated temporary directory and run integrity, schema, application smoke, replay, and membership authorization tests. A backup without a successful restore drill is not considered recoverable.

## Restore

Restore is an operator-approved destructive procedure and is intentionally not automated by this repository.

1. Stop the service and verify no process can write the database.
2. Preserve the failed database plus its `-wal` and `-shm` files in a restricted incident directory.
3. Verify the selected backup checksum and `PRAGMA integrity_check` with `scripts/verify-sqlite-backup.sh`.
4. Copy the verified backup to a new database path rather than overwriting evidence.
   If it contains code repositories, copy the matching companion directory to `<new absolute database path>.code` as well (or configure the matching explicit code directory). Never restore only SQLite: its commit references and the Git objects form one recoverable unit. The verify script rejects a missing or inconsistent companion directory.
5. Start the service against the new path with external traffic disabled.
6. Check schema version, foreign keys, maximum per-session sequence, memberships, retention state, and attachment references.
7. Run the integrated E2E suite, including replay and runtime claims.
8. Compare the restored snapshot with the restricted deletion register. Reapply every account/project/session/branch deletion and credential revocation that occurred after its backup timestamp, then verify those identities and objects remain inaccessible. Never serve a snapshot that resurrects a deleted account. The deletion register must be maintained independently of the restored SQLite file without recording conversation content.
9. Re-enable traffic and monitor authorization failures, sequence conflicts, replay gaps, and database errors.

Recovery point and recovery time objectives must be chosen by the deployment owner. A reasonable initial target for a small private deployment is hourly backups with a 24-hour recovery point objective and a four-hour recovery time objective, but this is not a guarantee until drills measure it.

## Retention and deletion

The official service's retention policy sets maximums of 14 days for routine backups containing deleted data and deleted/unreachable cloud Git objects, and 30 days from creation for logs containing user identifiers. The ECS timers use 13-day backup/Git and 29-day journal thresholds to leave scheduling margin. The operator must verify actual timer runs, off-host backup expiry, reverse-proxy logs, cloud-provider snapshots, and any log export before making this promise for a live host. Active shared sessions are not silently truncated. Any legal hold must be restricted, recorded, and disclosed where required.

Account deletion is a browser-session-only, Origin-checked transaction. The user must first transfer or delete owned projects and resolve personal cloud branches; the UI previews Solo deletion. The transaction deletes Solo cloud sessions, revokes devices/browser sessions and project memberships, and disassociates retained Multi records from the account. It does not edit user-entered text or reachable shared Git history. Deleted records may remain in encrypted backups until rotation completes. Keep a restricted deletion register outside the live SQLite snapshot for restore reconciliation, without event bodies or credentials.

Local harness transcripts remain under each user's local retention policy unless the user explicitly uploads allowed content. The collaboration server must not delete or modify a local transcript.

Code repository metadata is removed with a cloud project and its API access is revoked immediately. The ECS daily `gatherthread-code-retention.timer` reconstructs refs from a consistent SQLite head snapshot, expires unreachable Git objects and abandoned temporary upload indexes after 13 days, and removes expired deleted-project bare repositories. It refuses unknown refs, links, or malformed storage. A maintenance flock excludes the on-host backup and individual Git commands; the SQLite read transaction ends before filesystem scans and GC, so routine writes are not blocked for the length of maintenance. A concurrent metadata-only deletion can leave extra objects until the next run. Monitor failures and physical disk usage; a stopped timer may breach the retention maximum. It never touches a member's local workspace.

Code storage uses conservative write reservations and a bounded cold/periodic disk reconciliation (at most every 60 seconds, limited to 20,000 visited entries or 100 ms). Failed Git writes and physically retained deleted projects still consume disk allowance. `code_storage_check_required` pauses **code writes** for that process rather than repeatedly scanning on user requests; conversation and code-read endpoints remain available. Preserve a complete backup, stop writes, inspect/compact the operator-owned storage during maintenance, then restart and verify before resuming. Never prune based only on derived Git refs: SQLite heads are authoritative. Large concurrent rewrites can also exceed the conservative merge reservation and need local resolution. Git subprocesses remain synchronous with per-command timeouts in this small-project preview; worker-isolated Git processing is required before treating it as a high-throughput hosting service.

## Logging and monitoring

Use structured logs with an allowlist. Recommended fields are timestamp, severity, service version, request ID, operation, event type, server sequence, status, latency, byte count, and pseudonymous user/session identifiers. Hash identifiers with a logging-specific rotating key so they cannot be joined with authentication data.

Never log credentials, cookies, invitation URLs, request or event bodies, transcript paths, tool inputs or outputs, private instructions, raw thinking, model prompts, database records, or URL query strings. Apply the same redaction filter to application logs, proxy logs, traces, metrics labels, crash reports, and CI artifacts.

Alert on repeated authentication failures, forbidden writes, claim-owner mismatches, idempotency conflicts, replay gaps, database busy timeouts, integrity failures, backup verification failures, redaction failures, oversized payloads, and sustained socket backpressure. Avoid high-cardinality event content in metrics.

## Incident checklist

Contain the service, preserve restricted evidence, rotate affected device credentials and peppers, revoke invitations, identify impacted sessions and sequences, validate backup state, patch and test, then restore from known-good state if integrity is uncertain. Notify affected deployment owners with scope and remediation. Do not put sensitive evidence in public issues or routine logs.

<a id="optional-public-registration-preflight-unreleased"></a>

## Public Beta registration preflight

The public Beta account path is verified-email registration followed by password sign-in; no qualification code or account invitation is required. Project invitations and isolated test admission remain separate. Keep `GATHERTHREAD_PUBLIC_REGISTRATION=false` until project-lead approval and the checks below pass, then explicitly enable it for the reviewed deployment. Read [ADR-0036](adr/0036-verified-email-registration-and-password-login.md) for the design and [SECURITY](SECURITY.md) for authoritative budgets and retention. A documentation or source update does not change the live provider, DNS, proxy or registration settings.

Before opening: confirm the access provider/authority accepts the proposed public service and filing details; review the privacy notice, Resend/Cloudflare terms and personal-data transfer; create/configure approved provider accounts manually; verify the sender/domain and SPF/DKIM/DMARC; confirm actual current Free quotas and disable overages/auto-upgrade; use a dedicated restricted mail API key; configure sender, Resend key, Turnstile site/secret and exact HTTPS origin via private environment. Never put those values in Git, process arguments, logs or support screenshots. Verify approved QQ/163/Outlook/SJTU test inboxes, spam/bounce/delay behavior, mainland desktop/mobile network access, native Safari and keyboard accessibility. Free plans do not guarantee inbox delivery or a paid SLA. If unavailable, keep registration closed; no console mail or public relay fallback exists.

Default send limits are below the documented Resend 100/day and 3,000/month Free plan: 20 per UTC hour, 80 per UTC day and 2,000 per fixed 31-day block. Daily caps bound any calendar month to at most 2,480 emails. Failed and uncertain sends still count. Other workloads on the same provider account reduce available capacity; lower the application budget in reviewed source or reserve a dedicated account/key, and verify provider quota before enablement. No unlimited or automatically paid sending is permitted. Alert on generic delivery/challenge/rate-limit/capacity failure codes and aggregate usage, without email/OTP/password/provider payload labels. Persistent budgets survive deployment restarts and deliberate toggling; never erase them to work around limits.

Without proxy configuration, all clients through one edge share the peer-IP budget. To use per-client budgets, separately review an edge configuration that removes any incoming X-GatherThread-Client-IP and sets exactly one address from the actual connection. Set GATHERTHREAD_REGISTRATION_TRUSTED_PROXY to that exact socket peer IP only. Do not use X-Forwarded-For or client-selected chains. The source change does not edit the edge. Verify spoof attempts fail, and assess shared NAT/IPv6 aggregation before choosing the policy.

Local commands use the existing private environment/database path and persistent pepper:

```sh
node --env-file-if-exists=.env apps/server/dist/src/cli.js registration status
node --env-file-if-exists=.env apps/server/dist/src/cli.js registration pause
node --env-file-if-exists=.env apps/server/dist/src/cli.js registration resume
node --env-file-if-exists=.env apps/server/dist/src/cli.js registration cleanup
```

Pause commits a durable breaker observed by the running host for registration/recovery sends and completion; an already issued outbound request may finish. Resume does not enable missing dependencies or erase budgets. Existing email/password login keeps working; retired user token/vault login cannot reopen registration. The host runs registration cleanup every minute, including while closed; a shutdown host must run cleanup before restart or inspection. Expired records cannot authenticate even before physical cleanup. Backups retain credential hashes, pseudonymous budgets and deletion tombstones under the existing 14-day policy. Never restore a database with old signup budgets/deletions while accepting writes; reconcile those records first.

Schema creation is additive CREATE TABLE IF NOT EXISTS. No old-account inheritance, merging, conversion, deletion or credential revocation is run. Old user Cookies are excluded from Web authentication by the verified-email account check. Take the existing paired SQLite/cloud-Git backup before upgrade. First disable or pause signup before a rollback. Earlier binaries ignore the new tables and may re-expose retired user login routes; email/password sign-in is unavailable on those binaries. Keep the service closed during such a rollback. Prefer forward repair or roll back only to a binary retaining email-login support once accounts have enrolled. Do not drop tables or restore a pre-enrollment snapshot to roll back presentation. Migrations, backups, operator commands and rollback require separately authorized deployment steps.

Future hosted Agent services must enforce independent per-account plus deployment/provider spending budgets inside their own allocation transaction. Email verification and the current signup caps cannot prevent a person controlling many mailboxes from consuming many free allocations. Keep hosted entitlements disabled until that independent design, abuse monitoring and manual suspension are reviewed.

<a id="password-recovery-preflight-unreleased"></a>

## Password recovery preflight

Set `GATHERTHREAD_PASSWORD_RECOVERY=true` only on the reviewed matching server build with the same approved HTTPS origin, pepper, Turnstile and Resend configuration. This switch is independent of `GATHERTHREAD_PUBLIC_REGISTRATION`; existing email accounts may recover while registration stays closed. Missing dependencies or the durable `registration pause` breaker close both email-code flows. Password login keeps working. Source defaults keep both switches false; enablement is a separate operator action.

Test the `gt_password_reset` Turnstile action and browser-bound cdata separately from `gt_register`. Request and verify use `/v1/password-reset/send` and `/v1/password-reset/verify`; status is `/v1/password-reset`. Codes expire after ten minutes, are single-use, and allow five wrong attempts. Recovery requests share registration's email/IP/browser send budgets and provider-wide 20/hour, 80/day and 2,000/fixed-31-day caps. A successful-reset notification reserves one additional unit before password work. Do not erase budgets to recover capacity. Mail delivery can fail after a committed reset; instruct the user to sign in with the new password rather than retry a consumed code.

Reset keeps account IDs, projects, memberships and resource limits, revokes every browser session and native device credential, invalidates outstanding native/DSH grants and realtime tickets, and closes existing sockets. Users sign in normally afterward and authorize their Agents again. Verify old/new passwords, all old devices, pending grants, expiry, replay, cross-browser attempts, signup-off recovery, pause during hashing, notification failure and real inbox delivery before rollout. Earlier binaries can expose old credential paths and do not support recovery: keep service closed on rollback and preserve credential/budget/revocation state.
