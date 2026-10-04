# PR #60 review-fix evidence

Scope: GitHub source-acquisition authorization/cancellation, untranslated private previews, and bilingual public errors. Cloud Agent remains default-closed. No API shape, provider activation, npm version or deployment setting changes.

## RED checkpoint

At `fa6698b` (production code still at `14ced9f`):

- The 38 source-acquisition boundary tests executed: 31 failed, seven passed. Downgrade/rebinding during metadata responses or token refresh allowed later GitHub reads; shutdown could persist a new starting snapshot.
- The 18 focused Web tests executed: three failed, 15 passed. Raw answer/source/path nodes lacked translation protection, and public GitHub errors lacked Chinese copy.
- Actual browser integration passed English and failed Chinese at the expected localized access-error assertion. An earlier fixture-only failure was corrected to wait for the canonical answer before selecting its private task; it is not counted as bug evidence.

The follow-up RED checkpoint `6210ab6` adds in-page language switches. The actual first failure was the missing-file placeholder staying English after switching to Chinese, not the access error described in that commit message. Independent localizer reproduction also showed an already-Chinese error staying Chinese after switching to English. Source previews now separate translatable missing/binary/truncation notices from raw text; the view retains canonical English UI sources through `localizer.setText`.

## GREEN focused checks

- `npm run build:ts` and `node --experimental-test-coverage --test apps/server/dist/test/hosted-github.test.js`: 98 passed, zero failed/skipped. Includes all 38 boundary cases, two real loopback fetch cancellations during pending headers/body, and the existing OAuth generation, binding, publication, continuation, proxy, deletion and quota tests.
- Coverage for the production `hosted-github.js` in that focused run: 93.58% lines, 83.15% branches, 92.42% functions. This is not a claim about whole-repository coverage or real provider compatibility.
- `node --test apps/web/test/cloud-github-view.test.js apps/web/test/i18n.test.js`: 18 passed. All 13 existing public GitHub failure messages have English/Chinese explanations; raw answer, path and source remain unchanged.
- `npm run build:web`, then `node tests/browser/cloud-github.mjs` both normally and with `GATHERTHREAD_TEST_GITHUB_ADMISSION=1`: eight Chrome/WebKit English/Chinese flows passed. Actual HTTP/UI checks include OAuth callback, repository binding, localized server failures, dictionary-colliding raw previews, in-page language switches in both directions (errors, missing/binary files, truncated previews and unchanged raw text), explicit draft PR, account/admission boundaries, quota refusal, mobile and Escape. The script accepts `PLAYWRIGHT_MODULE` when Playwright is installed outside the repository.
- `git diff --check` passed. Full release and current-head cross-platform CI remain mandatory merge gates; their final results belong in the PR review, not a speculative success statement here.

## Safety and limits

Source reads revalidate immediately after token acquisition and after responses, before accepting data. The task abort signal is combined with the request timeout. A cancelled/revoked acquisition is not persisted or sent to the executor. Requests already sent cannot be recalled; concurrent blob requests dispatched before revocation may have reached GitHub, but their results are rejected.

Private previews use text nodes with localizer skip markers, not HTML. UI labels still translate. Tests use GitHub/model/container fixtures, except actual loopback transport cancellation. No real credentials, model charges or GitHub writes are used. WebKit is compatibility coverage, not native Safari-app certification. Real App/provider approval and Linux container activation gates remain in [HOSTED_GITHUB.md](../HOSTED_GITHUB.md).
