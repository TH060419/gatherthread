# ADR-0004: Adopt GatherThread as the project name

**Date**: 2026-08-25
**Status**: accepted
**Deciders**: Yuhan He

## Context

The initial repository name, Agent Cooperation Project, described the development goal but did not distinguish human collaboration through local agents from agent-to-agent orchestration. The temporary UI name Relayroom also conflicts with an existing AI-agent coordination project using the same name.

The project needs one memorable name across the repository, user interface, packages, commands, configuration, and wire identifiers before any of those interfaces are declared stable.

## Decision

Adopt **GatherThread** as the formal project and product name. The name describes people gathering around one durable project thread while retaining their own local harnesses and models.

Use the following identifiers for the pre-1.0 interface:

- npm workspace scope: `@gatherthread/*`
- executables: `gatherthread-bridge` and `gatherthread-mcp`
- environment prefix: `GATHERTHREAD_*`
- WebSocket subprotocol: `gatherthread-v1`
- credentials: `gta_` for device access, `gti_` for invitations, and `gtd_` for device authorization
- local bridge state: `~/.gatherthread`

The previous alpha identifiers are not supported configuration aliases. Secret redaction and subprocess isolation continue recognizing old credential forms as a defensive control.

## Consequences

### Positive

- One name now identifies the human-facing product and every technical interface.
- The name emphasizes a shared conversation thread instead of autonomous agent orchestration.
- Renaming before a stable release avoids a permanent compatibility layer.

### Negative

- Existing local alpha environment files, MCP launch configurations, WebSocket clients, and bridge cursor paths must be updated.
- Any previously generated credential remains valid in the database but carries an old textual prefix; redaction continues to protect it.

### Follow-up

- Rename the GitHub repository to `gatherthread` and update the local `origin` URL.
- Treat subsequent changes to these identifiers as compatibility-sensitive release decisions.
