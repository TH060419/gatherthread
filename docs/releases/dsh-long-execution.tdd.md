# DSH long-execution presence regression evidence

This follow-up derives its journeys from the request to include DSH in the long-task false-disconnection fix. It is an unreleased local change, not a release or deployment claim.

## RED / GREEN

Before changing production code, `npm run build:ts && node --test --test-name-pattern='long DSH execution|DSH heartbeat recovery' packages/dsh-host/dist/test/connector.test.js` failed both new tests: no public busy activity before settlement, and successful heartbeat left the lifecycle state `offline` during a blocked prompt.

After the patch, `npm run build:ts && node --test packages/dsh-host/dist/test/connector.test.js` passed all 42 tests. Existing durable-event renewal, exact provider/model/effort routing, permission checks, context isolation, manual upload/outbox recovery, and identity-drift shutdown remain covered.

Final delivery checks: `npm run build && npm test` passed (907 discovered, 902 passed, 0 failed, 5 skipped). The existing skips are one Windows-only PowerShell case and four optional upstream DSH Session fixtures. `npm run audit:references`, `npm run audit:secrets`, and `git diff --check` also passed.

| Guarantee | Regression test | Result |
| --- | --- | --- |
| Native busy activity is visible before the answer; independent presence continues while prompt is blocked | long DSH execution publishes busy immediately and keeps presence without fabricating work | PASS |
| Healthy heartbeat restores running without waiting for prompt completion | DSH heartbeat recovery restores running before a long prompt settles | PASS |
| Healthy heartbeat also restores idle after a transport error | runtime heartbeat is independent of polling, retries transport failure, and stops on unload | PASS |
| Shutdown cannot be undone by a late heartbeat rejection | a late DSH heartbeat failure cannot change a stopped connector back to offline | PASS |
| Native durable event bursts still coalesce and renew the exact claim attempt | live durable DSH events renew the claim before the prompt returns | PASS |
| Identity drift cancels the native writer without publishing an answer or subsequent work | runtime identity drift interrupts a blocked initial prompt without publishing a result or further work | PASS |

## Scope and limits

The six-minute test advances a controlled clock while the native prompt promise stays unresolved: 36 heartbeats occur at the default ten-second interval and no synthetic progress is generated. It tests connector scheduling, not six minutes of a paid live model or an actual network outage. Existing server lease tests remain authoritative: presence alone must never renew a five-minute inactive claim. No coverage percentage is claimed; optional upstream Session fixtures and platform-only tests retain their existing prerequisites. No commit, publication or deployment was performed.
