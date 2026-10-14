# PR95: repeated DSH model-withdrawal recovery

## Scope and user journey

This follows the PR95 review finding and ADR-0051. A paired user must be able to
recover after the chosen model, and then its replacement, disappear from DSH's
catalog. The next confirmation must submit the model shown from the current
catalog. Status polling must not erase a valid selection while the user chooses.

The follow-up changes only the bundled DSH settings client and its tests. It
does not change native execution, authorization, device credentials, shared
thinking, quotas, server deployment, npm packages or version tags.

## RED / GREEN evidence

- Base: `e0c71ccfc616d73a7a5e54f44450df14da8540bd`.
- RED checkpoint: `ae32dbb`, extending the real-handler recovery regression.
- Compile: `npm run build:ts` passed before the RED test ran.
- RED command: `node --test --test-name-pattern='replacement route also disappears' packages/dsh-host/dist/test/client-bundle.test.js`.
- RED result: 1 executed, 1 failed. The third confirmation submitted
  `deepseek-flash` instead of the current catalog's `deepseek-v4-pro`.
- GREEN checkpoint: `5a92549`, observing recovery in both poll and configuration
  responses, validating refreshed choices and refusing invalid submissions.
- GREEN command: `node --test packages/dsh-host/dist/test/client-bundle.test.js`.
- GREEN result: all 13 client tests passed, including the same regression.

The regression drives actual catalog/read/configure handlers with persistent
hook state; it does not inject a provider/model directly into hook state.

## Additional verification

An isolated React 19.2.8 / ReactDOM page loads the changed client itself and uses
ordinary Chromium clicks. After two withdrawals it reports:

```json
{"ordinaryClicks":true,"visibleModel":"current-c","postedModel":"current-c","passed":true}
```

The model and RPC values are synthetic; no account, real provider or deployed
service is involved.

| Check | Result |
| --- | --- |
| `npm run build` | Passed; pre-existing duplicate i18n-key warnings remain |
| `npm run typecheck` | Passed |
| `npm run test:unit` | 1,139 passed, 6 existing platform/native-fixture skips, 0 failed |
| `npm run test:web` | Passed, including the built Web output checks |
| `npm run test:scripts` | 136 passed, 0 failed |
| `npm run test:integration` | Passed |
| `npm run audit:secrets` | Passed |
| `npm run release:check` | Passed |
| `git diff --check` | Passed |

Coverage command:
`node --test --experimental-test-coverage packages/dsh-host/dist/test/client-bundle.test.js`.
The VM now names the actual source URL so coverage includes the client rather
than reporting an empty 100% total. Client coverage is 80.18% lines, 70.67%
branches and 77.78% functions. This is not a whole-repository coverage claim.

## Verification boundaries and merge evidence

The Chromium check is an actual component interaction, not a native Safari or
full DSH installation check. The author reported the complete pinned DSH
0.1.7-rc.2 native/browser gate at base `e0c71cc`; that receipt remains separate
from this follow-up's local checks. The fixed head requires fresh CI and an
independent Standards / Spec review before merging. No test skip was introduced
or privacy/output assertion removed by this follow-up.

If these checkpoint commits are squash-merged, retain this RED/GREEN summary in
the PR or squash-commit description. Merge permission does not authorize server
deployment, npm publication or moving tags.
