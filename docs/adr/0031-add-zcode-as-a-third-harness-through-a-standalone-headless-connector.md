# ADR-0031: Add ZCode as a third harness through a standalone headless connector

- Status: accepted
- Date: 2026-09-20
- Renumbered from 0024 to 0031 on merge: main had independently accepted ADR-0024 (runtime-advertised DSH model selection) while this branch was in review

## Context

GatherThread currently integrates two local harnesses: Codex through the bridge's App Server adapter plus reviewed Hooks, and DeepSeek Harness through the opt-in `@gatherthread/dsh-host` plugin with browser-approved pairing. Both follow the harness-neutral `ProjectHarnessAdapter` boundary, but each owns a materially different native surface. Users increasingly run ZCode — a local coding agent whose CLI exposes an official headless `app-server` speaking the versioned ZCode Protocol — and want the same shared-session collaboration without weakening the existing two integrations.

ZCode's session store (`~/.zcode/cli/db/db.sqlite`) is private, version-sensitive, and contains private provider traffic. The official headless surfaces are exactly two: the one-shot `-p/--prompt --json` mode, which prints a final JSON result without a structured in-turn event stream, and the `app-server` stdio protocol, which provides session lifecycle, event subscriptions, and turn-level results. Only the protocol satisfies the connector's requirements: incremental continuation, public commentary during a turn, tool-event policy, failure mapping, and prompt interruption. The connector therefore speaks the documented `app-server` protocol and never guesses at undocumented flags.

## Decision

Add ZCode as a third harness through a standalone connector package, `@gatherthread/zcode-connect`, mirroring the `@gatherthread/codex-connect` thin-shell structure: the publishable package bundles connector modules that live beside the other harness adapters in `packages/bridge/src/zcode-*.ts` and stay decoupled from `codex-app-server.ts`, `codex-hooks.ts`, and `packages/dsh-host`.

The first slice covers the Web Agent execution loop only: project connection with the standard device token, one execution runtime per writable session, claim of `agent_request`, one bounded `zcode app-server` child per request inside the workspace, `agent_progress` for public commentary streamed during the turn, one final `agent_response` taken from the protocol's `turn.completed` result, and native session continuation through `session/resume` with the connector-owned session id. `turn.failed`, timeouts, deactivation, and cancellation always complete the request as bounded failures — never as successful answers.

All ZCode-version-sensitive behavior is centralized in the compatibility modules (`zcode-compat.ts` for resolution and probing, `zcode-protocol.ts` for the protocol client). The connector resolves the CLI without a shell (explicit `--zcode-command`, then `PATH`, then documented desktop install locations), probes it structurally (`--version`, `--help` capability tokens), verifies a live protocol handshake at preflight, and refuses unsupported builds or protocol versions instead of degrading. Server-initiated `interaction/*` requests — permission prompts, user input, provider headers — are declined with an error so a headless run can never approve a local tool action remotely. The connector never parses ZCode's private session store. Local-turn capture is deferred to the reviewed-hooks path in a later phase, so this slice publishes nothing on its own initiative and stores no upload preference.

Per-session binding state (native session id, hydrated-through sequence, observed model, and the execution journal) is versioned, written atomically with private permissions, contains no credentials, and is rejected rather than guessed when its version is unsupported. A write-ahead journal records `running` before the child starts and `completed` with the replayable result before the bridge appends anything canonical, so a crash or transport failure after the native turn replays the recorded result exactly once instead of re-running tool side effects; an interrupted `running` entry refuses re-execution. GatherThread credentials are stripped from the ZCode child environment; shared canonical history (excluding the connector's own earlier output and the current request) is quoted into the prompt as untrusted data; hidden reasoning never leaves the child because only reviewed text and tool blocks are surfaced.

Tool events are privacy-controlled by default. Only the final answer is shared unless the operator explicitly passes `--share-tool-events`, and even then only tools on an exact-name allowlist (default: read-only discovery tools) with bounded argument and result values can reach canonical history, on top of the server-side redaction pipeline.

## Consequences

- The server protocol, ACL, and persistence layers need no harness-specific changes; `"zcode"` passes the existing generic harness validation.
- A user can add ZCode to the same shared session as Codex and DSH participants; only the selected runtime executes a request and the others passively follow canonical history. ZCode claims only requests explicitly targeted at `zcode`; legacy untargeted requests keep their Codex compatibility target and are safely skipped.
- Revocation and shutdown are binding-level guarantees: project removal, role downgrade, connector close, or Ctrl-C abort in-flight headless children and refuse later publication of their results.
- Execution quality depends on the signed-in ZCode CLI having a usable model. A CLI without a signed-in account or default model fails closed with an actionable message rather than executing, and requires a real-device smoke test before each release that touches the surface.
- Local direct-ZCode turns remain local until the reviewed-hooks phase lands; they are not inferred from native history.
- Reading ZCode's private session store stays out of scope even when it would be convenient, preserving the privacy and compatibility boundary.
