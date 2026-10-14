# PR100: dark-theme DSH dropdown and current-pin regression

## Source and scope

The journey comes from PR100: a user selects the actual DSH provider/model in
Settings without unreadable text. The review additionally requires compatibility
with the reviewed main commit `fa958440` and its PR95 route-recovery safeguards.

The repair changes only the new fixture's compatibility version from
`0.1.2-rc.1` to `0.1.7-rc.2`. It does not change the runtime parser, exact model
selection, authorization, pairing inputs, assertions, timeouts or test skips.

## RED and GREEN

- RED checkpoint `ea6a965`: merge current main into PR100, run `npm run typecheck`,
  then `node --test packages/dsh-host/dist/test/client-bundle.test.js`.
  Compilation passes; 14 tests execute, 13 pass and the new dropdown test fails
  with `the harness state was not reached`. This is an integration-fixture defect,
  not evidence that the production style change broke runtime execution.
- GREEN checkpoint `2c40ddc`: update that one fixture version and repeat the same
  compiled suite. All 14 tests pass, with no skips. PR95's repeated withdrawn-route
  and exact-selection regressions remain included and pass.
- Coverage command: `node --test --experimental-test-coverage
  --test-coverage-include='**/packages/dsh-host/client/client.js'
  packages/dsh-host/dist/test/client-bundle.test.js`.
  Actual client coverage: 80.38% lines, 70.67% branches, 77.78% functions.

## Additional verification

| Guarantee | Check | Result |
| --- | --- | --- |
| Complete source builds | `npm run build`, `npm run typecheck` | Pass |
| Unit regressions remain intact | `npm run test:unit` | 1140 pass, 6 pre-existing skips, 0 fail |
| No new secret patterns or broken references | `audit:secrets`, `audit:references` | Pass |
| Metadata and distributable plugin remain consistent | `release:check`, `release:verify-dsh` | Pass, including Git-less install/import/manifest checks |
| Actual React controls remain readable and submit the selected model | Chromium and WebKit, light/dark, widths 375/768/1440 | 12 scenarios pass |

Browser checks render the real client module with React 19.2.8 and isolated fake
RPC responses. Entry/confirmation use ordinary pointer clicks; model selection
uses the browser's standard select API, not injected React state or force clicks.
Foreground/background contrast accounts for WebKit's alpha system colors.
Dark screenshots in both engines were inspected. There are no page errors or
horizontal overflow in the checked scenarios.

Existing unrelated Web i18n duplicate-key build warnings remain. Native Safari,
the installed real DSH profile, real providers and full keyboard/screen-reader
audits were not exercised by this repair. No release, deployment or package
publication is implied. RED/GREEN checkpoints and this report preserve the
integration evidence if the PR is squash-merged.
