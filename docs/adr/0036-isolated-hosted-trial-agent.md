# ADR-0036: Run the hosted trial Agent with OpenCode in an isolated container

- Status: proposed / source preview
- Date: 2026-09-30

## Context

New testers may not have a local harness or model account. A cloud model alone
can answer questions, but it cannot carry out ordinary coding steps such as
editing files and running tests. An untrusted Agent must not gain a shell on
the GatherThread server. Cloud code remains opt-in under ADR-0025.

## Decision

Use the MIT-licensed [OpenCode](https://github.com/anomalyco/opencode) CLI as
the initial hosted harness. Its documented [non-interactive run mode](https://dev.opencode.ai/docs/cli/)
and [edit and bash tools](https://dev.opencode.ai/docs/tools/) meet the coding
requirement. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
is promising and already has a GatherThread local integration, but its
headless/sandbox design is still a developer preview. [Cherry Studio](https://github.com/CherryHQ/cherry-studio)
is desktop-first and Community Edition uses AGPL-3.0. These can be reconsidered
after headless runner and license review; the hosted boundary does not depend
on OpenCode internals.

Each request runs a digest-pinned image in a new non-root Docker container with
no general network, dropped capabilities, a read-only root, bounded tmpfs
workspace, CPU/memory/PID/time limits, and no host credentials. The only model
connection is a short-lived Unix socket to a server-side proxy. That proxy
accepts only the selected Cloudflare Workers AI model and puts conservative
per-call and per-run bounds on requests. The provider token never enters the
container. Daily user and global allocations are reserved before the canonical
request is appended; retry uses the same idempotency key and cannot double-run.

The user separately chooses whether the Agent receives cloud project code.
When chosen, the runner receives the requester's current branch or shared main
as read-only input. Valid changed files are checkpointed to that requester's
cloud branch only, subject to the existing Git code-sync rules. They are not
merged automatically. Without the choice, the workspace is disposable.

## Consequences

The trial runs a real coding harness and terminal, but it is small: source
size, context, model calls, and run time are capped. Dependency downloads and
arbitrary web access are unavailable. Operators must verify the container
image and socket path on their deployment host before enabling the flag.
Unit tests and CI smoke tests use a mock provider; real provider behavior
still requires a separately authorized live test.
