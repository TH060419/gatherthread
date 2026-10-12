# ADR-0047: Verified macOS DMG installation with explicit safety and Hook review

- Status: accepted for implementation; artifact publication remains separate.
- Date: 2026-10-12

## Context

The Launcher already uses independent email/password device authorization and
branded Windows/macOS resources under ADR-0044. Mac ZIP extraction does not make
the installation location clear. Running from an extracted or mounted temporary
directory also makes the optional plugin's private Node path unstable. The Web
and native instructions do not sufficiently emphasize the manual security and
Hook trust steps.

## Decision

Make a read-only compressed DMG the primary Mac artifact, retaining the ZIP for
compatibility. Its root contains the validated app, one `/Applications` symlink,
static bilingual installation instructions and a public provenance manifest.
Users drag to Applications and open from there before installing the optional
plugin or authorizing a device. No automatic installation, Launch Services
registration, application replacement or user-data access is added.

Disclose the existing ad-hoc signature and lack of Developer ID/notarization.
The Mac-only Web guide and native app emphasize **System Settings → Privacy &
Security → Open Anyway**, only after verifying the official download. Follow
[Apple's manual exception](https://support.apple.com/en-us/102445); never disable
Gatekeeper, remove quarantine, use sudo or dismiss damaged/malware warnings.
Emphasize **review, trust and allow GatherThread Hooks** separately, preserving
the explicit authority required to publish direct Codex turns.

Build from clean committed source, bundle only Git-reviewed plugin paths and
retain exact version matching and icon/runtime checks. Record public source
commit, architecture, Node/release versions, system minimum, signing limitation
and all app-file hashes. Stage privately, refuse unexpected/symlinked content,
verify the actual image, mount read-only without Finder/application launch,
compare installed bytes to the original manifest, verify signature, and detach
before promotion. Both DMG and compatible ZIP stage checksum/provenance privately
and promote each with exclusive no-clobber links, followed by the archive as the
completion marker. Existing archives or sidecars, including symlinks and late
collisions, are not replaced. On failure, remove only still-owned inode links and
preserve concurrently replaced files. Include checksum/provenance alongside both
formats in the existing short-lived CI artifacts.

## Compatibility and consequences

Email/password authorization, URI v1/v2, independent devices, exact production/
test origins, icons, Windows ZIP and Linux/self-hosted terminal fallback are
unchanged. Installed/downloaded older Launchers are not upgraded by a source
merge. Root release delivery must publish a separately reviewed matching DMG
and point the website at that version without replacing old tags/assets. A
deployment may provide `/downloads/launcher.json` with exactly `source_commit`
(40 lowercase hexadecimal characters) and `index_path`
(`/downloads/<source_commit>/index.html`). The existing download button discovers
this bounded, same-origin index when its dialog opens; absent or invalid metadata
retains the GitHub Releases fallback. A test deployment retains its admission
gate for downloads. The index and immutable version directory must list only
verified public installers, matching hashes and public provenance, never secrets.

Tests cover package completeness, source/version/hash checks, link/path/private
file refusal, failed-image nonpublication, detachment, bilingual bold guidance,
native AppKit form reachability and actual ordinary browser pointer paths.
Signing/notarization, Intel/Windows native builds and a real account/Codex smoke
remain separately evidenced gates; mount validation does not claim them.
