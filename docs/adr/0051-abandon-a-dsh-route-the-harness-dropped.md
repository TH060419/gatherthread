# ADR-0051: Abandon a DSH route whose model the harness no longer offers

**Date**: 2026-10-12
**Status**: proposed
**Deciders**: T.H.

## Context

[ADR-0032](0032-harness-advertised-model-catalogs.md) made a connected harness the authority on the models it offers, and required the configured model to stay declared while a catalog exists so that a runtime's own route stays claimable. The DSH connector implemented the second half by refusing discovery: when DSH's catalog no longer named the model the connection was registered for, `#refreshExecutionProfiles` threw. Reconcile reported that as a connection failure, so the connector fell back to `connection_failed` and every owner kept advertising the catalog it captured at connect time.

DSH's catalog is advisory and its `resolveModel` returns a route for any identifier, so GT can never learn from DSH that a model stopped working. The trigger is upstream: the provider retires a model and DSH drops it from the catalog. That is how `deepseek-v4-flash-vision-exp` left DSH's catalog in `0.1.6-alpha.2`, after being advertised by every version GT had pinned. Refusing discovery kept the stale catalog on offer indefinitely, which is the opposite of ADR-0032's rule that an offered value must be one the connector will actually accept and run.

## Decision

A route whose model the harness has dropped is abandoned. It is neither republished nor repointed.

- Discovery reports the condition instead of throwing: `#refreshExecutionProfiles` answers `route_unavailable` when DSH's catalog no longer names the configured model.
- Reconcile clears the stored route, stops every owner, and drops the cached declaration, so nothing keeps advertising the profiles and bindings built from the dropped route.
- The connection returns to the state it has before its first selection and reports `recoverableError: "route_unavailable"`, which the DSH panel distinguishes from a fresh pairing before asking for an explicit provider and model against the harness's current catalog.
- The model is never replaced silently. Registering a substitute would run a model this device never selected, which the exact-runtime-selection invariant forbids.

## Alternatives Considered

### Keep the configured model declared alongside the current catalog

- **Pros**: Matches ADR-0032's reserved-slot rule literally, and the connector never drops a route.
- **Cons**: The route names a model the harness has dropped, so the runtime stays registered for something it cannot run and the picker keeps offering it as the connection's own profile.
- **Why not**: The reserved-slot rule exists so that a runtime's in-flight route stays claimable, not so that a retired model stays selectable. Here the route itself is what stopped being valid.

### Repoint the route at a model the current catalog still offers

- **Pros**: The connection keeps working without any user action.
- **Cons**: Executes a model this device never selected.
- **Why not**: Rejected by the exact-runtime-selection invariant, and by ADR-0032's requirement that an offered value be one the connector will actually accept and run.

### Keep failing the whole reconcile

- **Pros**: Smallest change; no new state to model.
- **Cons**: Owners keep the stale declaration, so the retired model stays on offer, which is the defect this decision removes.
- **Why not**: Refusing to refresh is precisely what let the dead model survive.

## Consequences

### Positive

- A retired model leaves the picker as soon as the harness drops it from its catalog.
- The operator is told why the previous selection disappeared instead of seeing a bare connection failure.
- Nothing is substituted silently.

### Negative

- The connection becomes unconfigured and needs one explicit re-selection after upstream retires a model.
- `recoverableError` gains a third value, so the DSH client parser and any other consumer of the native status contract must accept it; both were updated together.

### Risks

- **A dropped route could strand a working connection.** The route is abandoned only when the harness itself stops naming the model, and recovery is a single selection: the panel keeps the control reachable and re-registration is idempotent.
- **A stale or forged catalog could trigger an unnecessary abandonment.** Discovery reads the running harness on a bounded interval and a catalog is published only when it names the configured model; a failed read surfaces as `connection_failed` and retries rather than abandoning the route.
