# ADR-0021: Import visible Codex history as a new task

- Status: accepted
- Date: 2026-09-16

## Context

GatherThread's canonical history must remain available to a local Codex task as model context, but users also want readable native Desktop history bubbles. Codex App Server can import an external conversation as a new task. Its public interface does not provide a reliable way for the connector to overwrite a task currently owned by Codex Desktop, and attempting to acquire that task can fail with an active-writer error even when no turn is visibly running.

## Decision

Automatic visible-history import has two modes only: import once when a GatherThread session is first established locally, which is the default, or do not import automatically.

Every explicit manual import creates and verifies a new local Codex task. Long history is compacted before the task becomes authoritative. After verification, GatherThread switches its durable session binding and private Hook allowlist to the new task. It removes only the old task's GatherThread Hook authorization; it does not overwrite, delete, archive, or unarchive the old native task. The user reviews and archives that task manually.

Realtime canonical context injection is independent of visible-history import and remains active in both automatic modes and after manual imports. Legacy Alpha command values `every-connect` and `every-update` normalize to the safe first-connect behavior.

## Consequences

- Manual import works while Codex Desktop retains its writer for the old task.
- A user may temporarily see both old and newly imported tasks until they archive the old one.
- GatherThread never guesses which local task the user wants destroyed or archived.
- Visible bubbles are a point-in-time snapshot; newer canonical events continue to reach model context through the realtime projection until the user imports another snapshot.
