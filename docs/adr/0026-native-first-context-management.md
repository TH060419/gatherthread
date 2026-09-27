# ADR-0026: Native-first context management

- Status: proposed / implemented source preview, pending release review
- Date: 2026-09-22
- Clarifies: the compaction policy in [ADR-0021](0021-import-visible-codex-history-as-a-new-task.md); its new-task and local-only-old-task rules remain unchanged.

## Context

A visible native conversation, the active model context, a transfer frame, and the canonical server log are different things. Earlier code conflated them: Codex background replay clamped its effective window to 4,096 tokens even for a larger model; cumulative lifetime usage could trigger unnecessary compaction; visible imports discarded older text under a fixed "automatic compact" label. DSH incoming projection also shortened each public message to 64 KiB independently of the model's capacity.

## Decision

1. Prefer the native harness's model capacity, current usage and compaction policy. Do not write `model_context_window` or `model_auto_compact_token_limit`, disable native compaction, or silently select another provider/model. Existing Codex `--context-window-tokens` and browser preference remain compatible but mean a fallback estimate when a native window is unavailable, not a model-size override.
2. Codex background replay removes the artificial 4K context ceiling. Preserve bounded physical chunks and existing journals. Use fresh `last` token usage rather than cumulative `total`, account for newly injected content, and do not reuse pre-compaction usage. Missing post-compaction usage is unknown, never an invented successful 15% occupancy. If safe further injection cannot be established, keep the cursor and any uncertain injection journal pending. Persist a `contextRecovery` guard on the owning task or rebuild candidate; background retries, replacements and rebuilds cannot repeatedly invoke compaction while awaiting a new usable native observation.
3. Import public Codex visible-history bodies without application-side clipping. A separate serialized-resource limit rejects excessive snapshots before import. Larger accepted candidates use real native compaction before committing the new binding; failure or a fresh report that remains above the safe budget preserves the old binding and independent realtime path. Native summarization can consume quota and is lossy; the canonical log remains authoritative and the model may not retain every detail.
4. DSH incoming public projection preserves complete redacted bodies accepted by the server. Outgoing capture/redaction limits and explicit single-request/transport bounds are unchanged. Normal DSH turns keep native automatic compaction and all provider-specific settings. Polling and passive projection never initiate paid compaction.
5. Keep per-conversation upload consent, exact-runtime routing, idle/single-writer checks, durable cursors, deduplication, snapshot privacy and the bounded Hook fallback unchanged. Neither compaction nor a harness switch grants wider file access or publication authority.

## Compatibility

New capacity-source, observation-fingerprint and context-recovery fields are optional in the existing version-3 state. Existing bindings remain readable; a connector downgrade may reject the explicit `unknown_after_compaction` usage state rather than incorrectly treating it as zero. Older versions do not implement the recovery guard either; do not resume a state carrying `contextRecovery` with an older connector. Preserve private state and use a compatible connector; do not delete bindings or journals as a workaround. Existing first-connect snapshots are not automatically recreated. Recover text omitted by an older snapshot with an explicit new manual import, retaining the previous task as local-only for the user to archive.

## Upstream evidence and limits

Checked against installed Codex CLI `0.154.0` generated schemas and pinned DSH `0.1.2-rc.1` source, not just current documentation:

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): unset native auto-compaction thresholds use model defaults. [App Server](https://learn.chatgpt.com/docs/app-server) exposes explicit compaction and token-usage notifications; raw item injection is not a documented promise of immediate compaction.
- [Codex 0.154.0 history accounting](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/context_manager/history.rs) uses last-request usage plus later local items. [Its compactor](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/compact.rs) can itself reduce oversized input. GatherThread cannot promise that native summaries preserve every fact or fit every custom provider.
- The pinned DSH basic compactor defaults to automatic operation, targets 80% of model context and retains a 16% verbatim tail. It requires a prior request header for automatic pre-step compaction. A first imported backlog, one giant input or a giant retained node can still overflow. `compactNow` performs a model request, not unbounded streaming compression. The native route may use a separately configured summary model or historic request metadata; do not force it through GatherThread's per-turn model-selection hook.

## Deferred work and verification

Guaranteed first-import rescue for arbitrarily large DSH histories needs a supported idle-range/staged-compaction interface that preserves visible records, attribution and crash recovery. It is not implemented by this decision. Unknown/custom model metadata, disabled native compaction, unavailable provider quota and remote context rejection must remain visible errors, not silently truncated success.

A paused Codex background projection currently requires a fresh, usable native usage observation. Reconnection with the same observation, a larger requested model or manual Desktop snapshot import is not an explicit reset. There is no user-facing reset UI/CLI in this preview. If the native task is gone and cannot produce a new observation, a separately designed, user-authorized recovery is still required. The pause does not disable the separate Desktop realtime/Hook path or normal model switching outside this exceptional state.

Regression tests cover large-window Codex replay, last versus cumulative usage, stale usage, required compaction failure, uncut visible messages, incoming DSH long messages and preserved outgoing limits. Mock tests establish connector behavior, not the semantic quality of model summaries. Real provider-window and summary-quality tests remain a release acceptance activity with explicit cost and platform scope.
