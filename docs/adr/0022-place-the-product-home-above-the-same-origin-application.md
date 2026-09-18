# ADR-0022: Place the product home above the same-origin application

**Date**: 2026-09-18
**Status**: accepted
**Deciders**: Yuhan He

## Context

GatherThread already serves its login and collaboration workspace from the owner host root. The new product page needs to become the deployment entry without weakening the established authentication, invitation, Cookie, API, WebSocket, responsive, or accessibility behavior. Existing project, session, DSH pairing, and mock links also need to keep working.

Running the product page as a second service would create a second origin, a separate deployment surface, and unclear routing between marketing and authenticated application state. Co-loading its global CSS and JavaScript into the workspace would risk visual and behavioral regressions.

## Decision

The owner host serves one built Web tree and one browser origin:

- `/` serves the product home from `site`.
- `/app/` serves the existing `apps/web` login and collaboration application unchanged as a separate entry point.
- Product-home actions open `/app/`.
- Root requests carrying `?api=...`, `?mock=1`, `#project`, `#session`, `#dsh-pair`, `#settings-*`, or `#main-content` are forwarded to `/app/` with the original query and fragment intact.
- API and WebSocket routes remain under `/v1`, and browser session cookies remain scoped to `/`.
- The two surfaces keep separate CSS and JavaScript bundles, while the build and owner host publish them together.

## Alternatives Considered

### Separate product-page service or origin

- **Pros**: Independent deployment and styling.
- **Cons**: Additional process, origin, CSP, proxy, Cookie, and documentation complexity.
- **Why not**: The current self-hosted and private-network modes need one predictable entry point.

### Merge the product page into the application document

- **Pros**: One HTML document and one navigation state.
- **Cons**: Global marketing styles and scripts could interfere with stable workspace controls and event bindings.
- **Why not**: Visual work must not change the application's functional contract.

## Consequences

### Positive

- Deployments open with a clear product introduction and one action into the existing application.
- Authentication, invitations, APIs, realtime delivery, and existing cookies remain same-origin and unchanged.
- Legacy operational links continue to work.
- Product-page styling cannot leak into the workspace.

### Negative

- The Web build owns two HTML entry points and must test both output trees.
- Relative application assets now live below `/app/`.

### Risks

- A future root deep-link type could miss forwarding. Mitigate by adding it to `site/boot.js`, the interface contract, and route tests in the same change.
- Duplicate logo assets could drift. Mitigate with an exact asset-equality test until the build adopts a single copied source.
