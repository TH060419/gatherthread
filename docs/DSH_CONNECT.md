# Connect DeepSeek Harness

The GatherThread DSH plugin runs inside the DeepSeek Harness Web profile and connects outward to the selected GatherThread server. The browser never probes `localhost` or starts a local process.

The current source checkout also adds optional **project code** upload/download/recovery in DSH settings. It requires a locally built plugin and separate per-project consent; automatic code upload defaults off. See [Project code collaboration](CODE_SYNC.md). Existing alpha.6 npm artifacts do not contain this unreleased feature.

> Alpha preview: `0.1.0-alpha.6` is prepared for private repository testing. The official GatherThread service entry is present but disabled. Use a local, LAN, self-hosted, or Tailscale server.

## Normal four-step setup

### 1. Install the plugin once

DSH's profile installer uses `pnpm`. If it is missing, install it first:

```bash
npm install --global pnpm@10
```

Then add the fixed GatherThread plugin to the DSH Web profile:

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add @gatherthread/dsh-host@0.1.0-alpha.6
```

### 2. Open DSH

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Keep DSH running. Open **Settings → GatherThread / 共序**.

### 3. Pair the current server

Paste the GatherThread server address, choose **Sign in and pair**, and compare the short code. Approve the same code in the GatherThread browser that is already signed in. The code is single-use and expires shortly.

### 4. Select a DSH provider and model

Approving the short code completes pairing, but pairing alone registers nothing. Back in **Settings → GatherThread / 共序**, choose a provider and a model, then confirm to connect every project this identity can access. No GatherThread runtime exists for this device until that step, so the GatherThread Web workspace cannot find this DSH yet, and the panel still reports a stopped connection. For a compatible DeepSeek route, this selection is the connection default and the plugin also advertises the exact models and reasoning efforts reported by DSH. The GatherThread work page may then choose one of those profiles for an individual Agent request. That temporary request choice does not overwrite the model selected in DSH. Nothing falls back to Codex.

## Private-repository test before npm publication

From a private source checkout:

```bash
npm install
npm run build
npm run release:pack-npm
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add ./release-artifacts/npm/gatherthread-dsh-host-0.1.0-alpha.6.tgz
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Do not add `--offline` unless the complete dependency metadata is already cached. DSH delegates profile package installation to `pnpm`; an incomplete offline mirror can fail before GatherThread is installed.

## What synchronizes

- One pairing connects every active project visible to that GatherThread identity and discovers later permissions.
- Writable GatherThread sessions appear as editable native DSH conversations. Newly created ones start with `<session> · 共序 · MULTI|SOLO` in the DSH session list; adopted and previously connected conversations keep their local titles, including user edits.
- Canonical cloud history is projected into DSH; completed local turns upload once through a durable outbox.
- In **Settings → GatherThread / 共序**, every connected conversation has its own **Automatic upload** switch and **Manual upload** action. Turning automation off keeps subsequent local turns private until the user uploads them; manual upload does not change the switch.
- A new DSH conversation creates a creator-owned cloud Solo only after its first successful human/assistant turn.
- Empty conversations, failed turns, and viewer conversations remain local-only.
- Web Agent requests target the exact selected DSH device and one provider/model/reasoning profile that runtime advertised. Unsupported values are not offered and fail closed if submitted. Legacy and non-advertising routes keep the connection's fixed model; no request silently falls back to Codex.

DSH uses its configured provider quota. `Insufficient Balance` or `QUOTA` means the selected DSH model account cannot run the turn; it is not a GatherThread synchronization failure.

The unreleased source preview also lets a session writer select completed public messages in GatherThread Web and ask their **own connected DSH Agent** to make an attributed shared summary. Originals and earlier versions remain available. The per-user project setting defaults to summarized context for **future Web-triggered Agent requests**, or can use original text. A summary-aware Web turn uses a GatherThread-owned DSH execution Session with the same workspace and validated native tool preset; ordinary sessions without summaries retain the existing native path. The original DSH conversation, its local turns, and native compaction are not rewritten. Remote Agent replies appear there as clearly labelled plugin relay quotations, not as fabricated DSH-local model turns; this preserves the native Agent's next turn number. The canonical GatherThread event still retains its original actor and type. If the compatible native surface or preset inheritance cannot be verified, the summarized turn fails visibly instead of silently injecting the originals. Summaries are lossy and prompt instructions are not a security sandbox for workspace tools or files. See [ADR-0027](adr/0027-shared-manual-history-summaries.md).

## Context and long histories (unreleased source fix)

The plugin preserves redacted public cloud messages in the native conversation, rather than cutting each incoming message to 64 KiB. This does not enlarge the server's event limits or remove outgoing upload/redaction limits. Cursor advancement still waits for durable native append/flush.

During normal turns, DSH manages its own context and automatic compaction using the selected provider/model metadata and native compaction configuration. GatherThread does not replace those settings, including for non-DeepSeek providers. The browser's Codex fallback budget does not apply to DSH. Keep native automatic compaction enabled if desired; a model name or an advertised window is not a guarantee that the provider accepts that much input.

DSH `0.1.2-rc.1` has a first-import limitation: its automatic pre-step compaction requires a prior native request header. A newly imported history can already exceed the model window before that first native request. Its manual compactor also submits a bounded model request; it cannot reliably rescue an arbitrarily oversized prefix. If the provider rejects the context, the original cloud/native records remain available. Use DSH's native compact control where the input fits, or explicitly select a suitable configured model and retry. GatherThread does not silently choose another model, prune the cloud log, or run a paid summary during background polling. Fully automatic staged compaction for this case remains a compatibility follow-up, not a supported guarantee. [ADR-0026](adr/0026-native-first-context-management.md) records the boundary.

## Troubleshooting

| Symptom | Action |
|---|---|
| `pnpm not found on PATH` | Install `pnpm@10`, close the old terminal, and retry. |
| `Failed to resolve dependency tree` with `--offline` | Retry without `--offline`, or repair the configured pnpm registry/cache. |
| Blank or unreadable plugin button | Rebuild/reinstall the tarball, restart DSH, and hard-refresh the Web page. |
| Pairing says operation not completed | Confirm the server address, current GatherThread browser login, and the selected DSH provider/model. |
| Runtime is online but a turn fails with `QUOTA` | Configure a funded/available provider model in DSH and retry. |
| A synchronized conversation is read-only | Refresh the pairing after confirming the GatherThread role and session permission. Viewer and another creator's Solo are intentionally read-only. |

## Security boundary

The plugin initiates the network connection. Pairing uses a short-lived, single-use code bound to the current server and DSH device. The long-lived device credential stays in DSH's local credential store and never enters a command, URL, browser storage, log, or shared history.

Only allowlisted assistant output and redacted public tool projections can leave DSH. Hidden reasoning, private streams, headers, and native metadata are not uploaded.

## Release checks

```bash
npm run release:verify-dsh
npm run test:dsh-npm-plugin:real
npm run release:pack-npm
npm run release:dry-run-npm
```

These commands verify a Git-less package install/import, exercise the real DSH profile installer, create the candidate tarballs in ignored `release-artifacts/npm/`, and check npm's publish path with the non-default `alpha` dist-tag.
