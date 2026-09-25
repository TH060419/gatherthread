# ADR-0024: Use runtime-advertised profiles for DSH model selection

**Date**: 2026-09-22
**Status**: accepted
**Deciders**: T.H.

## Context

GatherThread originally registered each DeepSeek Harness runtime with one provider and one model. The Web workspace therefore displayed the bound model but could not select another DSH model or reasoning effort for an individual Agent request. Treating the Web selection as presentation-only would be misleading, while relaxing runtime matching without a declared capability would weaken exact-runtime routing.

DSH exposes public exact-model metadata and an Agent-scoped model-selection boundary. That boundary can apply one provider, model, and optional reasoning effort to a GatherThread-driven turn without permanently changing the DSH Web user's own selection.

## Decision

A runtime may advertise a bounded list of exact execution profiles. Each profile names one provider and model and may include the reasoning-effort identifiers and default reported by that exact DSH adapter.

The server persists and returns this declaration. A targeted Agent request may be claimed only when its provider, model, and optional reasoning effort match the selected runtime's advertised profile. A legacy runtime that omits the declaration retains the previous fixed-provider/model rule. Codex routing remains unchanged.

The native DSH plugin advertises profiles discovered through public DSH LLM metadata for its configured DeepSeek provider. The GatherThread Web workspace offers only those advertised values. The connector applies the selected profile at the DSH Agent's prompt-assembly boundary for that GatherThread turn, records the effective model and effort as runtime provenance, and removes the temporary override after the turn. Unsupported or ambiguous selections fail closed; there is no implicit device, provider, model, or effort fallback.

Non-DeepSeek DSH routes keep their existing fixed binding unless they explicitly advertise compatible profiles in a future version. DSH-native model selection outside a GatherThread-driven turn is not rewritten.

## Alternatives Considered

### Hard-code DeepSeek models in the browser

- **Pros**: Small Web-only change.
- **Cons**: Becomes stale, can offer unavailable models or efforts, and cannot prove runtime support.
- **Why not**: The browser must not invent executable capability.

### Allow every DSH runtime to claim any model

- **Pros**: Avoids a registration schema change.
- **Cons**: Weakens exact routing and moves rejection until after a request may already be claimed.
- **Why not**: Runtime capability must be explicit and server-enforced.

### Register one runtime row per model

- **Pros**: Reuses fixed-model claim matching.
- **Cons**: Multiplies heartbeats and identities for one native Session and complicates provenance, recovery, and status presentation.
- **Why not**: One physical runtime with an explicit bounded capability set is the clearer contract.

## Consequences

### Positive

- Users can select a supported DSH model and reasoning effort per GatherThread request.
- Server-side exact-runtime routing remains fail-closed.
- The Web UI reflects the DSH adapter's actual metadata rather than a duplicated catalog.
- DSH's own model selection remains independent outside the scoped GatherThread turn.

### Negative

- Runtime registration and persistence gain a versioned capability field.
- Connector recovery must persist or reconstruct the exact selected profile.
- Older plugins remain fixed-model until upgraded.

### Risks

- A stale or forged declaration could advertise an unusable profile. The authenticated runtime owns the declaration, the server bounds and validates it, and DSH performs exact-model validation again before network execution.
- Multiple model-selection listeners could interfere. The GatherThread override is scoped to its own admitted turn and is cleared after settlement; compatibility tests cover owned and borrowed DSH Agents.
