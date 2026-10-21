# Connect DeepSeek Harness

The GatherThread DSH plugin runs inside the DeepSeek Harness Web or Desktop profile and connects outward to the selected GatherThread server. The browser never probes `localhost` or starts a local process.

The plugin provides optional **project code** upload/download/recovery in DSH settings, with separate per-project consent. GT Cloud automatic code upload defaults off; a newly authorized GitHub binding defaults on and can be switched off. See [Project code collaboration](CODE_SYNC.md).

Sign in with email and password before approving pairing. In the plugin, select the official service at `https://gatherthread.cn` or enter your self-hosted server address. **Connect DeepSeek Harness → Download packages for this server** opens its source-pinned index. Install that page's DSH plugin TGZ; if it is unavailable, use the [source-checkout fallback](#source-checkout-fallback).

## Supported DSH releases

The current plugin build installs into DSH `0.2.1-rc.2`, the release bundled with the DeepSeek Harness desktop application, and serves both its `desktop` profile and the `npx` `web` profile. The desktop application manages its own profile, so install there with its bundled CLI:

```bash
dsh plugin --profile desktop add "/absolute/path/to/LOCAL_DSH_PLUGIN.tgz"
```

For `0.1.7-rc.2`, use the immutable published `0.1.0-beta.2` artifact. Its frozen layer is retained in source as `cordis.patch.dsh-0.1.yml` for reference, not as an alternative installation for the current build. The two layers cannot be merged: `0.2.x` renamed Connection's trust service from `webRuntime` to `webStartup`, and injecting both fails startup. The current build declares both `engines.dsh` and an optional `@deepseek-ai/dsh` peer with range `>=0.2.1-rc.2 <0.3.0`. Newer DSH checks the engine; older `0.1.7-rc.2` checks the peer before composing bundle patches, safely refusing this incompatible build without installing another runtime. This source change does not replace the published Beta 2 npm artifact. See [ADR-0058](adr/0058-dsh-desktop-profile-and-version-gated-plugin-layer.md).

## Normal four-step setup

### 1. Install the plugin once

DSH's profile installer uses `pnpm`. If it is missing, install it first:

```bash
npm install --global pnpm@10
```

Download the DSH plugin TGZ from that index and add it to the DSH Web profile. Replace the placeholder below with the downloaded file's full path:

```bash
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "/absolute/path/to/LOCAL_DSH_PLUGIN.tgz"
```

On Windows, use a quoted full path such as `C:/Users/you/Downloads/your-plugin.tgz`. The registry's `@gatherthread/dsh-host@0.1.0-beta.1` is an older release, not this source-pinned build; it does not provide the current safe message-deletion handling.

### 2. Open DSH

```bash
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

Keep DSH running. Open **Settings → GatherThread / 共序**.

To check the same pinned CLI, use `npx @deepseek-ai/dsh@0.2.1-rc.2 --version`.

### 3. Pair the current server

Paste the selected GatherThread server address (`https://test.gatherthread.cn` for the independent test environment; `https://gatherthread.cn` for the independently deployed production service), choose **Sign in and pair**, and compare the short code. Approve it in a browser already signed in to that same environment. Test requires its own admitted email account, device authorization and workspace; do not reuse production pairing or credentials. The code is single-use and expires shortly.

### 4. Select a DSH provider and model

Approving the short code completes pairing, but pairing alone registers nothing. Back in **Settings → GatherThread / 共序**, choose a provider and a model, then confirm to connect every project this identity can access. No GatherThread runtime exists for this device until that step, so the GatherThread Web workspace cannot find this DSH yet, and the panel still reports a stopped connection. For a compatible DeepSeek route, this selection is the connection default and the plugin also advertises the exact models and reasoning efforts reported by DSH. The GatherThread work page may then choose one of those profiles for an individual Agent request. That temporary request choice does not overwrite the model selected in DSH. Nothing falls back to Codex.

