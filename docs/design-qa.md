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

The reproducible mock-only check is `tests/browser/onboarding.mjs`; invocation is documented in [the web client README](../apps/web/README.md#beginner-guide-browser-regression). Product behavior and isolation are recorded in [PRODUCT_SPEC.md](PRODUCT_SPEC.md#browser-entry-flow) and [ADR-0033](adr/0033-isolated-onboarding-example.md).

- All five guides contain 34 steps in a fresh example: basics 10, collaboration 7, history 5, files 7, summaries 5. Empty accounts, invite-only guests and read-only memberships receive the same complete demonstration. Settings also opens free practice; reset and exit discard it.
- Chrome 153 and Playwright WebKit on macOS passed English/Chinese, 1440×900, 390×844 and 320×568, including actual target visibility, card/target separation, circular or rounded ring geometry, native-dialog layers, toolbar navigation, keyboard/focus and language updates. Desktop history cards stay outside the entire disclosure. Parent API spies found no protected business writes; parent drafts, timeline and selection remained unchanged after free practice.
- The opaque iframe cannot read the parent document or storage. Its self-contained public static document has no backend/runtime access, and only that document permits same-site framing. Real app/API framing remains denied. WebKit's opaque-origin external-asset restriction motivated inline build assets rather than weakening the real application's policy.
- Ordinary session details were checked for unclipped placement, keyboard entry/return (including disabled summary controls) and synchronous cleanup on logout/project/session changes. Independent Spec and Standards reviews identified and rechecked the fixes.
- Translation skips script/style/template content before text normalization; otherwise the self-contained Chinese example can stall WebKit. Narrow WebKit suppresses scripted button focus without user activation; genuine first Tab enters the guide, Shift+Tab/Tab cycles through its toolbar, and Escape exits. Fixed delays are not used to bypass this browser behavior.
- Final Chrome screenshots also checked system dark mode, forced colors and reduced motion. The card uses the dark surface in dark mode and Canvas/Highlight colors under forced colors; rings and controls remain visible.
- Full `npm run release:verify` passed on Node 24: 612 unit tests (607 pass, 5 existing skips), 47 script tests, 268 web tests, 2 build-output checks, 4 integration tests and 9 end-to-end tests. Reference, license, branding, secret, vulnerability and Git-less Codex/DSH package checks passed.
- Playwright WebKit is supplemental engine coverage and is not a real Safari result. Native Safari and Edge manual review remain before merge. All screenshots contain synthetic example data and are kept outside the repository; no real AI agent, credentials, upload or deployment was exercised.

### Example dialogue and language follow-up, 2026-09-28

- Authored speakers now use distinct names/initials and a continuous discussion about building a club event signup page. Two completed summary versions precede the production request; the result reports page creation and a checked signup button, then a collaborator submits an improved confirmation for review. The actual bilingual page file and reviewed variant match the story.
- In-example language preview, cancellation and saving update seed identities, authored dialogue, members and navigation without discarding practice messages or renamed projects. Moving to another guide keeps the sample locale; the real workspace locale stays unchanged. Refreshing guide copy keeps its owned Settings dialog alive.
- The opaque sandbox still denies native form submission. Submit-button activation instead dispatches the shell's existing local handler after form validation, making demo Settings save usable without adding `allow-forms`, navigating or accessing a backend.
- The summary tutorial and ordinary Settings helper now describe the intended focus benefit: concentrating agreed conclusions and reducing irrelevant information may mitigate AI attention dispersion, while summaries remain lossy.
- Follow-up verification: 269 Web tests and 2 build-output checks passed; Chrome 153 and Playwright WebKit repeated the then-current 32 steps across the documented account states and sizes, plus preview/cancel/save, guide-owned Settings language refresh, sample-language navigation, practice preservation and parent isolation. A Chinese original-message screenshot was visually inspected. Native Safari remains a separate manual check.

### Simple vibe-coding scenario, 2026-09-28

- The example now builds a club event signup page with only time, place and one signup button. Natural-language discussion precedes two source-linked summary versions, followed by an AI production request/report and a collaborator's small file improvement submitted for review. No coding knowledge appears in the scenario copy. The actual `signup.html` fixtures implement the original and improved confirmations in both languages.
- Both Chrome 153 and Playwright WebKit exercised all four produced-page variants: success text is initially hidden, clicking the button reveals it, and the reviewed variant adds the Saturday greeting. The then-current 32 tutorial steps passed at 1440×900, 390×844 and 320×568, including existing language/save/cancel and parent-isolation checks. The longest summary exposed a narrow quote target below the viewport; a bounded example-only timeline fixes it, and the summary is now a concise three-item checklist.
- Final gate for this theme change: 270 Web tests and 2 build-output checks passed; the produced page and example timeline were visually inspected. This tests authored demonstration fixtures, without running a real local AI agent or contacting a backend.

### Summary Settings copy, 2026-09-28

- Settings now has a distinct Summaries heading. Summary is recommended for organizing conversations and focusing on agreed conclusions with less distraction; Original is described as useful for exact wording and details. Copy retains the detail-loss caveat and notes that generating summaries consumes model quota without guaranteeing token savings. The final summary tutorial uses the same rationale.
- 270 Web tests and 2 build-output checks passed. Chrome at 320×568 and Playwright WebKit at 1440×900 passed the tutorial, language-switch and isolation checks; a late Chrome keyboard-focus assertion failed once and passed on a standalone rerun. Bilingual Settings headings, the default summary choice and both selectable modes were checked in Chrome and visually inspected. The English option labels were shortened after inspection to avoid clipping.

### PR submission verification, 2026-09-28

- `npm run release:verify` passed on the final application code: 612 unit tests (607 pass, 5 existing skips), 47 script tests, 270 Web tests, 2 build-output checks, 4 integration tests and 9 end-to-end tests; audits and Git-less package verification passed, with zero dependency vulnerabilities.
- Full Chrome and WebKit browser runs passed all authored guide scenarios and produced-page variants. Chrome's late disclosure keyboard assertion intermittently failed before a standalone and full rerun passed. The test now waits for the native disclosure toggle to portal the panel before focusing its children, and includes active-element diagnostics on failure. Native Safari and Edge remain manual follow-ups.

### PR #48 review fixes, 2026-09-28

- The open session-status panel stays visually portalled outside clipped ancestors. Its controls leave native document tab order while open; explicit Tab and Shift+Tab handling preserves the logical order from the header button through the panel and back to the remaining page. Closing it restores original tab indices. A mutation observer applies the same rule to controls added while open.
- Browser coverage traverses each visible panel control, continues through the rest of the page to document end, and checks that the panel is not revisited. Chrome and WebKit are checked separately. The onboarding ADR is now 0033 because current main uses 0032 for harness model catalogs.

### Beginner copy and focus readiness, 2026-09-28

- The first-use guides now explain shared messages directly instead of relying on "context" terminology. The summary selection step expresses its existing text limit in approximate English and Chinese character counts and tells users how to recover if they select too much.
- The guide exposes when its current step has attempted to focus the Next button. Browser checks wait for that step-specific signal before asserting focus, avoiding a fixed-delay race while retaining the keyboard assertion. Full Chrome and repeated Playwright WebKit guide runs passed across populated, empty and viewer accounts at 1440×900, 390×844 and 320×568.
- Native Safari opened the local mock workspace and Settings, but the UI automation stopped with `noWindowsAvailable` before entering a guide. Microsoft Edge was not installed on this machine. Neither platform is counted as a completed native-browser tutorial check.

### Separate Summary Settings section, 2026-09-28

- The ordinary Settings navigation now has a bilingual Summaries entry beside Sync & context. Summary policy and instructions live in their own labelled section with the existing control IDs and handlers. Navigation scrolls and focuses the target section inside the dialog without replacing the project/session URL fragment.
- Chrome and Playwright WebKit cover English at 1440×900, plus Chinese at 1440×900 with no projects, 390×844 as a viewer, and 320×568 with no projects. The checks traverse from the dialog's initial focus to the Summaries link with Tab in Chrome and Option+Tab in WebKit (Safari's default Tab skips links), activate it with Enter, click both section links, and verify section visibility, translated labels and the unchanged project URL. Native Safari visually rendered the separate 摘要 entry after a local mock reload, but UI automation returned `noWindowsAvailable` when interacting inside Settings; its navigation and keyboard behavior remain unverified. Edge was unavailable.

