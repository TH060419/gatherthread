# GatherThread visual QA, 2026-08-29

## Source states

- Safari dark workspace report: `/var/folders/lc/cgkxcwnd4tb00l_5q24wsj140000gn/T/codex-clipboard-77bd9112-281f-497b-b471-1ebb7081b278.png` and the full-page Safari captures supplied in the active design review.
- Safari rail-note report: `/var/folders/lc/cgkxcwnd4tb00l_5q24wsj140000gn/T/codex-clipboard-2763cee4-5406-4e24-8dfe-e6f9aae69b79.png`.
- Local mock implementation was inspected at 1280 x 720 in light English and dark Simplified Chinese, with ambient canvas off and on.

## Findings and corrections

1. `Conversations` and `Sessions` both localized to 会话. The eyebrow now localizes to 协作 while the primary heading remains 会话.
2. The left-rail Human chat note repeated composer guidance. It was removed rather than replaced with decorative copy.
3. Safari rendered the checkbox pseudo-element switch inconsistently. The semantic input now overlays a separate visual track and thumb; mouse and keyboard activation both update the checked state.
4. Chinese metadata and settings copy were optically undersized and used uneven synthetic weights. The locale now uses the native Chinese UI stack, an 8% size correction, bounded caption minimums, and consistent 600/700 emphasis.
5. Agent response cards used a hard-coded light background. Response surface, border, muted text, and provenance chips now derive from light/dark semantic tokens.
6. The first ambient treatment read as a web of paths and crossed session labels. It now uses only slow radial light fields behind translucent application chrome, with no lines or nodes. Canonical conversation content remains stable.
7. Depth was insufficient in dark mode. Chrome, active sessions, event cards, composer, and settings now use restrained one-pixel highlights and low-opacity layered shadows without moving the existing layout.

## Interaction and accessibility checks

- Verified the visible switch can be clicked and the semantic `role=switch` control remains directly clickable.
- Verified dark Agent response foreground and metadata remain readable on the semantic response surface.
- Verified high contrast disables the decorative canvas; reduced motion and reduced transparency retain solid surfaces.
- Verified the existing settings layout, panel widths, composer actions, session list, and member panel remain in their original positions.
- Web unit/accessibility/build check: 72 tests and production build pass.