## Source-checkout fallback

From a source checkout matching the commit printed on the server's download page (or confirmed by its administrator):

```bash
git checkout SOURCE_COMMIT_FROM_DOWNLOADS_PAGE
npm ci
npm run build
npm run release:pack-npm
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ./release-artifacts/npm/gatherthread-dsh-host-0.1.0-beta.3.tgz
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

Do not add `--offline` unless the complete dependency metadata is already cached. DSH delegates profile package installation to `pnpm`; an incomplete offline mirror can fail before GatherThread is installed.

## What synchronizes

- One pairing connects every active project visible to that GatherThread identity and discovers later permissions.
- Writable GatherThread sessions appear as editable native DSH conversations. Newly created ones start with `<session> · 共序 · MULTI|SOLO` in the DSH session list; adopted and previously connected conversations keep their local titles, including user edits.
- Canonical cloud history is projected into DSH; completed local turns upload once through a durable outbox.
- In **Settings → GatherThread / 共序**, every connected conversation has its own **Automatic upload** switch and **Manual upload** action. Turning automation off keeps subsequent local turns private until the user uploads them; manual upload does not change the switch.
- A new DSH conversation creates a creator-owned cloud Solo only after its first successful human/assistant turn.
- Empty conversations, failed turns, and viewer conversations remain local-only.
- Web Agent requests target the exact selected DSH device and one provider/model/reasoning profile that runtime advertised. Unsupported values are not offered and fail closed if submitted. The advertised catalog is re-read periodically, so a model DSH publishes after you connect appears without reconnecting. Legacy and non-advertising routes keep the connection's fixed model; no request silently falls back to Codex.
- The advertised catalog is DSH's own model metadata. A model that DSH does not list — for example one your DSH version has not been released with, or one your provider configuration omits — cannot be selected here, because GatherThread does not invent models a harness cannot run. Update DSH, or add the model to your DSH provider catalog, and it appears after the next refresh. See [ADR-0032](adr/0032-harness-advertised-model-catalogs.md).

DSH uses its configured provider quota. `Insufficient Balance` or `QUOTA` means the selected DSH model account cannot run the turn; it is not a GatherThread synchronization failure.

`0.1.0-beta.2` also lets a session writer select completed public messages in GatherThread Web and ask their **own connected DSH Agent** to make an attributed shared summary. Originals and earlier versions remain available. The per-user project setting defaults to summarized context for **future Web-triggered Agent requests**, or can use original text. A summary-aware Web turn uses a GatherThread-owned DSH execution Session with the same workspace and validated native tool preset; ordinary sessions without summaries retain the existing native path. The original DSH conversation, its local turns, and native compaction are not rewritten. Remote Agent replies appear there as clearly labelled plugin relay quotations, not as fabricated DSH-local model turns; this preserves the native Agent's next turn number. The canonical GatherThread event still retains its original actor and type. If the compatible native surface or preset inheritance cannot be verified, the summarized turn fails visibly instead of silently injecting the originals. Summaries are lossy and prompt instructions are not a security sandbox for workspace tools or files. See [ADR-0027](adr/0027-shared-manual-history-summaries.md).

## Context and long histories

The plugin preserves redacted public cloud messages in the native conversation, rather than cutting each incoming message to 64 KiB. This does not enlarge the server's event limits or remove outgoing upload/redaction limits. Cursor advancement still waits for durable native append/flush.

During normal turns, DSH manages its own context and automatic compaction using the selected provider/model metadata and native compaction configuration. GatherThread does not replace those settings, including for non-DeepSeek providers. The browser's Codex fallback budget does not apply to DSH. Keep native automatic compaction enabled if desired; a model name or an advertised window is not a guarantee that the provider accepts that much input.

Observed at the previously pinned DSH `0.1.2-rc.1` and not re-verified at the current pin: DSH has a first-import limitation where its automatic pre-step compaction requires a prior native request header. A newly imported history can already exceed the model window before that first native request. Its manual compactor also submits a bounded model request; it cannot reliably rescue an arbitrarily oversized prefix. If the provider rejects the context, the original cloud/native records remain available. Use DSH's native compact control where the input fits, or explicitly select a suitable configured model and retry. GatherThread does not silently choose another model, prune the cloud log, or run a paid summary during background polling. Fully automatic staged compaction for this case remains a compatibility follow-up, not a supported guarantee. [ADR-0026](adr/0026-native-first-context-management.md) records the boundary.

## Troubleshooting

| Symptom | Action |
|---|---|
| `pnpm not found on PATH` | Install `pnpm@10`, close the old terminal, and retry. |
| `Failed to resolve dependency tree` with `--offline` | Retry without `--offline`, or repair the configured pnpm registry/cache. |
| `user patch-layer watching requires the Cordis HMR service` after launch | See the startup-mode workaround below; this is an upstream profile hot-reload failure, not a pairing failure. |
| Blank or unreadable plugin button | Rebuild/reinstall the tarball, restart DSH, and hard-refresh the Web page. |
| Pairing says operation not completed | Confirm the server address, current GatherThread browser login, and the selected DSH provider/model. |
| Runtime is online but a turn fails with `QUOTA` | Configure a funded/available provider model in DSH and retry. |
| A synchronized conversation is read-only | Refresh the pairing after confirming the GatherThread role and session permission. Viewer and another creator's Solo are intentionally read-only. |

### Upstream profile hot-reload failure

A fresh DSH install can resolve newer transitive packages that fail its default `live` configuration reload. That was observed at the previously pinned `0.1.2-rc.1`. The earlier `0.1.7-rc.2` pin passed the isolated native/browser gate with default live reload. The new `0.2.1-rc.2` layer has compatibility-preflight and contract checks; the complete native Web/browser flow has not yet been re-run at this pin. The workaround below remains only for that specific error if it reappears.

Only if the exact HMR error above occurs: stop DSH, back up `<DSH_HOME>/profiles/web/package.json` (normally `~/.dsh/profiles/web/package.json`), and change the existing `dsh.profile.patchReload` value to `"startup"`. Preserve every other field, dependency and bundle; do not replace the whole manifest. Then start DSH again with the command in step 2. Configuration-layer changes now require restarting DSH; GatherThread history/realtime synchronization is not disabled. Do not clear credentials or install arbitrary upstream versions to bypass this error.

## Security boundary

The plugin initiates the network connection. Pairing uses a short-lived, single-use code bound to the current server and DSH device. The long-lived device credential stays in DSH's local credential store and never enters a command, URL, browser storage, log, or shared history.

Only allowlisted output and redacted public tool fields can leave DSH. During an exact GatherThread-claimed request, a matching plugin can stream the native interface's exposed answer, thinking, tool activity and plans. Unrelated local work, hidden/private streams, headers and native identifiers are excluded; native automatic completed-turn capture is unchanged. Older installed plugins need a matching update for the new live fields. See [ADR-0045](adr/0045-streamed-public-agent-output.md).

## Release checks

```bash
npm run release:verify-dsh
npm run test:dsh-npm-plugin:real
npm run release:pack-npm
npm run release:dry-run-npm
```

These commands verify a Git-less package install/import, exercise the real DSH profile installer, create the candidate tarballs in ignored `release-artifacts/npm/`, and check npm's publish path with the non-default `beta` dist-tag.

For the known upstream HMR failure, the optional test-only `GATHERTHREAD_DSH_PATCH_RELOAD_STARTUP_FIXTURE=1` switch uses startup mode **only in the script-created temporary DSH home**, and records `defaultLiveReloadVerified=false`. It never edits the operator's DSH profile and is not a replacement for the manual troubleshooting steps above. Native tests use a fake model; they do not prove a real provider has quota or supports the selected model.
