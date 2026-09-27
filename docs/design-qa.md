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

## Beginner guides, 2026-09-28

The reproducible mock-only check is `tests/browser/onboarding.mjs`; invocation is documented in [the web client README](../apps/web/README.md#beginner-guide-browser-regression). Product behavior and isolation are recorded in [PRODUCT_SPEC.md](PRODUCT_SPEC.md#browser-entry-flow) and [ADR-0032](adr/0032-isolated-onboarding-example.md).

- All five guides contain 32 steps in a fresh example: basics 9, collaboration 6, history 5, files 7, summaries 5. Empty accounts, invite-only guests and read-only memberships receive the same complete demonstration. Settings also opens free practice; reset and exit discard it.
- Chrome 153 and Playwright WebKit on macOS passed English/Chinese, 1440×900, 390×844 and 320×568, including actual target visibility, card/target separation, circular or rounded ring geometry, native-dialog layers, toolbar navigation, keyboard/focus and language updates. Desktop history cards stay outside the entire disclosure. Parent API spies found no protected business writes; parent drafts, timeline and selection remained unchanged after free practice.
- The opaque iframe cannot read the parent document or storage. Its self-contained public static document has no backend/runtime access, and only that document permits same-site framing. Real app/API framing remains denied. WebKit's opaque-origin external-asset restriction motivated inline build assets rather than weakening the real application's policy.
- Ordinary session details were checked for unclipped placement, keyboard entry/return (including disabled summary controls) and synchronous cleanup on logout/project/session changes. Independent Spec and Standards reviews identified and rechecked the fixes.
- Translation skips script/style/template content before text normalization; otherwise the self-contained Chinese example can stall WebKit. Narrow WebKit suppresses scripted button focus without user activation; genuine first Tab enters the guide, Shift+Tab/Tab cycles through its toolbar, and Escape exits. Fixed delays are not used to bypass this browser behavior.
- Final Chrome screenshots also checked system dark mode, forced colors and reduced motion. The card uses the dark surface in dark mode and Canvas/Highlight colors under forced colors; rings and controls remain visible.
- Full `npm run release:verify` passed on Node 24: 612 unit tests (607 pass, 5 existing skips), 47 script tests, 268 web tests, 2 build-output checks, 4 integration tests and 9 end-to-end tests. Reference, license, branding, secret, vulnerability and Git-less Codex/DSH package checks passed.
- Playwright WebKit is supplemental engine coverage and is not a real Safari result. Native Safari and Edge manual review remain before merge. All screenshots contain synthetic example data and are kept outside the repository; no real AI agent, credentials, upload or deployment was exercised.
