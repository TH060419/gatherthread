# ADR-0032: Isolate onboarding in a disposable example project

**Date**: 2026-09-28  
**Status**: proposed  
**Deciders**: Project maintainer review

## Context

Empty accounts, read-only roles, absent summaries and disconnected runtimes hide controls that a complete tutorial must explain. Temporarily creating real projects, granting permissions or copying private state into a demo would cross existing trust boundaries.

## Decision

Reuse the real application shell in a sandboxed iframe with scripts allowed and same-origin access denied. Build a self-contained static example with a classic bundle, inline CSS, data images and fonts. WebKit blocks external `self` assets in an opaque-origin document, so the example loads no external resources. Its bootstrap supplies memory-only storage and a fresh authored Mock API, rejects runtime/network clients, and applies a restrictive CSP. Only `/app/example.html` permits same-site framing; it also enforces an opaque sandbox in its response header, rejects backend connections and form submission, and allows only the authored inline script by nonce. Real application, product and API routes retain their framing denial. The fixed nonce belongs to a public static example that renders no untrusted input as executable HTML; it is not a credential or authorization token.

The parent sends only locale, theme, a validated guide topic and a random presentation channel. Messages back are limited to choosing a guide or exiting and must match the frame source and channel. Tutorial steps prepare mock-only scenarios; Settings also offers free practice and reset. Real credentials, project state, drafts and messages never enter the frame. The parent alone persists first-visit progress using the existing account/device/origin key.

## Alternatives considered

- Showing missing-control explanations leaves first-time users without the promised demonstration.
- Mutating the real workspace would risk privacy and data loss.
- Rendering a separate static imitation would drift from the actual controls and permissions.

## Consequences

Every account can inspect all supported scenarios without a real runtime or business write. Reset and exit discard practice state. The extra bundle increases static build size; it is fetched only when opening the example. Browser regressions must verify the opaque boundary, parent state preservation, targets and native-dialog layers as the shell evolves. The example does not promise real execution, filesystem access or provider behavior.
