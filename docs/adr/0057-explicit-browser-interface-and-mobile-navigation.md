# ADR-0057: Explicit browser interface and mobile navigation

- Status: proposed / local implementation
- Date: 2026-10-18

## Context

Automatic mobile classification can misidentify tablets or touch computers. Moving entire desktop sidebars into small dialogs also exposes too many unrelated controls at once. Users need a simple mobile workflow without changing the existing authorization or execution paths.

## Decision

Keep a non-secret, origin/browser-local `auto|mobile|desktop` preference independent of account settings. Auto detects a candidate using platform, touch/pointer and viewport signals and asks for an explicit choice; it does not silently switch. Login and General expose the same immediate switch. Storage failures fall back to page memory. No account, credential or server setting is stored by this feature.

Separate presentation from physical-device capability. Desktop mode on a phone cannot enable a local Launcher or connector. Mobile mode on a computer hides installation controls without removing already-authorized Agent choices. Switching moves original controls through reversible DOM markers, preserving handlers, IDs, permission states and drafts; it makes no API call and never reloads the page.

Mobile navigation uses focused conversation, project, member and invitation pages. Settings has a directory and one section at a time. Project files keeps connection/status controls and leaves local transfers, recovery, merging and PR publication to desktop. CSS is explicitly mode-gated, not solely viewport-gated. Hidden desktop form values remain intact; invalid core fields reveal their page before native validation focuses them.

The isolated example inherits only the parent's existing presentation hint. It does not inspect parent data, acquire storage or backend permissions, or present another device-detection prompt.

## Consequences and verification

Changing presentation does not grant account, project, device, model, filesystem or GitHub authority. Server contracts remain owned by [Interface contracts](../INTERFACE_CONTRACTS.md). Native eligibility is checked independently, and exact remote/runtime routing is unchanged.

Verify both directions of manual switching, persistence and denied storage; phone/tablet/desktop pointer interaction, modal focus and overflow; and same-account remote Agent requests, Pause/Resume, summaries and quotes. WebKit checks are not a claim of native Safari validation. No publication or deployment follows from this presentation change.
