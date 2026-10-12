# Mac Launcher DMG and installation guidance

Date: 2026-10-12. Original base: `d4fb9f95eb88c0e1ac8182d9fd8a31aeb5dbc201`.
Integrated main: `8d6acd14004d8fd04aed63457a65f35e17880605` (PR88).
Verified implementation head: `846d9b799a69d11f3891b4a62f1a6ee33ebdcb76`.
Status: local implementation and focused verification complete; independent PR
review, publication and deployment remain separate. This report is an evidence-only
follow-up to that implementation head.

## Scope and preserved behavior

The Mac primary package is a DMG with the app, an adjacent Applications drag
target, a bilingual installation guide and public build provenance. The native
Launcher and Mac Web guide emphasize the exact System Settings / Privacy &
Security / Open Anyway path and explicit review/trust/allow of GatherThread
Hooks. Windows retains its ZIP and omits Mac-specific Web instructions.

Email/password handoff, masked/nonpersistent password input, independent native
devices, exact test/production origin binding, existing icons, Linux/self-hosted
terminal fallback, and mobile/tablet selection of an already connected computer
Agent remain unchanged. No account, Codex session or installed Applications app
was accessed for these checks.

## RED → GREEN checkpoints

| Checkpoint | Observed RED | GREEN |
| --- | --- | --- |
| `695fba8` → `81c572b` | Existing seven packaging tests passed; new DMG stage, exact-inventory, failure/nonpublication, detachment and native bold-guide tests failed without implementation. Web guide/platform tests exposed missing instructions. | Python 16/16 and focused Web 13/13 passed; native form and real DMG creation/mount validation passed. |
| `5627fde` → `2a3089b` | Two new tests failed because no reviewed-file-only plugin copy helper existed. | Python 18/18 passed; untracked plugin files are excluded and tracked symlinks/path escapes rejected before copying. |
| Merge `846d9b7` | ADR index append conflict with PR88. | Retained both ADR0046 and ADR0047; all focused checks below passed on the integrated main. |

The initial Chinese Web regression used an incorrect test locale `zh`; GREEN
corrected the fixture to the supported `zh-CN`. That fixture error is not claimed
as a product defect. No production validation/security gate was relaxed.

## Verification on the integrated implementation

- `python3 -m unittest discover -s prototypes/codex-launcher/macos -p 'test_*.py' -v`: **18/18** pass. Negative cases include missing resources, wrong versions, altered hashes, linked/private/unreviewed files, wrong Applications target, extra image entries, failed image validation, pre-existing output and cleanup.
- `node --test apps/web/test/launcher-install-guide.test.js apps/web/test/codex-launcher.test.js`: **13/13** pass.
- `npm run test:web`: **447/447** Web unit tests and **3/3** built-output tests pass, plus successful Web build. Existing duplicate-translation-key warnings remain; no new key duplicates were added.
- `tests/browser/codex-launcher.mjs`: Chrome and WebKit each pass four ordinary-pointer Launcher flows (Mac/Windows × production/test), two terminal fallbacks, plus phone at 390px and tablet at 1024px using an existing computer Agent. Tests intercept backend traffic with synthetic accounts and replace only the native-navigation sink. They do not use force clicks or claim a native Safari session.
- Native Swift arm64 compilation explicitly targets macOS 13.5. The shared URI vectors pass **4 accepted / 18 rejected**, and account vectors pass **2 accepted / 5 rejected**, including bounded fake-network isolation checks. Native AppKit decodes the high-resolution icon; plist, executable deployment floors and ad-hoc signature pass.
- `--form-self-test` passes prefilled email, masked password, folded advanced settings, reachable connection controls and actual bold security/Hook typography. Its delayed synthetic claim confirms Stop prevents stale results from starting a connector.
- Full native builder at the verified head passes actual compressed DMG creation, `hdiutil verify`, read-only/no-Finder mount, exact four-entry root, manifest/file hashes, versions, icons and `codesign --verify --deep --strict`; it detaches before promoting the local candidate. No matching image remained mounted afterward.
- `coverage.py` in an ephemeral test-only environment reports **63%** unit-only coverage and **89%** combined unit + actual native build coverage for `build_dist.py` (272 statements, 29 uncovered). Native/build coverage is explicitly included, not presented as unit-only coverage. No global/project dependency was changed.
- `git diff --check` passes. No full repository archive/release gate was repeated in this delegated slice; the coordinating review owns that final gate.

Local candidate:

| File | SHA-256 |
| --- | --- |
| `GatherThreadLauncher-macOS-arm64.dmg` | `847066708388e8cdd84e3d8d8ca24e385c0cf243ae083138ec47c0e66a951dbd` |
| Compatible `GatherThreadLauncher-macOS-arm64.zip` | `97d6e588576f0fdabc9012dc5182ead5bd686982eb86fc0cf261aeb98364bdc5` |

