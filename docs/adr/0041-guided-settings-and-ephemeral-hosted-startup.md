# ADR-0041: Guided settings and bounded ephemeral hosted startup

- Status: accepted
- Date: 2026-10-10

## Context

Large inline configuration forms obscured send controls, especially under the test banner. Cloud pending messages incorrectly relied on local runtime presence. A reported trial started its container, then hit the existing 120-second deadline; its public failure erased the underlying error category.

An isolated deployment-host diagnosis then observed a complete HTTP 200 model stream while the OpenCode CLI remained running without JSON events. A provider-free Linux reproduction had the same failure, so increasing the deadline or changing the model would not address result collection.

## Decision

Use one shared Agent-settings dialog, keeping original control IDs and request handlers. Separate GitHub's cloud-account authorization from local-device file synchronization, with one page of settings visible at a time. Owner and repository are separate fields assembled into the unchanged validated repository contract. Creating a repository opens GitHub's official form; no silent external creation or visibility decision occurs.

Keep authentication hidden behind a neutral restore state until the server confirms the session. No client-stored identity or credential is introduced. Failures and stale restoration retain the authentication-generation fence.

For the digest-pinned OpenCode 1.18.32 ephemeral runner, disable its auxiliary title Agent, external model-catalog refresh and default credential plugins. The server supplies the fixed model configuration, and GatherThread already manages conversation titles. Apply this to trial and repository tasks without changing provider credential transport, sandbox or call/token caps. The fixed-version sources are [title generation](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/prompt.ts), [Agent configuration](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/agent/agent.ts), [model catalog](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/models-dev.ts) and [runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/effect/runtime-flags.ts).

Run one `opencode serve` process on container loopback. The Node entrypoint creates a fresh session and awaits the official synchronous `POST /session/:sessionID/message` response, instead of relying on `opencode run`'s in-process event subscription. All requests use the same explicit workspace, and startup verifies the pinned version. A successful result requires a completed, error-free assistant message for that session, a final `stop` or `length` finish, and an idle session. Only non-synthetic, non-ignored assistant text is public; reasoning, tools and server logs remain private. Stop the persistent server and confirm process closure before taking the workspace snapshot. Partial text, an aborted process, an invalid response or failed closure cannot become success. The fixed-version [prompt handler](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts), [response contract](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/sdk/js/src/v2/gen/types.gen.ts) and [idle-state map](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/status.ts) define this boundary.

After fixing completion handling, the project lead authorized a five-minute trial deadline for complex work. Each provider call still has a 30-second deadline; existing repository tasks retain their fifteen-minute deadline. Increasing trial time does not turn a stuck or partial run into success.

Only allowlisted failure codes and bounded provider-attempt counts can enter a failed canonical terminal. Keep exact ≤1 KiB internal control markers, one terminal per accepted job and atomic quota/slot accounting. Never store or publish raw exception/provider output.

## Consequences

No account migration, npm publication or connector permission change is required. The matching immutable runner image must be rebuilt and validated with the application; updating Web assets alone does not update this execution path. A real provider/host result is needed before claiming the specific timeout solved; synthetic tests prove state, privacy, accounting and browser behavior, not live model speed.
