# Collaboration controls review

## Scope

PR consolidates quotes and mentions, body-only copy, member removal, bilingual connection copy, Codex/DSH long-task presence, realtime status and summary view controls. Package versions, authentication, cloud Git and Agent context policy are unchanged.

## Independent review

Standards and Spec reviews independently inspected the fixed-base change (`a40fe767b0fcf1971de45dad20c4a5f09edcaeb9`). Three P2 findings were corrected before merge:

1. Mention inbox incorrectly required legacy session membership rows. Use authoritative project membership, matching normal session access. A failing database reproduction covered a post-invitation Multi; the passing regression additionally covers participant-created Solo and denial after removal.
2. Background polling discarded older inbox pages. Preserve loaded entries, cursor, scroll position and focused entry; prevent polling from superseding an in-flight older-page request. Mounted UI regression covers each behavior.
3. Work-log timestamps were still selectable. Explicitly exclude their metadata from selection while retaining selectable message bodies.

Both review axes rechecked the fixes and reported no remaining actionable findings. These reviews are not a claim of exhaustive absence of bugs.

## Verification and limits

The pre-review full release gate passed, including typecheck, all automated suites, reference/license/branding/secret/vulnerability checks, release metadata, and Git-less Codex/DSH package install verification. The final gate is rerun after the review corrections. Focused database and mounted Web regressions pass.

Chrome and compatible WebKit actual mock-app checks cover quoting, member picker, mention navigation, member removal, selection and summary controls. No paid native Agent run is implied. Native Safari automation is disabled on the local host, so Safari-app behavior still needs manual confirmation. Optional external DSH fixtures are explicitly skipped where unavailable; Windows behavior is checked by CI before merge.

GitHub source merge does not publish npm packages or update the live server. Connector/plugin fixes require a later separately authorized package release; server deployment remains a separate operation.
