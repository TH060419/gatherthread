# ADR-0060: Claude Code plugin paired with a local connector

Status: implementation preview; publication and deployment require separate approval.
Date: 2026-10-22.

## Context

The existing Claude adapter parses authorized offline JSONL only. A full product integration needs server-driven execution, native collaboration tools, explicit local publication and the same independent-device Launcher authorization as other Agents. A plugin alone cannot continuously claim Web requests, while direct token-bearing MCP would expose credential authority to the model.

## Decision

Reuse `ProjectHarnessAdapter`, the canonical project loop, claim/attempt fencing, shared redactor and bounded live-output publisher. A separate standalone `@gatherthread/claude-connect` package bundles its native plugin and MCP entry without workspace-runtime imports. No Anthropic source or runtime is redistributed.

Claude's user MCP is workspace/harness-scoped through the existing capability-protected local relay. New namespacing preserves legacy Codex endpoints and refuses ambiguity. It exposes collaboration actions, not internal runtime registration, claim, completion or device credentials. Separate Claude manifests use official `${CLAUDE_PLUGIN_ROOT}` paths; Codex manifests remain unchanged.

Web execution uses a fresh owned Claude CLI session and deletion-aware derived context for each request. It does not resume a private native session or infer exact provider-request fidelity. A durable execution journal prevents ambiguous crash recovery from silently repeating local side effects. Required CLI options are probed, and unsupported versions refuse execution. At the owner's explicit request, own-Agent execution inherits native tools/configuration/permission mode, including terminal, dependency installation, trusted Hooks, skills, subagents and configured MCP when locally allowed. It does not impose the earlier file/plan whitelist, restricted/safe mode or empty MCP configuration. The default `native` connector mode omits a permission-mode override; explicit manual/plan remain compatible choices. New unattended permission prompts are denied and surfaced as an actionable permission failure, never auto-approved. No permission-bypass flag is added. This is native local authority, not the other-member project-only shared-Agent isolation contract.

The connector registers each fresh Web session UUID privately before spawn and unregisters it after confirmed process termination. GatherThread's native Hooks ignore only those exact executions so local plugin loading cannot block the run, inject duplicate context or create an echo Solo. Unrelated native prompts still wait during remote/file operations. Native commands and custom tools may expose bounded start/completion states; raw commands, MCP arguments and tool-result bodies remain private. Loading local instructions/customizations does not import private native conversation history or expand its publication consent.

Plugin Hooks are explicitly installed/reviewed and separately validated. Only exact native UUID/workspace bindings can deliver bounded public user/final-answer content. Local upload needs per-conversation consent and a durable idempotent outbox; offline Hooks must not block normal Claude use. Arbitrary transcript paths, hidden thinking, private instructions and raw tool output are not capture authority. Native IDs remain local or one-way hashed before server identity derivation. Context-revision changes invalidate stale local work rather than relabeling it current.

Launcher URI v3 adds one strict `harness` key (`codex|claude-code`) to the current email/password handoff. Old v1/v2 links remain Codex. The existing password-protected project/device authorization is reused; its legacy route/table names do not imply a harness-bound grant. The harness field chooses only the local connector. Passwords and device credentials never enter the URI, model-visible arguments or plugin configuration. Windows and macOS bundle separately verified Claude resources without replacing Codex bundles or icons.

Only implemented local sync and file/GitHub controls are allowed for Claude. Codex visible-history replacement, arbitrary local session takeover and cross-member isolated Claude sharing remain unsupported. Connecting another harness does not implement the future Agent-team product or lock simultaneous filesystem writers.

## Verification and consequences

Contract tests cover v1/v2/v3 agreement, exact harness/runtime selection, malformed input, scoped relay coexistence, cancellation, bounded/redacted streams, crash/retry behavior and credential stripping. Packaging must work from a Git-less checkout and an installed tarball. Native plugin validation and no-model CLI preflight are distinct from a real billed model run. Local macOS checks cannot certify Windows execution or signing/notarization. Release and deployment receipts remain separate.
