# Operations guide

## Release state

This is an operational scaffold for the first release. The application owners must map the proposed environment names in `.env.example` to the server implementation and add service-specific health, migration, and shutdown commands. Do not expose a deployment until those integration points and the production security gates are implemented.

## Private-by-default startup

The safe local baseline is one process bound to loopback with an on-disk SQLite database under a directory readable only by the service account. Sessions are private, public discovery is disabled, payload logging is disabled, and transcript upload excludes raw thinking and private instructions.

Copy `.env.example` to an ignored local file and set fresh secrets. Never commit the populated file.

Production preflight must fail if any of these are absent or unsafe:

- `NODE_ENV=production` with a loopback application bind behind an HTTPS reverse proxy.
- A cryptographically random `AUTH_TOKEN_PEPPER` supplied through the deployment secret manager.
- Secure cookies and explicit HTTP and WebSocket origin allowlists.
- Private session default and public sessions disabled.
- Existing writable database and backup directories owned by the service account.
- Request, event, replay-page, attachment, and WebSocket queue limits.
- A tested backup plus a restore drill completed for the release schema.

## Health and deployment gates

The server should expose separate liveness and readiness checks. Liveness proves only that the process loop runs. Readiness must execute a bounded database query, confirm migrations are current, confirm the database is writable, and report unavailable while shutting down. Neither endpoint should expose paths, versions, credentials, member counts, or event content.

A release sequence should:

1. Run `npm run verify` and all application unit and integration tests.
2. Review dependency and attribution changes, then commit the lockfile.
3. Create and verify an online backup.
4. Stop accepting new connections and drain active writes and runtime claims.
5. Apply forward-only migrations with a documented rollback or restore decision.
6. Start the new version, wait for readiness, and run the integrated E2E driver.
7. Verify two-client replay and runtime claim completion before restoring traffic.

WebSocket clients must reconnect with their last durable sequence. Operators should not treat connected-socket counts as proof that clients are caught up.

## Backup

Never copy only the main database file while SQLite WAL writes are active. Use the SQLite online backup API through the provided script:

```sh
scripts/backup-sqlite.sh .local/collaboration.db /secure/backups/agent-cooperation
scripts/verify-sqlite-backup.sh /secure/backups/agent-cooperation/collaboration-YYYYMMDDTHHMMSSZ-PID.db
```

The backup script runs `PRAGMA integrity_check`, restricts file permissions, and writes a SHA-256 checksum. Store backups encrypted on a separate failure domain. Restrict access to the service operator and record backup creation, verification, schema version, and retention expiry without recording event content.

At least monthly and before a schema migration, restore the newest backup into an isolated temporary directory and run integrity, schema, application smoke, replay, and membership authorization tests. A backup without a successful restore drill is not considered recoverable.

## Restore

Restore is an operator-approved destructive procedure and is intentionally not automated by this repository.

1. Stop the service and verify no process can write the database.
2. Preserve the failed database plus its `-wal` and `-shm` files in a restricted incident directory.
3. Verify the selected backup checksum and `PRAGMA integrity_check` with `scripts/verify-sqlite-backup.sh`.
4. Copy the verified backup to a new database path rather than overwriting evidence.
5. Start the service against the new path with external traffic disabled.
6. Check schema version, foreign keys, maximum per-session sequence, memberships, retention state, and attachment references.
7. Run the integrated E2E suite, including replay and runtime claims.
8. Re-enable traffic and monitor authorization failures, sequence conflicts, replay gaps, and database errors.

Recovery point and recovery time objectives must be chosen by the deployment owner. A reasonable initial target for a small private deployment is hourly backups with a 24-hour recovery point objective and a four-hour recovery time objective, but this is not a guarantee until drills measure it.

## Retention and deletion

Recommended initial defaults are 30 days for closed-session content and backups, and 90 days for security audit events. Active sessions should not be silently truncated. The owner can choose a shorter policy, subject to incident and legal holds. Attachments expire with their referencing event unless another retained event still references them.

Deletion must cover canonical events, derived read models, attachments, invitations, runtime presence, search indexes, and scheduled backup expiry. Append a non-sensitive audit record before deleting content, then ensure the deletion job is idempotent and resumable. Clearly disclose that expired data can remain in encrypted backups until backup rotation completes.

Local harness transcripts remain under each user's local retention policy unless the user explicitly uploads allowed content. The collaboration server must not delete or modify a local transcript.

## Logging and monitoring

Use structured logs with an allowlist. Recommended fields are timestamp, severity, service version, request ID, operation, event type, server sequence, status, latency, byte count, and pseudonymous user/session identifiers. Hash identifiers with a logging-specific rotating key so they cannot be joined with authentication data.

Never log credentials, cookies, invitation URLs, request or event bodies, transcript paths, tool inputs or outputs, private instructions, raw thinking, model prompts, database records, or URL query strings. Apply the same redaction filter to application logs, proxy logs, traces, metrics labels, crash reports, and CI artifacts.

Alert on repeated authentication failures, forbidden writes, claim-owner mismatches, idempotency conflicts, replay gaps, database busy timeouts, integrity failures, backup verification failures, redaction failures, oversized payloads, and sustained socket backpressure. Avoid high-cardinality event content in metrics.

## Incident checklist

Contain the service, preserve restricted evidence, rotate affected device credentials and peppers, revoke invitations, identify impacted sessions and sequences, validate backup state, patch and test, then restore from known-good state if integrity is uncertain. Notify affected deployment owners with scope and remediation. Do not put sensitive evidence in public issues or routine logs.
