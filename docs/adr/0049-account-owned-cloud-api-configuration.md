# ADR-0049: Private account-owned Cloud Agent API configuration

- Status: proposed / implementation review
- Date: 2026-10-12
- Scope: private API configuration, exact hosted routing, native Messages transport and separate accounting

## Context

Writers need their own model API accounts without installing a local Agent. Public free models remain useful for trying the product. Personal keys must not become project credentials, appear in shared history, enter executors, reset host limits or pay for another member's work. Edits, retry and continuation are authorization boundaries.

## Decision

Account-level Personal API settings use a fixed provider preset, exact model ID and write-only key. Initial presets are OpenAI Chat, native Anthropic Messages, DeepSeek, SiliconFlow CN/global and OpenRouter. Each has fixed credential-free HTTPS and host-created standard authorization headers. Arbitrary URLs/headers, IAM, Gemini-native and Responses-only transports are unsupported. Saving invokes no model discovery, billable test, retry or fallback.

`cloud_api_configs` contains metadata and AES-256-GCM ciphertext under an independent operator-managed 32-byte key. AAD binds account, config ID, revision and all routing metadata. Reads expose metadata and `has_key`, never keys, digests, ciphertext or suffixes. Exact/recognizable credential pastes in labels/model IDs are refused. Storage is limited to eight configs per account. Foreign access, stale revisions, encryption tampering and missing master key fail closed. Same-state create retries are idempotent; edits/deletes require current revision. An uncertain edit requires rereading metadata.

A private `(request, account, config, revision)` binding commits with each canonical request, host slot and billing reservation. Shared history retains profile/model, not the private revision. Requester-only `selection` validates current device, session write access and exact request/job/binding. Retry/resume use it, not current settings. Repository continuations enforce original selection server-side. Changed/disabled/deleted configs invalidate old work without redirection. Existing free/service IDs remain compatible; `api-` is reserved for personal profiles.

The existing digest-pinned, network-disabled OpenCode container uses its bundled compatible/native SDKs and receives only a loopback URL and dummy key. Its host-side Unix proxy pins real provider/model/headers and retains body/output/call/deadline/redirect limits. It authorizes dispatch and every response chunk, cancels upstream work on revocation/disconnect, and returns no private headers or upstream error body. Anthropic extended thinking is not requested under the unchanged trial output cap; no hidden reasoning is collected. Exposed work still uses the bounded live-output pipe.

Edits abort owned trial controllers immediately; trial/repository jobs retain periodic access checks. Dispatch, live progress and checkpoints recheck the private pin. Repository source/result and GT Cloud checkpoint authorization are fenced in a writer transaction. Account/device revocation, role changes and pauses remain effective. Dispatched provider work cannot be recalled/refunded, and revoked late work cannot become a successful answer/checkpoint. Slots remain held until confirmed executor exit.

Personal billing is separate from operator-funded allowance: 100 accepted tasks/account and 1,000/host per UTC day across configs, with no personal free-model exception. Common cooldown, concurrency, runtime, CPU/memory, input/output, code and npm limits stay unchanged. These are not invoice-accurate spend controls; users need provider-side spending caps too.

Account deletion cascades configs/pins. Completed repository changes retain existing private task/retention and explicit PR rules independently of the model key. Backups follow existing retention; key backup/rotation remains operator-controlled.

## Alternatives

- Project/browser plaintext keys: rejected for sharing and leakage.
- Arbitrary compatible URLs/headers: deferred until pinned-DNS SSRF defenses exist.
- Latest-settings retry/continuation: rejected for implicit payer/model changes.
- Combined billing/unlimited personal free models: rejected because host resources remain finite.
- Network-enabled executors/runtime SDK installs: rejected; reuse bundled SDKs through the proxy.

## Delivery and compatibility

Upgrade server/Web together. Migration adds private tables and ledger `billing_source`; legacy usage remains `service`. Local Codex/DSH and free routes are unchanged. A missing, malformed or reused master key, or disabled Cloud Agent, disables only personal configuration without rewriting operator secrets or encrypted records. Existing free/local/authentication services still start with their normal independent validation. A personal profile stays unavailable, never falls back to platform billing. Keep the key stable across restarts; rotation does not re-encrypt records automatically. Stop jobs and review migration/re-entry before changing it. Rollback must retain private tables/key and stop executors; older builds cannot interpret personal requests safely.

Tests use synthetic keys/providers. The same-source Linux image smoke also checks native Messages streaming, a real isolated bash/tool-result loop and checkpoints. Mock/static success is not Docker or real-provider evidence; report these separately. See [contracts](../INTERFACE_CONTRACTS.md#personal-cloud-api-configuration) and [setup](../HOSTED_AGENT.md#personal-api-storage).
