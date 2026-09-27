# Summary display controls regression evidence

Scope: Web display state only. Original canonical history, summary generation permissions and project Agent-context policy remain unchanged.

## RED

New tests reproduced the previous read-only realtime badge, a section that retained the summary heading while revealing originals, global switches retaining section/quote overrides, view switching during source selection, and lost reading position after history reflow. The five regressions failed before the production fixes.

## GREEN

- `npm run build` and `npm test` passed: 912 discovered, 907 passed, 5 explicitly optional/platform skips, zero failures.
- Final CSS refinement and its regression test: `npm run test:web` passed 260 unit tests and one built-output test.
- Chrome and compatible WebKit passed actual mock-app summary generation, section original/summary views, one-click global resets, Chinese mode labels/tooltips and 390px versions-dialog layout. No page errors or horizontal dialog overflow remained. No paid Agent was called.
- A narrow-screen browser check caught dialog defaults overriding spacing and right-edge tooltip overflow. Increased selector specificity and inward tooltip alignment fixed both.
- Reference, license, branding, secret checks and `git diff --check` passed.

## User-facing controls

Toolbar arrows switch all history; arrows on a summary switch only that section. A tiny mode label and localized tooltip provide guidance without replacing icon buttons with text actions. Versions retain their originals and explicit Agent-context independence note. Explicit view changes preserve a visible history anchor and do not force the reader to the latest message.

Native Safari-app automation was unavailable because Allow Remote Automation is disabled. WebKit is compatibility coverage, not a claim of direct Safari-app testing.
