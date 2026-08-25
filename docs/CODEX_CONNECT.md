# Connect a local Codex runtime

The built-in connector gives one GatherThread session its own persistent local Codex thread. It automatically catches up canonical history, runs only requests authored by the authenticated local user, and writes the final response and optional redacted tool events back with server-derived provenance.

## Prerequisites

- A local checkout of GatherThread with dependencies installed.
- Node.js 24 or newer.
- The Codex CLI installed and authenticated; verify with `codex login status`.
- Network access to the owner host, normally through the accepted Tailscale machine share.
- Your own GatherThread device access token. Do not use another collaborator's token.
- A local project directory that Codex may access.

## Start the connector

From the GatherThread checkout, run:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol
```

The connector requests the GatherThread device token through a hidden terminal prompt. If the account has more than one writable session, choose the session number. The token stays only in the connector process and is removed from the Codex child environment.

Keep the terminal open. The Web member panel refreshes runtime presence every five seconds. When it shows `codex · openai · <model>` as online, enter a message and select **Request my agent**.

## Synchronization behavior

- The first request creates a local Codex thread with all visible canonical events before the request.
- Later requests resume the same Codex thread and inject all newly committed events in sequence.
- Human chat and other collaborators' agent responses become context but do not trigger Codex.
- Only an `agent_request` authored by the same authenticated user and device runtime can be claimed.
- Output produced by the same Codex thread is not injected back into that thread a second time.
- If the connector was offline, the durable server cursor catches up before it handles a pending request.
- Codex compaction remains local. GatherThread keeps the canonical event log rather than sharing native compaction state.

## Safer modes

Use a read-only Codex sandbox:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --sandbox read-only
```

Share only the final answer, not structured tool calls or bounded tool results:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --no-share-tool-events
```

The default is `workspace-write`. Automatic privilege escalation is always disabled; the connector does not support `danger-full-access`.

## Reset the local Codex thread

If you intentionally want a new local Codex context for the same mapping, stop the connector and restart with:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --session SESSION_ID \
  --reset-codex-session
```

This deletes only the private local thread mapping file. It does not delete canonical GatherThread history or the native Codex transcript. The next request rebuilds context from the complete visible server history.

## Stop and reconnect

Press `Control-C` to stop. The runtime becomes offline after its heartbeat expires, normally within 30 seconds. Restart the same command to reuse the local Codex thread and durable GatherThread cursor.

One connector process registers one local runtime for one shared session. Run another process with a different `--session` when working in multiple sessions concurrently.

## Troubleshooting

- `Codex CLI could not be started`: install Codex or pass `--codex-command /absolute/path/to/codex`.
- `codex login status` fails: authenticate locally before connecting.
- `No writable GatherThread sessions`: the user is only a viewer or has not accepted a session invitation.
- Runtime remains offline: keep the connector terminal running, verify the Tailscale connection and HTTPS URL, then reload or wait up to five seconds for presence refresh.
- `Codex session state belongs to a different workspace/session`: use the matching command or explicitly reset the mapping.
- Hydration prompt exceeds the configured limit: start a new local mapping only after reviewing context policy, or raise the local prompt limit deliberately. The server history is not deleted.
- A process crash after claiming a request can leave that alpha request stuck. Submit a replacement request; automated claim lease recovery is not implemented yet.

## Security boundary

Shared history is untrusted collaboration data. The connector separates the server-verified local request from prior context, keeps the Codex sandbox active, disables automatic escalation, strips GatherThread credentials from the child environment, bounds output, removes raw reasoning/private prompts, and applies the common redactor before upload. These controls reduce but do not eliminate prompt-injection risk; review collaborators and use `read-only` for untrusted projects.

See [ADR-0005](adr/0005-managed-codex-thread-bridge.md) for the design decision.
