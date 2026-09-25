# Connect Codex

GatherThread keeps one selected cloud project connected to Codex Desktop through a small local connector. The browser never launches Codex and never places a credential in a copied command.

For optional **project code** upload/download/recovery, use the `0.1.0-alpha.7` connector with the separate `--code-sync` opt-in; follow [Project code collaboration](CODE_SYNC.md). This is independent of conversation/history synchronization.

> Invitation-only Alpha: the hosted server is at `https://gatherthread.cn`. The fixed `v0.1.0-alpha.7` Git ref exists; the `npx` command additionally requires the matching npm package to be published. If it is unavailable, use the source-checkout path below. Test access is requested only through a [GitHub Issue](https://github.com/TH060419/gatherthread/issues/new?template=test-access.yml); never post a token in an Issue.

## Normal three-step setup

### 1. Install the Codex plugin once

First confirm that the Codex CLI is available:

```bash
codex --version
```

If Terminal reports `codex: command not found`, install or update the official CLI, then reopen Terminal:

```bash
npm install -g @openai/codex
```

Run `codex plugin --help` to confirm that this Codex build supports plugins, then install GatherThread:

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.7 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

Restart Codex Desktop. Open Settings, review the **共序 / GatherThread** MCP server and Hooks, then enable Hooks.

### 2. Connect one GatherThread project

Open that project in GatherThread, select **Connect Codex**, and copy the command shown for your operating system. It has this shape:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-alpha.7 \
  --url 'https://your-gatherthread-server.example' \
  --project 'PROJECT_ID' \
  --create-workspace \
  --plugin-hooks
```

The connector asks for your device token in a hidden terminal prompt. Keep the terminal open. Run one connector per GatherThread project you want online.

### 3. Confirm the connection

Codex Desktop opens the verified local workspace. In GatherThread, the member panel changes to **Agent online**. New and existing writable sessions are discovered automatically.

## Source-checkout fallback when the npm package is unavailable

A collaborator with repository access can test the complete local experience with the current source:

```bash
git clone https://github.com/TH060419/gatherthread.git
cd gatherthread
npm install
npm run build
npm run codex:connect -- \
  --url 'http://127.0.0.1:18787' \
  --project 'PROJECT_ID' \
  --create-workspace \
  --plugin-hooks
```

Use the server URL and project ID displayed by the Web app; for the hosted Alpha, the URL is `https://gatherthread.cn`. The fixed `v0.1.0-alpha.7` plugin ref is available, while the connector package still requires npm publication for `npx`. Without the reviewed plugin Hooks, Web Agent requests still work, but direct Codex Desktop turns are not uploaded.

## What synchronizes

- Editable GatherThread sessions receive independent Codex tasks.
- Web **Request my Agent** runs in an isolated background projection and publishes its final response to canonical history.
- Reviewed Hooks upload completed direct Desktop turns and deliver new shared context.
- Each local conversation defaults to automatic upload. The GatherThread workspace shows the selected Codex device, an **Auto-upload local turns to cloud** switch, pending cloud-upload status, and **Upload local turns to cloud now** for the open session. The reviewed Codex plugin exposes the same controls by session name.
- With the connector still running in reviewed `--plugin-hooks` mode, manual upload scans the Desktop task itself, so it can recover an eligible completed turn even when the trusted Hook did not run, missed it, or failed. It never re-enables automation implicitly.
- New local tasks create a creator-owned cloud Solo only after the first completed turn. Empty tasks and viewer tasks stay local.
- Cloud deletion never deletes local files or Codex tasks.

Canonical history is always injected for model context. The connector separately imports a verified native history snapshot so the first connected task has readable Desktop bubbles. Settings has two choices: `first-connect` imports once when each session is first established locally (default), while `never` disables automatic visible-history import. Use **Import Codex history** in the workspace or `collaboration_import_codex_history` in the reviewed plugin at any time. Every manual import creates a new local Codex task, retains public text within a separate snapshot resource limit and uses native Codex compaction when needed, verifies the result, then switches the durable binding and Hook allowlist. It does not overwrite, delete, or archive the previous task; review and archive that task yourself. If you continue the previous task before archiving it, the work stays local and cannot create another GatherThread task or cloud session. Realtime delta injection remains active independently, including when automatic visible-history import is disabled.

In `0.1.0-alpha.7`, a session writer can select completed public messages in the GatherThread Web timeline and ask their **own connected Codex runtime** to make a shared, attributed summary. The original messages and earlier versions remain readable. The per-user project setting defaults to using the summarized view for **future Web-triggered Agent requests**; switch it to original text when exact detail matters. This changes only the connector-owned background execution context, never an existing visible Desktop task, its bubbles, or its local files. Native Codex compaction and local-turn upload consent remain separate. An Agent summary is lossy and should be checked against its cited originals; it is not a guarantee that the Agent cannot access workspace tools or files. See [ADR-0027](adr/0027-shared-manual-history-summaries.md).

## Project and workspace rules

- `--create-workspace` creates or reuses `~/GatherThread Projects/<project name>`.
- A credential-free marker binds that directory to exactly one GatherThread server and project. If the connector reports that the workspace belongs to another binding, use the matching project or choose a new workspace; do not delete the marker to bypass the check.
- To use an existing source directory, replace `--create-workspace` with `--workspace '/absolute/path'`.
- Project and session titles may change without breaking identity; IDs remain authoritative.

## Native context management

Normally leave Codex's own automatic compaction enabled. GatherThread does not change Codex's model-window or auto-compaction configuration. A reported native window takes precedence over the connector's fallback estimate; current occupancy uses the last request and newly injected content, not lifetime token spending. The old fixed 4K replay budget is removed. `--context-window-tokens` remains compatible as a fallback when the native window is unknown, not as a way to increase model capacity.

Visible imports no longer replace older messages with a static "compact" notice. Within a separate serialized snapshot resource limit, the connector passes the public history to Codex and requires genuine native compaction for a large candidate before binding it. Native compaction may consume provider quota, fail, or summarize details imperfectly. A required-compaction failure leaves the old binding and realtime path intact. Snapshots beyond the resource limit are rejected explicitly; the cloud log is not shortened. This is not an unlimited-history or lossless-model-memory guarantee.

If native compaction reports no fresh occupancy, or remains above the safe budget, background projection can pause durably instead of retrying paid compaction or rebuilding on every poll. It resumes only after Codex reports a new usable token observation. Reconnecting with the same report or changing the background model does not bypass the pause. This preview has no manual reset control for that background state: if the native task can no longer report usage, preserve its state and report the issue; an explicitly authorized recovery workflow remains follow-up work. The separate Desktop realtime/Hook path is not disabled by this guard. A manual Desktop history import is not a reset of the independent background projection.

Existing first-connect snapshots are not silently replaced by this update. If an older snapshot omitted public text, use **Import Codex history** to create a fresh local snapshot from the unchanged cloud history; review and archive the previous local task yourself. New context-accounting and recovery fields remain optional when reading existing version-3 state. An older connector may reject the new `unknown_after_compaction` state on downgrade: preserve the state files and use the compatible connector instead of deleting the binding or replay journal. Older versions also lack the new recovery guard and must not resume a state with `contextRecovery`.

RPC frames and the 7 KiB Codex Desktop Hook capsule remain bounded. The capsule continues from an acknowledged checkpoint; its size is not the model's total context window. DSH has its own native policy and does not use this browser/CLI fallback. See [ADR-0026](adr/0026-native-first-context-management.md).

## Troubleshooting

| Symptom | Action |
|---|---|
| `Local workspace is already bound...` | Stop the connector and choose a new workspace, or reconnect the matching original project/server. |
| `thread/start` or `thread/resume request timed out` | Leave the connector running. It retries and prints `recovered` when Codex App Server responds. Restart Codex Desktop if retries continue. |
| Project appears but no task is visible | Keep the connector running and use **Import Codex history**. Empty sessions receive a local-only visibility marker; it is never uploaded to shared history. |
| Web says Codex is offline | Confirm the terminal is still running and the connector URL is the same origin shown in the browser. |
| Hooks do not upload direct turns | Confirm `--plugin-hooks` is present, the plugin is installed, Hooks are enabled, and the task belongs to the managed workspace. Then ask the plugin to manually upload that session's completed local turns. |

## Security boundary

The copied command contains only the server origin, project ID, model choice, and non-secret flags. The device token stays in the connector process and is removed from Codex child environments. The plugin MCP talks to the running connector over a private local endpoint with a short-lived capability. Duplicate or ambiguous project routes fail closed.

The connector never enables unrestricted sandboxing, edits global Codex settings silently, or exposes a local service to the network. Stop it with `Control-C`.

## Release checks

```bash
npm run release:verify-codex
npm run release:pack-npm
npm run release:dry-run-npm
```

The first command rebuilds, packs, installs, and smoke-tests the standalone connector from a Git-less temporary directory. The second creates the candidate tarball under the ignored `release-artifacts/npm/` directory; the third checks both packages through npm's publish path with the `alpha` dist-tag without publishing them.
