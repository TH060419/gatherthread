# ADR-0065: A native DSH workspace over canonical collaboration history

**Date**: 2026-10-29
**Status**: proposed / local prototype
**Deciders**: project lead

## Context

GatherThread already connects DSH to project sessions, but its settings page is
not a collaboration workspace. Users need to read other participants' messages,
chat, inspect shared context and explicitly request their local DSH without
switching to the GatherThread website. The requested prototype targets the latest
published DSH preview, `0.2.2-alpha.2`, independently of an operator's installed app.

## Decision

Use the official DSH `main` keyed Slot and `sidebar.panellist` contribution in the
existing `@gatherthread/dsh-host` bundle. Keep pairing and provider configuration
in the existing settings Slot. Do not embed the authenticated GT website or copy
its browser session into DSH.

The Client uses a single bounded native RPC action envelope; the Host reuses its
private grant and canonical HTTP APIs. The strict input/output schemas live in
`packages/protocol/src/dsh-workspace.ts`. The UI receives only explicitly mapped
visible text, attribution, member labels and the current local execution target.
Existing connector projection, context revision checks and execution ownership
remain authoritative. The context preview is not a provider-request capture.

See the [native boundary contract](../INTERFACE_CONTRACTS.md#dsh-workspace-rpc-prototype)
for scope fencing, replay, permissions and limits. Project administration,
sharing configuration and Agent Team editing still open the existing website.
The panel reuses DSH's public Markdown, code highlighting and image-preview
components, with bounded canonical-message expansion and the reviewed Web
avatar catalog. Relative file links use the existing read-only project-file
capability; binary attachment upload is not added. Existing settings remain
available.

The workspace reuses Web's canonical session creation/renaming and ordinary
request pause/resume semantics. Per-request model and reasoning choices are
limited to the exact native runtime catalog. Quotes carry canonical IDs rather
than copying historical text into a new prompt. Progress, members and context
are expandable; pairing and other configuration remain in native settings.

## Alternatives considered

- Embed GT Web: duplicates browser authorization and cannot establish safe native
  DSH identity by itself; desktop navigation and theme integration are weaker.
- Build a separate collaboration backend inside DSH: creates competing message
  histories and permission systems. Rejected in favor of the existing server.
- Share the DSH local transcript wholesale: violates explicit upload choice and
  private-context boundaries. Only canonical visible history enters this panel.

## Verification and consequences

The V4 native storage boundary requires a protected first system surface node
and producer-owned message sources. Fresh GT-owned projections reserve an empty
native system node in a closed prelude, then rebuild the Agent so its turn
counter observes that prelude. Native creation metadata is retained. Context
replacement preserves this node; the DSH loop owns the real system prompt.
Relay records use `gatherthread` as their source in V4 and recognize the upstream
`plugin:gatherthread` migration identity as well as the older plugin wrapper.
Existing malformed or ambiguous native conversations are refused and retained,
not rewritten or deleted. This also applies to isolated context execution and
deletion-triggered projections. An opt-in regression runs the published V4
format relationship validator and Session restoration APIs on these paths.

Verified using the published `@deepseek-ai/dsh@0.2.2-alpha.2` packages in an isolated
profile, including official tarball installation, native Slot/RPC loading,
canonical multiplayer replay and a local mock provider invocation containing the
other participant's shared text, a process restart and a second successful model
request using the recovered history. Chat-only sending, context preview and
draft preservation across panel navigation are checked in that actual DSH shell.
Safari also verifies the native project/session selectors, Chinese chat input,
canonical receipt and shared-context preview. This is not a real paid-model
evaluation or a verified latest Electron binary; packaged desktop frame checks
remain pending. The prototype respects DSH frame clearance/theme contracts.

No server migration, new credential storage or publication is required. Drafts
and pending retry identities survive panel navigation in memory, but not a DSH
page reload, plugin unload or process exit. A missing receipt is indeterminate;
retrying reuses the same identity and does not silently create a second request.

The file follow-up uses the existing cloud file-workspace API and optional native
DSH file navigation. Local change previews use bounded, in-memory project
snapshots because upstream excludes `origin: subagent` from native change
tracking; changing that origin would weaken the execution isolation model.
Partial scans do not infer deletion, failed captures invalidate the old baseline,
and owner shutdown invalidates pending captures. This is a review aid, not a
transactional file audit or cross-harness lock. Product scope and limits remain
owned by the linked product/security/interface documents.

File follow-up validation covers the packaged latest DSH Client/Host in Chromium
and Safari: local text, path references, automatic pre-execution capture and
before/after comparison, exact native-files navigation, cloud save/history and
project Git controls. A second writer advanced the fixture branch while Safari
held an edit: the save was refused and the unsaved Chinese text remained visible;
cancelling close preserved it. Unit tests include scope revocation, links/private
paths, incomplete scans, aborted capture and immutable save retries. Real HTTP
Git recovery/multi-device integration uses local disposable repositories, not a
production GitHub push. Electron distribution validation remains separate.
