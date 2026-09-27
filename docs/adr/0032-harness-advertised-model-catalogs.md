# ADR-0032: Discover offered models from each connected harness

**Date**: 2026-09-27  
**Status**: proposed  
**Deciders**: T.H.

## Context

[ADR-0024](0024-runtime-advertised-dsh-model-selection.md) decided that a runtime may advertise a bounded set of exact execution profiles, and that the Web workspace must offer only what a runtime declared. That decision was implemented for DSH alone, and two gaps remained.

The Codex side never used it. The Web model picker was driven by a hard-coded list in `apps/web/src/settings.js` plus browser-local custom identifiers, and the bridge registered a Codex runtime with a single configured model and no declaration. A Codex installation publishes its own catalog, and the App Server exposes it through `model/list` — documented as the discovery method for model pickers, with the explicit instruction to render the returned values instead of a hard-coded list. Hard-coding therefore went stale by construction: a Codex installation offering a newly published model could not be selected in the Web workspace at all.

The DSH side discovered live but cached forever. Native discovery read the DSH LLM metadata once per `(provider, model)` route and skipped every later read, and the server stores a declaration only at registration. A model that appeared in the running DSH profile's catalog after connect was invisible until the connector restarted.

Model identifiers are also handed to a harness as a `--model` argument, so an identifier is not inert data: a leading dash would be read as another command-line flag.

## Decision

A connected harness is the authority on the models it offers, and the Web workspace offers only what the connected runtime advertised.

- **Codex advertises its own catalog.** During preflight, the connector calls `model/list` and converts the result into the same bounded execution-profile declaration DSH uses. Hidden entries are excluded, malformed entries are dropped, and the declaration is bounded by the protocol's limits. Process startup is the discovery point because the declaration must be attached before the first runtime registration; a connector restart picks up a later catalog change.
- **An unusable catalog is not fatal.** If the App Server cannot answer `model/list` — an older version, or the refusal it returns when the managed provider no longer complies — the connector advertises nothing and the runtime keeps the previous fixed-model rule. Discovery never invents a catalog and never blocks the connection.
- **The configured model is always declared while a catalog exists.** The runtime is registered for it, so a request naming it must stay claimable even when the catalog hides or omits it.
- **DSH re-reads its catalog.** A discovered catalog stays authoritative for a bounded interval and is then re-read. When it changes, running connectors re-register and the server updates the stored declaration. Owners that cannot republish are reported as recoverable and retried by the next interval instead of taking the connection down.
- **A declaration is committed only after the server confirms it.** A connector that cannot verify the server recorded the refreshed profiles keeps its previous declaration, so it never claims support for a model the server cannot route to it.
- **Submission stays fail-closed.** A request may name only a model and, for that model, only a reasoning effort the runtime advertised. Model identifiers that could act as a command-line flag, or that exceed the protocol's identifier bound, are refused when advertised and when submitted.

## Alternatives Considered

### Keep a curated model list in the browser, and add the new models to it

- **Pros**: No protocol, connector, or App Server work; the picker stays fully offline-capable.
- **Cons**: The list is wrong the moment a harness publishes a model, and it offers models the connected installation may not run at all.
- **Why not**: This is the defect being fixed. It also repeats the alternative ADR-0024 already rejected: the browser must not invent executable capability.

### Read the Codex catalog file instead of the App Server method

- **Pros**: `~/.codex/models.json` exists on disk and needs no RPC.
- **Cons**: It is a cache with no documented freshness or refresh contract, it may be configured away via `model_catalog_json`, and reading it would couple the connector to a private file format.
- **Why not**: `model/list` is the documented, live, account-aware surface and reports the catalog the running installation actually resolved.

### Let DSH and Codex share one catalog cache with no re-read

- **Pros**: Simplest code, and one fewer call per refresh interval.
- **Cons**: A catalog published after connect stays invisible for the life of the process, which is the second defect being fixed.
- **Why not**: The interval bounds the cost while keeping a long-running connection current.

### Advertise every catalog entry, including hidden and unusable ones

- **Pros**: No filtering decisions, and nothing is ever missing from the picker.
- **Cons**: Hidden entries are hidden for a reason, and an entry the connector would refuse to submit must not be offered.
- **Why not**: An offered value must be one the connector will actually accept and run.

## Consequences

### Positive

- A model published by either harness becomes selectable without editing browser code.
- The picker, the request boundary, and the server's claim matching all derive from one declaration per runtime.
- An unsupported or unresponsive harness version degrades to the previous fixed-model behavior instead of failing.
- DSH keeps a long-running connection current without a reconnect or restart.

### Negative

- Connector startup performs one extra catalog call, bounded by its own deadline so an App Server that silently ignores the method cannot stall startup.
- The server stores and returns a larger runtime registration. The declaration is bounded to 32 profiles and 16 efforts per profile.
- Discovery refreshes cost one metadata call per provider per interval.

### Risks

- **A stale or forged declaration could advertise an unusable model.** The authenticated runtime owns its declaration, the server validates and bounds it, the connector re-verifies what the server echoed, and the harness validates the model again before execution.
- **A catalog change could land mid-request.** A refresh only changes what future requests may name; an in-flight claim keeps its recorded profile and runtime identity, and re-registration is idempotent per device, harness, and local session.
- **A refresh that fails could leave the advertised list partially updated.** A connector that cannot republish keeps its previous declaration, the failure is surfaced as recoverable, and the next interval retries.
- **Discovery could stall startup on an unresponsive harness.** The catalog call has a shorter deadline than an ordinary request and is treated as optional work.
