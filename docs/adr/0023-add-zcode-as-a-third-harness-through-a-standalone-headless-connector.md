# ADR-0023: Add ZCode as a third harness through a standalone headless connector

- Status: accepted
- Date: 2026-09-20

## Context

GatherThread currently integrates two local harnesses: Codex through the bridge's App Server adapter plus reviewed Hooks, and DeepSeek Harness through the opt-in `@gatherthread/dsh-host` plugin with browser-approved pairing. Both follow the harness-neutral `ProjectHarnessAdapter` boundary, but each owns a materially different native surface. Users increasingly run ZCode — a local coding agent with a headless CLI, structured `stream-json` output, native session resume, and Claude-Code-style hook events — and want the same shared-session collaboration without weakening the existing two integrations.

ZCode's session store (`~/.zcode/cli/db/db.sqlite` and rollout JSONL) is private, version-sensitive, and contains private provider traffic. The headless CLI is the only interface that is both public enough to call and rich enough to execute a claimed Web Agent request.

## Decision

Add ZCode as a third harness through a standalone connector package, `@gatherthread/zcode-connect`, mirroring the `@gatherthread/codex-connect` thin-shell structure: the publishable package bundles connector modules that live beside the other harness adapters in `packages/bridge/src/zcode-*.ts` and stay decoupled from `codex-app-server.ts`, `codex-hooks.ts`, and `packages/dsh-host`.

The first slice covers the Web Agent execution loop only: project connection with the standard device token, one execution runtime per writable session, claim of `agent_request`, one bounded headless ZCode child per request inside the workspace, `agent_progress` for public commentary, one final `agent_response`, and incremental canonical-history hydration into the native session via `--resume`.

All ZCode-version-sensitive behavior is centralized in a compatibility module. The connector resolves the CLI without a shell (explicit `--zcode-command`, then `PATH`, then documented desktop install locations), probes it structurally at preflight (`--version`, `--help` capability tokens), and refuses to run when a required capability is missing. Oversized hydration prompts switch to stdin only when the CLI advertises `--input-format`. The connector never parses ZCode's private session store. Local-turn capture is deferred to the reviewed-hooks path in a later phase, so this slice publishes nothing on its own initiative and stores no upload preference.

Per-session binding state (native session id, hydrated-through sequence, observed model) is versioned, written atomically with private permissions, contains no credentials, and is rejected rather than guessed when its version is unsupported. GatherThread credentials are stripped from the ZCode child environment; shared canonical history is quoted into the prompt as untrusted data; hidden reasoning never leaves the child because the parser surfaces only text, tool_use, and tool_result blocks.

## Consequences

- The server protocol, ACL, and persistence layers need no harness-specific changes; `"zcode"` passes the existing generic harness validation.
- A user can add ZCode to the same shared session as Codex and DSH participants; only the selected runtime executes a request and the others passively follow canonical history.
- Execution quality depends on headless ZCode behavior (permission prompts, model availability). Ambiguous or failed runs fail closed through the existing claim/completion contract and require a real-device smoke test before each release that touches the surface.
- Local direct-ZCode turns remain local until the reviewed-hooks phase lands; they are not inferred from native history.
- Reading ZCode's private session store stays out of scope even when it would be convenient, preserving the privacy and compatibility boundary.
