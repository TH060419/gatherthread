# Operations guide

## Release state

This guide covers the executable single-process `0.1.0-alpha.7` Alpha profile, including the invitation-only Alibaba Cloud ECS deployment serving `https://gatherthread.cn`. The canonical environment contract is `.env.example`; generic `HOST`, `PORT`, and `DATABASE_PATH` variables are intentionally ignored. Supported edges are local-only loopback, private LAN HTTPS, private Tailscale Serve, and the operator-managed ECS profile. The application remains on loopback in every mode. Public registration and public Beta are not open.

## Private-by-default startup

The safe local baseline is one process bound to loopback with an on-disk SQLite database under a directory readable only by the service account. Projects are private, public discovery is disabled, payload logging is disabled, and transcript upload excludes raw thinking and private instructions.

Copy `.env.example` to the ignored `.env` and restrict it to the host account. A blank Pepper is generated atomically by `owner-host:init`, or a stable value may be injected by a secret manager. Never commit the populated file. See `SELF_HOSTING.md` for the exact bootstrap and startup commands.

Production preflight must fail if any of these are absent or unsafe:

- `NODE_ENV=production` with `GATHERTHREAD_SERVER_HOST` restricted to loopback behind an approved HTTPS edge.
- A cryptographically random `GATHERTHREAD_AUTH_TOKEN_PEPPER` of at least 32 bytes.
- An exact HTTPS `GATHERTHREAD_PUBLIC_BASE_URL`, explicit origin allowlist, and `GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true`.
- Private session default and public sessions disabled.
- Existing writable database and backup directories owned by the service account.
- Request, event, replay-page, attachment, and WebSocket queue limits.
- A tested backup plus a restore drill completed for the release schema.

The browser uses a server-side session after login. A device bearer is present in JavaScript only for the single exchange request, then cleared; it is never written to Web Storage. By default, the opaque browser credential is a non-persistent `HttpOnly; SameSite=Strict; Path=/` Cookie backed by a peppered digest and a 24-hour absolute database expiry. Choosing **Remember this device** makes the active Cookie persistent, extends the database expiry to 30 days, and creates a separate server-backed, `HttpOnly` remembered-account credential for the same browser profile. A normal refresh restores either active session. Closing the browser discards only the non-persistent Cookie. Logout revokes the active session but deliberately preserves the remembered-account credential for one-click sign-in until its 30-day expiry, explicit **Forget this account**, or device revocation/rotation. Warn users not to remember an account in a shared browser profile. Production HTTPS adds `Secure` and `__Host-`. Keep the exact public origin allowlisted because Cookie-authenticated writes fail without it. This improvement does not authorize unrestricted public ingress; use only the documented invitation-only server, private LAN, or tailnet boundary.

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

The official service's intended maximums after this candidate is deployed are 14 days for routine backups containing deleted data and deleted/unreachable cloud Git objects, and 30 days from creation for logs containing user identifiers. The ECS timers use 13-day backup/Git and 29-day journal thresholds to leave scheduling margin. The operator must verify actual timer runs, off-host backup expiry, reverse-proxy logs, cloud-provider snapshots, and any log export before making this promise for a live host. Active shared sessions are not silently truncated. Any legal hold must be restricted, recorded, and disclosed where required.

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
