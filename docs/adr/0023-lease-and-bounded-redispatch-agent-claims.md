# ADR-0023: Lease agent claims and bound their re-dispatch

**Date**: 2026-09-20
**Status**: accepted
**Deciders**: Yuhan He
**Builds on**: [ADR-0013](0013-single-writer-dual-codex-projections.md), [ADR-0015](0015-create-personal-solos-from-first-local-prompt.md), and [ADR-0019](0019-native-history-projection-across-harness-switches.md)

## Context

An `agent_request` is executed by exactly one local runtime, and the server enforces that with a claim row. Until now that row was a plain mutex: `(request_event_id, runtime_id, claimed_at, status)`, with `status` either `claimed` or `completed`, and no lease, no expiry, and no way to release it.

That produced two failures, and they share one cause.

The first is a wedged request. If the executing runtime dies, or its execution hangs, or its identity is rebuilt on another device, the row stays `claimed` for ever. No other runtime may take the request — a different runtime gets `agent_request_already_claimed`, which both shipped connectors correctly treat as a terminal outcome, so the request is never answered and nothing says so. The second failure is worse than the request: because a runtime may hold only one active claim, the same row also permanently consumes that runtime's only slot, and it can never claim anything again.

The third piece of the problem is what the connectors did with a live but unproductive execution. Codex retried only in-process and reported nothing the server could see; DeepSeek Harness never reported failure at all and re-drove the same turn indefinitely. Without a server-side notion of "nobody is working on this", neither could be recovered from.

## Decision

A claim is a lease, not a mutex.

- A claim is created with a lease and renewed by accepted `agent_progress` from its holder. Progress is the only renewal: a device proves it is working by producing work, so a runtime that is merely switched on cannot keep a dead execution alive. Runtime presence stays a separate question and is checked only when a claim is taken, never to extend one.
- A claim whose lease has lapsed is **abandoned**. Any otherwise-eligible runtime of the same user may take it over, including the runtime that held it before.
- Re-dispatch is bounded. Past the attempt budget the request terminates as `failed`, and the server appends one canonical `agent_response` carrying `status: "failed"` so the timeline stops showing a pending request and the failure is attributable. The response names no capture fidelity and carries no runtime provenance: no harness produced it, and claiming otherwise would overstate what the server observed.
- A terminally failed request is never re-dispatched again. Anyone may append a new `agent_request`; the failed one is a record, not a queue entry.
- A lapsed claim no longer occupies its runtime's single active slot, and only a live claim does.

The lease is measured against the server clock and its duration is a server constant, not a client-supplied value.

## Consequences

- A request survives the death of the runtime that claimed it, which is the case the previous design could not express at all.
- A runtime that comes back is usable again instead of being permanently consumed by its own abandoned claim.
- Automatic recovery is bounded, so a persistent fault — an exhausted model quota, a provider outage — ends in a visible failure rather than an unbounded loop of re-execution and spend.
- A lease expiry can re-run work whose first execution is merely slow rather than dead. The renewal rule keeps the window proportional to demonstrated progress, but the hazard is real: re-execution is safe only because both harnesses already refuse to start a duplicate native turn, and the server still accepts at most one completion per request.
- A request that nobody ever claims again is not failed by a background sweeper. It stays pending, and the Web client continues to report it as queued until a runtime exists that could answer it. Recovery is driven by the runtimes that can act, not by a timer.
- The client-visible vocabulary grows by one terminal state; `agent_request_failed` is a claim outcome, not an event type.

## Verification requirements

- A claim whose lease lapsed is taken over by another eligible runtime and completed by it.
- A lapsed claim does not block its former holder from claiming a different request.
- A claim that keeps reporting progress is never taken over, however long it runs.
- Re-dispatch ends within a bounded number of attempts, at which point the request is failed and carries exactly one canonical failure response.
- A terminal failure advances a connector's cursor rather than being retried on every poll, on both shipped harnesses.
