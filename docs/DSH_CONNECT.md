# Connect DeepSeek Harness

The GatherThread DSH plugin runs inside the DeepSeek Harness Web profile and connects outward to the selected GatherThread server. The browser never probes `localhost` or starts a local process.

> Alpha preview: `0.1.0-alpha.1` is prepared for private repository testing. The official GatherThread service entry is present but disabled. Use a local, LAN, self-hosted, or Tailscale server.

## Normal three-step setup

### 1. Install the plugin once

DSH's profile installer uses `pnpm`. If it is missing, install it first:

```bash
npm install --global pnpm@10
```

Then add the fixed GatherThread plugin to the DSH Web profile:

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add @gatherthread/dsh-host@0.1.0-alpha.1
```

### 2. Open DSH

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Keep DSH running. Open **Settings → GatherThread / 共序**.

### 3. Pair the current server

Paste the GatherThread server address, choose **Sign in and pair**, and compare the short code. Approve the same code in the GatherThread browser that is already signed in. The code is single-use and expires shortly.

## Private-repository test before npm publication

From a private source checkout:

```bash
npm install
npm run build
npm run release:pack-npm
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add ./release-artifacts/npm/gatherthread-dsh-host-0.1.0-alpha.1.tgz
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Do not add `--offline` unless the complete dependency metadata is already cached. DSH delegates profile package installation to `pnpm`; an incomplete offline mirror can fail before GatherThread is installed.

## What synchronizes

- One pairing connects every active project visible to that GatherThread identity and discovers later permissions.
- Writable GatherThread sessions appear as editable native DSH conversations.
- Canonical cloud history is projected into DSH; completed local turns upload once through a durable outbox.
- A new DSH conversation creates a creator-owned cloud Solo only after its first successful human/assistant turn.
- Empty conversations, failed turns, and viewer conversations remain local-only.
- Web Agent requests target the exact selected DSH device/provider/model and never silently fall back to Codex.

DSH uses its configured provider quota. `Insufficient Balance` or `QUOTA` means the selected DSH model account cannot run the turn; it is not a GatherThread synchronization failure.

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
