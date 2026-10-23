# ADR-0058: Gate the DSH plugin layer by release and serve desktop from the same package

**Date**: 2026-10-18
**Status**: proposed / local implementation
**Deciders**: project lead

## Context

The DeepSeek Harness desktop application bundles a different DSH release than the
`web` profile the plugin was verified against (`0.1.7-rc.2`). The desktop app
reports DSH `0.2.1-rc.2` and manages its own `desktop` profile.

The plugin's profile layer (`cordis.patch.yml`) overrides the `connection` row so
that `connection.rpc.handle()` can register the GatherThread channel: Connection
evaluates `owner.webServer` on its **providing** fiber, and `0.1.5-rc.x` had moved
`webServer` into a nested scope. A row patch replaces `inject` wholesale, so the
layer also has to restate the release's own trust service, and that is what
breaks across releases:

| Release | Connection row injects | Trust source for `trustedHosts` |
|---|---|---|
| `0.1.7-rc.2` | `[webRuntime]` | `ctx.webRuntime.trustedHosts` |
| `0.2.1-rc.2` | `[webStartup]` | `ctx.webStartup.trustedHosts` |

`webRuntime` in `0.2.x` is provided only **after** the server binds, while
Connection waits for its injected services before it can register the `/api`
transport. Injecting both names deadlocks the required Connection row, which the
profile audit reports as `connection: webRuntime` and fails startup — the exact
failure observed when `0.1.0-beta.2` was installed into the desktop app.
Injecting only `webRuntime` fails the same way on `0.2.x`; injecting only
`webStartup` breaks `0.1.7-rc.2`, whose row interpolates `ctx.webRuntime`.

Cordis has no optional injection in either release, and patch entries cannot be
conditional: `applyEntryPatches` merges a patch's remaining keys (including
`disabled`) into the target row, so a "skip this patch" switch does not exist. A
single static layer therefore cannot serve both releases.

## Decision

1. `cordis.patch.yml` targets DSH `0.2.1-rc.2` and names `webStartup`. It serves
   both the Web and Desktop profiles, because `0.2.x` composes the same
   `dsh-web-app` rows for both and the profile name only changes desktop-only
   rows. Installation is unchanged: `dsh plugin --profile <desktop|web> add <tgz>`.
2. The `0.1.7-rc.2` layer is frozen in `cordis.patch.dsh-0.1.yml` and ships as a
   source reference. The immutable published `0.1.0-beta.2` artifact remains the
   supported build for that release. The current manifest always selects
   `cordis.patch.yml`; it never substitutes the frozen layer automatically or
   mixes the two. This change does not publish a replacement Beta 2 npm artifact.
3. `package.json` declares `engines.dsh` and an optional `@deepseek-ai/dsh` peer,
   both `>=0.2.1-rc.2 <0.3.0`. Newer DSH enforces the engine check. DSH
   `0.1.7-rc.2` ignores that field but enforces the peer before composing the
   whole bundle's patches, safely refusing an incompatible bundle before its
   Connection override applies. The peer is optional so npm does not install a
   DSH runtime as a plugin dependency. Web install, start, repair and version
   commands all pin `0.2.1-rc.2`, matching the default layer.
4. The Host reports the running profile name from `profileContext` and lists every
   verified `{version, profile}` pair in `status/get`, so the settings panel can
   stop claiming one release while running another. The client accepts a reported
   pair only when it appears in that list, and still accepts the legacy
   `0.1.7-rc.2`/`web` scalar pair from older Host builds.

## Alternatives Considered

### One layer that injects both `webStartup` and `webRuntime`

- **Pros**: A single artifact for every release.
- **Cons**: Deadlocks the required Connection row on `0.2.x`, where `webRuntime`
  appears only after the bind.
- **Why not**: Reproduced as a startup failure; no static ordering fixes it.

### Drop the `connection` row override and register exact Fetch routes instead

- **Pros**: No release-specific inject list.
- **Cons**: Replaces the RPC channel with per-endpoint routes and rewrites the
  browser transport, its envelope handling and its tests.
- **Why not**: Wider behavioural change than the defect, and it moves the plugin
  off the transport DSH documents for Host plugins.

### Detect the release at runtime and write the row from the plugin

- **Pros**: One artifact, no build-time choice.
- **Cons**: The plugin would mutate Loader entries owned by the profile, after
  Connection has already resolved its inject list.
- **Why not**: It races the Loader and would make startup depend on patch order.

## Consequences

### Positive

- The plugin activates on the current desktop application and on `0.2.x` Web.
- A mismatched release fails closed with DSH's own diagnostic instead of a
  startup crash.
- The compatibility block reports what is actually running.

### Negative

- Two layers must be maintained for as long as `0.1.7-rc.2` is supported, and a
  release that renames the trust service again needs a new layer.

### Risks

- Future DSH releases may change the loader preflight or trust service again;
  the declared range is not proof of compatibility with every future release.
- The scalar `version`/`profile` fields name the active verified target, not
  always the npm Web profile; `targets` lists the build's verified pairs. This
  is a compatibility claim, not runtime-version introspection.
