# Product documentation and coded onboarding demo

## Outcome and boundaries

The requested beginner journey is discussion → summary → explicit Agent request →
files and checks → teammate review → a usable result, with desktop/mobile guides
and current product copy. The example is authored, not a new model execution.
No server, account migration, npm package, version tag or deployment is changed.

## RED and GREEN

- Before implementation, after building the protocol dependency, the focused
  example/onboarding suite executed 12 tests: 8 passed and 4 failed. The failures
  identified the missing six-file project, core code and extended workflow.
  A prior missing-dependency run is not counted as RED evidence.
- Checkpoint `293995f` supplies the coded example. The focused suite now executes
  13 tests, all passing. RED preceded commit authorization and has no separate
  historical commit; the report does not invent one.
- Browser RED: both Chromium and WebKit at 320×568 stalled at the new review
  step because the asynchronous branch list arrived offscreen after the first
  target resolution. GREEN retries example-only target scrolling when that
  panel arrives and highlights Maya's compact View changes button.
- The generated six-file projects are materialized into disposable directories
  in both languages and both revisions. Their own `npm test` runs three actual
  behavior checks, including repeated-click prevention. Only those disposable
  directories are cleaned up.

## Local verification

| Check | Result |
| --- | --- |
| `node --test apps/web/test/example-api.test.js apps/web/test/onboarding.test.js` | 13 pass, no skips |
| `npm run test:unit` | 1140 pass, 6 pre-existing skips, no failures |
| `npm run test:scripts` | 136 pass |
| `npm run test:web` | 561 pass, plus 3 built-output checks |
| `npm run test:integration` | 5 pass |
| `npm run test:e2e` | 9 pass |
| `npm run typecheck`, `audit:references`, `audit:branding`, `audit:secrets`, `git diff --check` | Pass |

Targeted Node coverage for `example-api.js` and `example-project.js` is 95.38%
lines, 97.75% branches and 83.33% functions. DOM viewer behavior is covered by
browser interaction, not misrepresented as part of that Node coverage figure.

Browser command (with a built loopback preview):

```sh
ONBOARDING_ORIGIN=http://127.0.0.1:18941 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
ONBOARDING_BROWSER=chromium node tests/browser/onboarding.mjs
```

The Chromium and WebKit matrices cover English/Chinese at 1440×900, phones at 390×844 and
320×568, and tablets at 820×1180 and 1024×768, including empty/read-only accounts
and denied progress storage. Pointer actions are ordinary, unforced clicks.
Result checks click the real signup button, inspect all six files, switch to the
teammate revision, close the dialog and verify actual previous-focus restoration.
All parent business-write spies remain empty; parent history and drafts survive.

Visible Chrome additionally passed the result, toolbar, reset and language
preview/cancel/save checks in a fresh automation profile. Installed Chrome's
headless path reproduced a parent-iframe input-routing failure on an untouched
main archive as well as this branch; it is not counted as a successful check.

Native Safari 26.3.1 passed ordinary clicks in both languages: open the result,
click signup, inspect six files/source, close, complete all 14 basics steps and
all 16 file steps. The independent local test used 100% page zoom after Safari's
driver misrouted clicks at the inherited 115% zoom. Temporary remote automation,
developer-menu visibility and local-page zoom were restored afterward.

Geometry assertions use a single browser-tick snapshot so an asynchronous scroll
cannot compare a ring with its target from a different frame. The one-pixel
alignment, card/target separation and keyboard-cycle assertions remain intact.
When WebKit denies script focus before activation, genuine Tab/Shift+Tab checks
must enter the guide and complete its focus cycle; the check is not skipped.

## Documentation and asset checks

Current README, bilingual product/cloud guides, file and connection guidance,
homepage feature copy and ADR-0033 are aligned with main. Historical release
notes and dated verification records are not rewritten as present capabilities.
Forty full-viewport authored-example captures refresh their measured annotation
bounds. The four existing approved poster compositions are rerendered, not
redesigned. Capture source and publishing mappings live in
`docs/assets/product/README.md`.

The independent Spec review caught desktop user agents in the first phone/tablet
capture pass. The follow-up uses matching touch/mobile contexts, asserts the
mobile layout and hidden local-connection control, and recaptures all forty
scenes. All twelve homepage publishing copies and the official lockup were
checked byte-for-byte; mobile images and the updated cover were visually reviewed.
The capture helper's unused branch-opening mode was removed after Standards review.

No real model, GitHub OAuth/repository write, private account or server is used.
The new executable preview accepts only fixed authored fixtures, never uploaded
HTML. Both nested frames retain opaque `allow-scripts` sandboxing; source code
is rendered as text.
