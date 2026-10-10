# ADR-0042: Cloud request lifecycle and selected-history summaries

- Status: proposed / implementation review
- Date: 2026-10-10

## Context

Cloud-only users were offered local-runtime-gated retry and summary controls. The cloud request HTTP exchange waited for the full task, and the composer always showed a disabled waiting button. A real trial failed after 231 seconds with one provider attempt and an undifferentiated container failure; its inner failing phase was not retained.

## Decision

Return a strict HTTP 202 receipt as soon as the request, quota and executor reservation commit. Publish completion through the existing append-only log and authenticated replay, independently of the edge HTTP connection.

Add an author-only cloud-trial pause endpoint and additive `hosted_agent_pauses` table. A committed pause fences outbound model calls, aborts the current task and suppresses late answers/checkpoints. Do not free the executor slot before confirmed exit. Repeated pause is idempotent. Resume means a new request using the original exact cloud profile and newer shared history, with a stable key after an uncertain acknowledgement. Repository tasks keep their separate lifecycle; no lossless provider continuation is promised.

Share canonical summary source validation between local and cloud execution. A separate strict cloud-summary route accepts only source IDs, instructions, profile ID and an idempotency key. Inside the reservation transaction, derive source text and digest from authorized, complete public history. Never accept client-generated summary metadata. Send only selected history, with no project files and denied read/edit/bash tools. Preserve originals, nested-summary validation, context policies, quotas and role checks. The confirmation names the chosen cloud model and discloses the provider transfer.

Saving preferences and selecting history do not require a local runtime. Execution and device-file transfers still require their actual capabilities and permissions. Empty or unavailable selections give visible feedback, not silently inert controls.

For the reviewed SiliconFlow Qwen3.5-4B/Qwen3-8B interactive profiles, explicitly disable hidden thinking while retaining the exact model and existing call/output limits. This follows the provider's answer-token contract and is not a confirmed explanation of the old failure. Record only fixed startup/session/answer/idle/shutdown failure categories; raw errors, reasoning and tool text remain private. Preserve ADR-0041's completed-response, idle and process-closure boundary.

## Compatibility and verification

The pause table is additive; no old log or account is rewritten. Server and Web must upgrade together for the new 202 receipt and cloud-summary/pause routes. The runner image must match the application source. Before rollback, stop new cloud work and confirm every executor has exited, using this version's recovery; older binaries do not enforce pause fences. Keep the paired database/code backup and do not drop pause rows or restore an older accounting snapshot.

Focused tests cover author/viewer restrictions, late-answer suppression, idempotency, unchanged quota charging, canonical summary provenance, source privacy, and ordinary desktop/phone pointer clicks. Those fixtures do not prove real model speed: the final same-image isolated deployment-host check remains required before claiming the reported failure fixed.
