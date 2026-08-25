# ADR-0005: Manage one local Codex thread per GatherThread session mapping

**Date**: 2026-08-25
**Status**: accepted
**Deciders**: Yuhan He

## Context

An MCP server cannot insert arbitrary shared history into an already open host conversation. GatherThread nevertheless needs each collaborator's local Codex to receive every visible canonical event in order, continue its own local context across turns, and write a provenance-labelled response back to the shared session. The integration must not transfer local tool-approval authority to another collaborator or expose the GatherThread credential to Codex.

## Decision

Provide a built-in local Codex connector using the non-interactive Codex CLI JSONL interface. One connector mapping binds an authenticated GatherThread device, one shared session, one local workspace, and one persisted Codex thread.

The first local request creates a Codex thread with the complete visible canonical history preceding that request. Later requests resume that thread and inject every newly committed visible event after the last successfully submitted request. Events already produced by the same local runtime are not injected twice. The current `agent_request`, which the server proves was authored by the runtime owner, is placed in a separate authorized-request block; earlier messages are explicitly labelled untrusted shared context.

Run Codex inside the user-selected `read-only` or `workspace-write` sandbox with automatic privilege escalation disabled. GatherThread credentials are removed from the Codex child environment. Parse structured JSONL, exclude raw reasoning and private system/developer content, bound tool output, redact events before persistence, and complete the server claim using server-derived runtime provenance.

Persist only the Codex thread ID, workspace binding, GatherThread session ID, and covered sequence in a private local file. Compaction and native Codex transcript storage remain local. The connector performs a Codex version and login preflight before registering the runtime so a missing or unauthenticated CLI cannot claim and strand a request.

## Alternatives considered

### Transcript import without execution

- **Pros**: Minimal authority and no automatic local commands.
- **Cons**: Cannot make the Web `Request my agent` action invoke Codex.
- **Why not**: It does not complete the required collaboration loop.

### Stateless `codex exec` for every request

- **Pros**: Simple lifecycle and no thread state.
- **Cons**: Re-sends the full history every turn, loses native local compaction, and increases latency and context use.
- **Why not**: A persistent local thread better matches the user's local-agent workflow.

### Codex app-server v2

- **Pros**: Rich thread, turn, item, streaming, and approval protocol.
- **Cons**: The local CLI labels app-server experimental; its schema is version-specific and requires a larger bidirectional lifecycle implementation.
- **Why not now**: `codex exec --json` plus `exec resume` is sufficient for the first connector and has a smaller security surface. App-server remains a future option for token streaming and interactive approvals.

## Consequences

### Positive

- Shared history is synchronized automatically without manual copy and paste.
- Each collaborator retains their own Codex account, model, workspace, sandbox, and local compaction.
- Replies carry server-derived username, device, harness, provider, and model attribution.
- Disconnect recovery uses both the server event cursor and the local Codex covered-sequence state.

### Negative

- The connector must track Codex CLI JSONL compatibility and reject unknown or incomplete output safely.
- The first version returns a completed response rather than streaming model tokens into the room.
- A crash after a server claim but before completion still requires abandoned-claim recovery, which remains a known alpha limitation.

### Risks

- A collaborator can place prompt-injection text in shared history. Treat all prior events as untrusted data, accept execution only from the server-verified local request, retain the Codex sandbox, and never enable automatic privilege escalation.
- Codex tool output may contain secrets. Bound it, run the common structural and pattern redactor, and allow users to disable shared tool events entirely.
- Reusing a state file with another workspace or session can contaminate context. Fail closed on either binding mismatch and require an explicit reset.
