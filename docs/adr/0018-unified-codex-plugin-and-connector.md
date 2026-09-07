# ADR-0018: Pair a Codex plugin with the persistent npm connector

- Status: accepted
- Date: 2026-09-06

## Context

GatherThread needs two Codex surfaces. People working inside Codex need discoverable collaboration tools and reviewed lifecycle Hooks. Web **Request my agent** needs a continuously running local process that owns authentication, App Server lifecycle, request claims, per-session projections, reconnects, and reliable delivery. MCP alone cannot provide that runtime, and Finder-launched Codex Desktop cannot be assumed to inherit a terminal token.

Internal runtime operations also must not appear as ordinary model tools. Persisting a long-lived device token in a plugin manifest, URL, command, Codex configuration, or child environment would violate the existing credential boundary.

## Decision

Publish the connector as the self-contained, fixed-version `@gatherthread/codex-connect` npm package while retaining `npm run codex:connect` for repository development. The Web UI emits quoted, credential-free `npx` or `npx.cmd` commands pinned to the release version.

Ship the repo-local **共序 / GatherThread** Codex plugin with a fixed-version stdio MCP command whose packaged entry is hard-wired to the user profile and connector transport. It cannot inherit an environment request for internal runtime tools. Each running connector writes a leased, non-secret instance/endpoint/project registration and keeps its random per-run capability separate in the current user's state directory; POSIX ownership and modes are enforced. This lets an MCP process launched from a plugin cache collapse crash/restart overlap for the same endpoint to the newest lease, aggregate distinct active projects, and route by unique project/session ID. Duplicate IDs across distinct endpoints or an offline target fail closed. Discovery excludes expired registrations and removes only their lease files, never an endpoint or capability that a restarted instance may already own. The connector alone retains the GatherThread device token. A second connector probes the same workspace endpoint and refuses an active owner before changing Hook configuration; only an instance that successfully listened may remove that endpoint, and only a confirmed stale Unix socket is replaced.

The user MCP profile contains project, session, history, messaging, request, and sanitized status tools. Runtime registration, claim, completion, and snapshot upload are isolated in a separate internal profile. Direct environment-token HTTP MCP is developer preview only.

The plugin auto-discovers `hooks/hooks.json`; its manifest does not declare an unsupported Hook field. `UserPromptSubmit` and `Stop` call a bundled dependency-free script through `${PLUGIN_ROOT}`. The script resolves root or descendant Hook working directories against the connector's authoritative registry and forwards directly to the local Hook relay. The registry selects exactly one `project` or `plugin` source, and the relay validates that source envelope. This keeps an intentionally retained project Hook file inert after switching to plugin mode without deleting user configuration or allowing it to write the project-only offline spool. Users must explicitly enable, review, and trust Hooks. Hooks cannot wake idle Codex or start a new turn. The connector never edits `~/.codex/config.toml` or installs the plugin globally.

## Consequences

Basic Beta use means running the fixed connector and explicitly installing/reviewing the plugin. Full direct-Desktop synchronization additionally enables `--plugin-hooks` and requires that connector to remain online; the plugin Hook fails open without offline spooling. The existing `--install-hooks` project-file flow remains a mutually exclusive compatibility option and retains bounded offline spooling. Only that project mode drains its spool.

Safari, Chrome, and Edge only copy the command; the Web page does not launch local Codex. Future remote Streamable HTTP MCP requires a real account system and OAuth 2.1/PKCE. It remains complementary to the local runtime and cannot replace Web request claiming, per-session projection, reliable outbox, reconnect behavior, or App Server lifecycle.

On Windows the implementation requires the per-run capability in addition to the predictable named-pipe path and stores it below the user's GatherThread state directory. Cross-platform tests cover naming and capability enforcement, but a native two-account ACL smoke test remains a publication gate; path knowledge alone is never accepted as write authorization.
