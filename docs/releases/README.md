# Release records

Files in this directory are point-in-time release or candidate records. They may retain historical ports, package status, or deployment assumptions. Use the current top-level README and operational guides for present-day setup.

Current release (2026-10-08): **Beta 1 / `0.1.0-beta.1`** targets matching npm packages and the isolated test service. Its verified-email/password account flow replaces historical qualification/token activation. Test admission remains separate from accounts; production promotion is a distinct operation. Follow [Beta 1 notes](0.1.0-beta.1.md), [current account behavior](../PRODUCT_SPEC.md#browser-entry-flow), [test operations](../TEST_ENVIRONMENT.md) and the [operator preflight](../OPERATIONS.md#public-beta-registration-preflight).

| Version | Git tag | GitHub Release | Record |
|---|---:|---:|---|
| `0.1.0-alpha.1` | yes | no | [notes](0.1.0-alpha.1.md) |
| `0.1.0-alpha.2` | yes | prerelease | [notes](0.1.0-alpha.2.md) |
| `0.1.0-alpha.3` | no | no | [candidate notes](0.1.0-alpha.3.md) |
| `0.1.0-alpha.4` | no | no | [candidate notes](0.1.0-alpha.4.md) |
| `0.1.0-alpha.5` | yes | prerelease | [notes](0.1.0-alpha.5.md) |
| `0.1.0-alpha.6` | yes | prerelease | [notes](0.1.0-alpha.6.md) |
| `0.1.0-alpha.7` | yes | no | [notes](0.1.0-alpha.7.md) |
| `0.1.0-alpha.8` | [verify tag](https://github.com/TH060419/gatherthread/tree/v0.1.0-alpha.8) | no | [notes](0.1.0-alpha.8.md) |
| `0.1.0-beta.1` | [verify tag](https://github.com/TH060419/gatherthread/tree/v0.1.0-beta.1) | [verify publication](https://github.com/TH060419/gatherthread/releases/tag/v0.1.0-beta.1) | [Beta 1 notes](0.1.0-beta.1.md) |

The unpublished pre-Alpha candidate that used the Beta 1 version name is preserved as a [superseded planning record](pre-alpha-beta.1-candidate.md); no published artifact was replaced.

The hosted Alpha 7 release archive identifies source commit `52aac1a5ffda`, and `v0.1.0-alpha.7` now points to that commit. This does not by itself prove the reproducibility of generated build output. The npm Alpha 7 packages were published separately and were not rebuilt when the Git tag moved; no Alpha 7 GitHub Release exists. Verify actual deployment state independently of a Git tag or the current `main` branch.

For Beta 1, verify the Git tag and the exact [Codex connector](https://www.npmjs.com/package/@gatherthread/codex-connect/v/0.1.0-beta.1) and [DSH plugin](https://www.npmjs.com/package/@gatherthread/dsh-host/v/0.1.0-beta.1) package versions before installing. npm uses the `beta` channel; `latest` does not establish the installed prerelease. Source, npm publication, test deployment and production promotion remain separate verification gates.
