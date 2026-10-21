# PR107 DSH installation compatibility repair

## User journey and scope

A new user follows the Web DSH guide, installs the source-matched plugin and
starts the same verified runtime. An incompatible older runtime must refuse the
whole plugin layer before modifying Connection. The frozen published Beta 2
artifact remains independent. See [ADR-0058](../adr/0058-dsh-desktop-profile-and-version-gated-plugin-layer.md).

## RED / GREEN evidence

- `9b83753`: `node --test apps/web/test/dsh.test.js` executed 11 tests, 10 passed
  and 1 failed on the old runtime pin. The new install-contract target executed
  5 tests, 2 passed and 3 failed on the old pin, unpinned version check and missing
  optional peer guard.
- `1fbf3e7`: the executed DeepSeek Harness static guide test failed because the
  page still labelled `0.1.2-rc.1` rather than the current layer's `0.2.1-rc.2`.
- `94ba5e3`: Web/source focused checks passed 63/63. DSH compatibility, layer and
  client checks passed 59 tests with 1 existing pinned-runtime skip. The fix
  preserves the optional, non-installing peer and the separate frozen layer.
- An isolated probe executed exact AST-extracted upstream compatibility and
  profile-admission functions from DSH `0.1.7-rc.2` and `0.2.1-rc.2`, using real
  semver and an inert patch reader. The original manifest allowed the old runtime
  to read the incompatible layer; the repaired manifest skipped it before any
  patch read. Current-runtime admission and frozen Beta 2 metadata also passed.

## Final verification

- `npm run build`: passed, including TypeScript and distributable bundles.
- `npm run test:unit`: 1,240 passed, 6 existing skips, 0 failed.
- `npm run test:scripts`: 142 passed, 0 failed.
- `npm run test:web`: 727 source checks and 3 built-entry checks passed.
- `npm run release:verify-dsh`: Git-less tarball installation/import passed;
  verified that the optional peer did not install DSH.
- Release metadata, secret scan and whitespace checks passed.
- Eight isolated Chromium/WebKit scenarios covered both languages, actual
  dialog/copy functions and source-matched downloads or source-guide fallback.

These checks do not establish new full native DSH Web/provider acceptance,
physical Windows, native Safari, user-profile or server acceptance. No model was
called; no npm package, release tag or server deployment is part of this repair.
No whole-project coverage percentage is claimed by the focused RED/GREEN checks.