### Create and invite entry points, 2026-09-28

- The isolated guide now points directly to Create session and Create invitation. It keeps the Multi/Solo explanation at the conversation-list step and the role explanation in the collaboration guide; examples remain in free browsing as requested. Both new controls are highlighted without touching the real workspace. The guide contains 34 steps: basics 10, collaboration 7, history 5, files 7, summaries 5.
- `npm run test:web` passed 282 Web tests and 2 build-output checks. Sequential Chrome and Playwright WebKit runs passed the complete guides at English 1440×900 and Chinese 1440×900, 390×844 and 320×568, including real arrow-key progression from both new steps. The invitation control is centered inside the scrollable member panel, and the following join step highlights the invitation-key input. Native Safari and Edge remain unverified for these new steps.
- The server and preview-service example CSP response headers match. The built example's meta CSP repeats the enforceable content restrictions; `frame-ancestors` and `sandbox` remain header-only. Existing server, preview and build-output tests check framing, sandboxing, the script nonce and denied backend connections.

### Device-specific guides and GitHub-first file sharing, 2026-10-06

- Settings now offers six bilingual guides: basics (10 steps), collaboration (7), conversation history (5), project files (14), summaries (5), and account/devices (4). GitHub is recommended first for real development; GT Cloud is limited-quota storage for lightweight trials. File transfer and conversation-history switches remain independent, and the guides explain device authorization, automatic/manual upload, personal versions, explicit review, downloads and separate-folder recovery.
- Phone/tablet guides follow the actual compact drawers and sheets. They describe direct Cloud Agent use as the planned enabled-service experience and same-account computer Agent use with the computer/connector kept online. This tutorial wording does not enable production Cloud Agent gates. Desktop browsers, including narrow windows and Windows touch laptops, keep desktop controls; iPad desktop-style identification is included in the separate workspace fixture.
- Combined-layout testing exposed a card overlapping the conversation list at 820×1180. Limiting cards inside compact modal sheets fixed the overlap without relaxing target, ring, dialog-boundary or focus assertions. Mobile mention instructions now identify Conversation tools or composer `+`, rather than the desktop top-right location.
- Sequential Chrome and Playwright WebKit runs passed all six guides in English/Chinese at 1440×900, phone sizes 390×844 and 320×568, and tablet sizes 820×1180 and 1024×768, including empty/read-only accounts and denied progress storage. Ordinary clicks exercise Next, sample actions and Settings; mobile guides also exercise Back/Next clicks, while the dedicated create/invite steps retain arrow-key coverage. Mock origin/storage isolation and zero parent business writes remain checked. Native Safari, Edge and physical mobile keyboard behavior are not certified by these emulated checks.
