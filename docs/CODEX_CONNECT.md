# Connect Codex

GatherThread keeps one selected cloud project connected to Codex Desktop through a small local connector. The browser never launches Codex and never places a credential in a copied command.

> Alpha preview: `0.1.0-alpha.1` is prepared for private repository testing. The npm package and fixed Git ref commands work after they are published. Until then, use the source-checkout path below.

## Normal three-step setup

### 1. Install the Codex plugin once

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.1 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

Restart Codex Desktop. Open Settings, review the **共序 / GatherThread** MCP server and Hooks, then enable Hooks.

### 2. Connect one GatherThread project

Open that project in GatherThread, select **Connect Codex**, and copy the command shown for your operating system. It has this shape:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-alpha.1 \
  --url 'https://your-gatherthread-server.example' \
  --project 'PROJECT_ID' \
  --create-workspace \
  --plugin-hooks
```

The connector asks for your device token in a hidden terminal prompt. Keep the terminal open. Run one connector per GatherThread project you want online.

### 3. Confirm the connection

Codex Desktop opens the verified local workspace. In GatherThread, the member panel changes to **Agent online**. New and existing writable sessions are discovered automatically.

## Private-repository test before npm publication

A collaborator with repository access can test the complete local experience now:

```bash
git clone https://github.com/TH060419/gatherthread.git
cd gatherthread
npm install
npm run build
npm run codex:connect -- \
  --url 'http://127.0.0.1:8787' \
  --project 'PROJECT_ID' \
  --create-workspace \
  --plugin-hooks
```

Use the server URL and project ID displayed by the local Web app. The fixed plugin commands above become available when the private `v0.1.0-alpha.1` ref exists. Without the reviewed plugin Hooks, Web Agent requests still work, but direct Codex Desktop turns are not uploaded.

## What synchronizes

- Editable GatherThread sessions receive independent Codex tasks.
- Web **Request my Agent** runs in an isolated background projection and publishes its final response to canonical history.
- Reviewed Hooks upload completed direct Desktop turns and deliver new shared context.
- New local tasks create a creator-owned cloud Solo only after the first completed turn. Empty tasks and viewer tasks stay local.
- Cloud deletion never deletes local files or Codex tasks.

Canonical history is always injected for model context. Some Codex Desktop builds may persist imported history without repainting every imported event as a visible bubble immediately; reopening the task can refresh the visible transcript.

## Project and workspace rules

- `--create-workspace` creates or reuses `~/GatherThread Projects/<project name>`.
- A credential-free marker binds that directory to exactly one GatherThread server and project. If the connector reports that the workspace belongs to another binding, use the matching project or choose a new workspace; do not delete the marker to bypass the check.
- To use an existing source directory, replace `--create-workspace` with `--workspace '/absolute/path'`.
- Project and session titles may change without breaking identity; IDs remain authoritative.

## Troubleshooting

| Symptom | Action |
|---|---|
| `Local workspace is already bound...` | Stop the connector and choose a new workspace, or reconnect the matching original project/server. |
| `thread/start` or `thread/resume request timed out` | Leave the connector running. It retries and prints `recovered` when Codex App Server responds. Restart Codex Desktop if retries continue. |
| Project appears but no task is visible | Send the first Web Agent request or create a completed direct task turn, then reopen the Codex project. Empty sessions do not create synthetic turns. |
| Web says Codex is offline | Confirm the terminal is still running and the connector URL is the same origin shown in the browser. |
| Hooks do not upload direct turns | Confirm `--plugin-hooks` is present, the plugin is installed, Hooks are enabled, and the task belongs to the managed workspace. |

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
