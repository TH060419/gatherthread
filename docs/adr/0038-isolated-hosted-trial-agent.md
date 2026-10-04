# ADR-0038: Run the hosted trial Agent with OpenCode in an isolated container

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
accepts only the selected provider endpoint and model and puts conservative
per-call and per-run bounds on requests. The provider token never enters the
container. User start intervals, user/account/host slots and any configured daily
allocations are reserved before the canonical request is appended; retry uses
the same idempotency key and cannot double-run.

The initial free candidates are SiliconFlow Qwen3.5-4B and Qwen3-8B. A reviewed
operator preset selects exactly these two models, retains one shared account
group and has no daily run-count allowance by default. It admits one task per
user at a time with a 30-second minimum interval across models, projects and
devices. Persistent bounded control records survive conversation deletion;
account deletion nulls only the active slot's user link. Single-process startup
recovery confirms executor exit before releasing interrupted slots, while
preserving the last accepted start. Other models keep their paid/free-tier daily ceilings.
Pricing and provider eligibility must be reconfirmed before activation.

Keep current-day consumption in a separate minimal ledger with no foreign key
to conversation or account records. Cloud deletion and interruption do not
refund accepted reservations; no deleted prompt or source is retained. The
idempotent backfill and UTC-day pruning contract is owned by the operator guide.

Settle accepted hosted jobs atomically with their canonical terminal event. Generate the terminal idempotency key privately so ordinary participant events cannot occupy it in advance. A full timeline discards the model answer and retains one fixed, charged failure marker using the bounded server control allowance in [Security](../SECURITY.md#persistence-and-redaction-requirements); it does not keep a finished executor's capacity slot indefinitely. Unconfirmed executor exit still retains the slot.

Cloud Agent appears beside local harnesses in the shared Agent selector and settings. Operators configure one or more API endpoints, grouping the same provider/model under a public profile and same-account keys under a shared quota group. Transactional account and host capacity gates enable parallel runs. Exhaustion fails explicitly; no silent model switch or automatic replay occurs. Run reservations cover non-Cloudflare providers; provider-side spend caps are still required. The additive database migration and configuration contract are documented in [the operator guide](../HOSTED_AGENT.md).

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