The DMG's public `*.dmg.provenance.json` identifies exactly
`846d9b799a69d11f3891b4a62f1a6ee33ebdcb76`. A later evidence-only commit does not
change that manifest; a final merged-source release must be rebuilt and record its
own exact commit and hashes. Existing local test candidates were moved aside,
not overwritten or used as a released artifact.

## Remaining delivery boundaries

This Mac app is **ad-hoc signed, not Developer ID signed or Apple-notarized**.
The manual trusted-app exception follows [Apple's guidance](https://support.apple.com/en-us/102445).
Tests did not change Gatekeeper, remove quarantine, use sudo, register Launch
Services, install over Applications, or open a real authenticated Codex session.
Native Intel/Windows builds, downloaded-package Gatekeeper behavior, native Safari
handoff and live account/Codex/Hook operation are not claimed by this Mac build.

Only packaging/guidance and its short-lived CI artifact globs changed. No GitHub
Release, published tag, npm version, existing download, account data, formal/test
server or branch-protection setting was changed by this slice. The root delivery
must publish matching reviewed installers and server download links separately.

## PR90 security-review follow-up: no-clobber archive publication

The independent review identified that the DMG checksum/provenance writes could
follow existing symlinks and overwrite unrelated files. The maintainer also
approved fixing the identical inherited Mac ZIP/checksum pattern. The builder
must preserve existing artifacts and unrelated files, including collisions
arriving after an early check, and avoid leaving a partially published archive
when metadata creation/promotion fails. Windows packaging remains unchanged.

- RED `ecda819`: the Python target executed **23 tests**, with **13 intended
  failing subcases** for DMG pre-existing regular/symlink/dangling metadata,
  late collisions, failed sidecar writes/promotions and replaced-checksum rollback.
- GREEN `db8daa5`: the same target passed **23/23** after privately staging all
  three files, promoting metadata before the archive through exclusive hard
  links, and rolling back only links whose inode identity is still owned.
- RED `e32dd9e`: **27 tests** executed; **18 missing-implementation subcases**
  required the guarded ZIP creation path rather than the inherited direct
  overwrite path. Existing DMG tests continued to pass.
- GREEN `d7671e7`: **27/27** pass. Both formats share `publish_archive`; `main()`
  uses guarded ZIP creation and produces ZIP provenance too. Existing archives,
  checksums and provenance, including symlinks, are refused without overwriting.
  Failed writes/promotions remove only owned links; concurrent replacements
  survive. The final archive is promoted last as the completion marker.

Latest integrated main is `29321a01ebebe5cc50ef8e75b63ea6acd7813cf6` (PR89), with
the GitHub wizard, cache versions and both ADR0047/0048 retained. The implementation
head tested and built is **`d7671e79cfaa5792ab77db022a69a453449cd589`**.

| Guarantee | Check actually run | Result |
| --- | --- | --- |
| DMG/ZIP no-clobber and failure/late-collision/owned-rollback behavior | `python3 -m unittest discover -s prototypes/codex-launcher/macos -p 'test_*.py' -v` | 27/27 pass |
| Launcher handoff and bilingual guide preserved | Focused two-file Web target | 13/13 pass |
| Main integration and built Web remain correct | `npm run test:web` | 455/455 + 3/3 pass |
| Mac/Windows × formal/test ordinary clicks, terminal fallback and phone/tablet existing Agent | Chrome and WebKit Launcher browser matrices | Both pass |
| Real archive generation and DMG mounted-byte/signature validation, detach, final no-clobber promotion | Updated production `build_dist.py` | Pass |
| Native form, bold guidance and Stop fencing | Updated binary `--form-self-test` | Pass |

Coverage was rerun from fresh data after the shared ZIP/DMG helper changed:
**67% unit-only**, **90% combined unit + actual production native packaging**
for `build_dist.py` (296 statements, 29 uncovered). No previous line-number
coverage data was reused for that result. No further full Web or whole-repository
release gate was repeated after the packaging-only ZIP addition.

| Final local candidate | SHA-256 |
| --- | --- |
| `GatherThreadLauncher-macOS-arm64.dmg` | `6cf8aaba3c10cec1bd4e0f8a35646481b084d672ee2d60b9d71a6b643af85cdb` |
| `GatherThreadLauncher-macOS-arm64.zip` | `939efdb2678bb9ef74f5821d77e70ca44399b79a7ecfe086103f9354ee88f6cb` |

Both provenance sidecars identify `d7671e79cfaa5792ab77db022a69a453449cd589`.
Earlier local generated candidates were moved aside, not deleted or overwritten.
The signing/platform/live-account/publication limitations above remain unchanged.
