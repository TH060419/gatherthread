# GatherThread DeepSeek Harness Host bundle

This publish-ready, opt-in package binds the writable Sessions of one
GatherThread Project to distinct DeepSeek Harness Sessions. Installing the
package adds its identity-marked DSH profile layer; without that explicit
installation, GatherThread does not load in DSH or alter the GatherThread
server, Web app, Codex bridge, or Claude adapter.

The normal path is the published `@deepseek-ai/dsh` CLI, not a DSH source
checkout. The verified distribution is `@deepseek-ai/dsh@0.1.2-rc.1` with the
`web` profile and its public `sessionPersistence.list` recovery surface. The
earlier source-only PoC remains fixed to `dsh-v0.1.3-alpha.1`, commit
`d347e703908d0406b7a7ef80e3a0e594d86b2215`, and is only an advanced diagnostic
fallback. All version-sensitive Host calls remain inside `src/dsh-compat.ts`.
The package does not install a DSH runtime dependency.

## Plugin-first connection

After `@gatherthread/dsh-host` is published, the ordinary three-step path is:

```text
npx @deepseek-ai/dsh web
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add @gatherthread/dsh-host@0.1.0-beta.1
# In DSH: Settings -> GatherThread / 共序 -> Sign in and pair
```

Check the active CLI with `npx @deepseek-ai/dsh --version`. If it is not
`0.1.2-rc.1`, use `npx @deepseek-ai/dsh@0.1.2-rc.1 web`. DSH 0.1.2 does not
expose the root CLI version as a stable Host service, so the package does not
inspect npx cache paths or claim runtime-version introspection. The install
command pins the exact verified CLI, while every required Host/Client service is
validated structurally and fails closed before a request can be claimed.

`dsh plugin --profile web add` is DSH 0.1.2's official package installation
mechanism. It initializes a missing `web` profile on first use, invokes pnpm,
and appends only packages declaring `dsh.bundle`. DSH 0.1.2 has no verified
public plugin marketplace, marketplace index, or registration workflow. This
repository change prepares the package but does not publish it or modify a real
DSH profile.

Inside DSH, choose the future GatherThread public service or enter one custom
server origin. The same field covers an HTTPS LAN host, self-hosted deployment,
or Tailscale address; plain HTTP is accepted only on loopback. The plugin opens
an outbound HTTPS connection. A five-minute, single-use short code is confirmed
through the existing GatherThread browser session or invitation identity.
Public account registration is not assumed. The resulting long-lived device
grant is stored only by DSH's credential service and never appears in argv, a
URL, browser storage, logs, status RPC, or shared history. Once paired, the
plugin reconnects automatically whenever DSH starts.

Before removal, use **Disconnect** inside the DSH panel to clear the local
grant, then run:

```text
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web remove @gatherthread/dsh-host
```

The official command removes only this package dependency and profile layer;
other plugins remain untouched. The repository-level `npm run dsh:connect --
--help` source-checkout connector and the examples under `bundle/` remain
advanced/offline diagnostics, not the normal user path.

## Security and recovery

Only allowlisted public text/tool fields leave DSH. Reasoning blocks, raw model
streams, request headers, replay state, tool-private metadata, and credentials
are structurally unreachable from the upload mapper. Tool values are redacted
and bounded. The connector holds one active request, persists a private atomic
cursor/outbox, reuses DSH's official Session resume/repair path, and releases its
listeners, timer, HTTP abort signal, Agent handle, and write ownership on unload.

The `web` profile discovers `client/client.js` through DSH's official
`dsh.client` declaration. The settings Slot uses DSH's authenticated native RPC
carrier for pairing, configuration, and bounded status. The legacy status route
is read-only and available only when native RPC is absent. Both paths stay
behind DSH's same-origin Cookie/Host/Origin checks, and neither sends an
authorization header to the browser. A permanent 4xx clears displayed project
and Session details and stops polling; transient failures receive only three
bounded retries.

Host and browser lifecycles are intentionally separate. Disabling the Host
Loader entry immediately unregisters the status and RPC routes. Client bundle HMR uses
the official client-module SSE/fiber refresh path, which drains the previous
Slot and timer before registering one replacement. At this pinned DSH version,
adding or removing a package from the client graph is observed by a newly loaded
page; it is not treated as Host-entry disposal.

## Project binding

`bindingMode: project` discovers Sessions only through the existing
`GET /v1/projects/:project_id/sessions` and authenticates identity through
`GET /v1/me`. Viewer Sessions are never writable. A Solo Session is writable
only by its `owner_user_id`; Multi Sessions use the authoritative owner or
participant role. A 403 or 404 project response stops every binding, while a
transient discovery failure preserves the last safe set and retries with a
bounded exponential delay.

Every eligible Session has its own DSH Session id, HTTP abort scope, connector
state file, runtime identity, heartbeat, canonical cursor and durable outbox.
The project gate bounds the whole claim-to-settlement operation. This is
required because the current GatherThread alpha has no claim-abandon or claim
lease-expiry API. Removing or downgrading a Session cancels its queued permit
before it can claim a request. Existing single-Session configuration remains
valid when `bindingMode` is omitted; both modes resolve the real current actor
before applying Solo permissions.
