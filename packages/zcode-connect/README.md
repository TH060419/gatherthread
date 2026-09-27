# @gatherthread/zcode-connect

Standalone local [GatherThread](https://github.com/TH060419/gatherthread) connector for the
[ZCode](https://github.com/TH060419/gatherthread) harness. One connector process binds one
GatherThread project to one local working directory, registers an execution runtime for every
writable session, and runs each claimed Web Agent request once in a bounded headless
`zcode app-server` child process inside the workspace, over the official ZCode Protocol.

This first slice covers the Web Agent execution loop only. Local-turn capture through reviewed
ZCode hooks, per-conversation upload preferences, visible-history import, and snapshots are
planned later phases; the connector never reads ZCode's private session store.

## Usage

```sh
npx --yes @gatherthread/zcode-connect@0.1.0-alpha.5 --url <GatherThread URL> [options]
```

Run `--help` for the full option list. The device access token is read from
`GATHERTHREAD_TOKEN` or a hidden terminal prompt; it stays in this process and is never passed
to ZCode, written to state, or logged.

The ZCode CLI on this device must be signed in with a default model selected (run `zcode login`
once). A headless execution on a signed-out CLI fails closed with an actionable message.

## Privacy defaults

Only the final answer of a headless turn reaches canonical history by default. Redacted tool
events are shared only after an explicit `--share-tool-events` opt-in, and even then only for
tools on the exact-name allowlist (`--share-tool-allowlist`, default `Read,Glob,Grep`) with
bounded argument and result values. Server-initiated permission, user-input, and provider-header
interactions from the headless child are declined: the connector never grants local tool
approval remotely.

## ZCode CLI resolution

The connector resolves the ZCode CLI without a shell, in this order:

1. the explicit `--zcode-command <path>` option (a directory-qualified executable, or the
   desktop bundle's `glm/zcode.cjs` entry, which runs through Node);
2. `zcode` on `PATH`;
3. the documented desktop install location (`%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`
   on Windows, `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` on macOS).

Before connecting, the CLI is probed structurally (`--version`, `--help`) and through a live
ZCode Protocol handshake; the connector refuses to run when the `app-server` subcommand or the
expected protocol version is missing. Nothing falls back silently.

## Execution, recovery, and revocation

Each claimed request gets one durable write-ahead journal entry before the headless child
starts: if the connector restarts or the transport fails after the native turn finished, the
recorded result replays exactly once instead of re-running tool side effects, and an
interrupted execution refuses to re-run at all. Project revocation, role downgrade, Ctrl-C, or
connector shutdown abort in-flight children and refuse later publication.

## State and privacy

Per-session binding state lives under `~/.gatherthread/zcode/<binding>/` as versioned atomic
files with `0600` permissions. They contain native session ids, projection cursors, and the
execution journal — never credentials. GatherThread credentials are stripped from the ZCode
child environment, prior shared events are treated as untrusted data, and hidden reasoning
never leaves the child process.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
