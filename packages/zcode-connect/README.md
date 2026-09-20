# @gatherthread/zcode-connect

Standalone local [GatherThread](https://github.com/TH060419/gatherthread) connector for the
[ZCode](https://github.com/TH060419/gatherthread) harness. One connector process binds one
GatherThread project to one local working directory, registers an execution runtime for every
writable session, and runs each claimed Web Agent request once in a headless ZCode child
process inside the workspace.

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

## ZCode CLI resolution

The connector resolves the ZCode CLI without a shell, in this order:

1. the explicit `--zcode-command <path>` option (a directory-qualified executable, or the
   desktop bundle's `glm/zcode.cjs` entry, which runs through Node);
2. `zcode` on `PATH`;
3. the documented desktop install location (`%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`
   on Windows, `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` on macOS).

Before connecting, the CLI is probed structurally (`--version`, `--help`) and the connector
refuses to run when required headless capabilities (`-p/--print`, `--output-format
stream-json`, `--resume`, `--input-format`) are not advertised. Nothing falls back silently.

## State and privacy

Per-session binding state lives under `~/.gatherthread/zcode/<binding>/` as versioned atomic
files with `0600` permissions. They contain native session ids and projection cursors — never
credentials. GatherThread credentials are stripped from the ZCode child environment, prior
shared events are treated as untrusted data, and hidden reasoning never leaves the child
process.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
