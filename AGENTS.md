# GatherThread repository instructions

These instructions apply to the entire repository. A nested `AGENTS.md` may add narrower rules for its directory, but it may not weaken the security, interface, review, or release requirements below.

## Authority and required reading

Follow the current user request and its explicit scope first. Treat the current code, schemas, tests, and configuration as implementation evidence; linked documentation is context and must be checked when it disagrees with the implementation.

Before making a substantial change, read:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for component boundaries and data flow.
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) for product behavior and permissions.
3. [`docs/SECURITY.md`](docs/SECURITY.md) for trust boundaries and threat controls.
4. [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md) for public and internal integration contracts.
5. [`CONTRIBUTING.md`](CONTRIBUTING.md) for development, review, and release procedure.
6. Only the task-relevant records in [`docs/adr/`](docs/adr/README.md).

Documentation roles are deliberately separated:

- Constitution: this file and `CONTRIBUTING.md`.
- Map: `docs/ARCHITECTURE.md` and `docs/INTERFACE_CONTRACTS.md`.
- Current release status: `CHANGELOG.md` and `docs/releases/`.
- Durable decisions: `docs/adr/`.

Do not duplicate a canonical rule into a new document. Link to its owner instead.

## Non-negotiable product invariants

- The server append-only canonical event log and per-session sequence are authoritative. WebSocket delivery is advisory; reconnects recover through authenticated replay.
- A project is the membership and invitation boundary. Every write must recheck the authenticated actor, device, project role, session mode, and resource ownership on the server.
- `solo` and `multi` permissions must remain consistent across Web, HTTP, MCP, Codex, and DeepSeek Harness surfaces.
- Human chat and Agent requests remain separate explicit actions. Never hide both intents behind one generic send path.
- Runtime selection is exact and fail-closed. Do not silently fall back to another harness, device, provider, model, or task.
- Local harness conversations are projections of canonical history. Cloud deletion must never delete local workspaces, files, Codex tasks, or DSH conversations.
- Local-to-cloud automatic upload is a per-conversation user choice. Manual recovery must remain explicit and idempotent. Cloud-to-local projection and realtime context injection are independent.
- A manual Codex history import creates and verifies a new local task. It does not overwrite or archive the previous task; the user archives the old task after checking the replacement. The retained task is `local_only` in the private Hook registry and must never re-enter local-task discovery or create cloud state.
- `canonical_history`, `harness_transcript`, and `provider_request` are distinct fidelity claims. Reconstructed or model-generated content must never be labelled as an exact provider request.
- Hidden reasoning, credentials, private instructions, unapproved local paths, and raw tool data are not shared by default.

## Working-tree and collaboration discipline

- Start with `git status --short` and inspect relevant diffs. Existing changes belong to the user or another contributor unless proven otherwise.
- Preserve parallel work. Do not reset, revert, checkout over, reformat, or replace an entire file merely to simplify your patch.
- For delegated or parallel work, assign non-overlapping file ownership and state it explicitly. Adapt to concurrent changes; never undo them.
- Do not delete another contributor's branch. Do not remove local indexing artifacts by destructive command; `.codegraph/`, `.serena/`, build output, and `node_modules` must remain uncommitted.
- Use small, reviewable patches. Separate unrelated behavior, refactors, formatting, and release metadata.
- Never put credentials, device tokens, invitation secrets, cookies, private transcripts, or sensitive logs in source, fixtures, screenshots, issues, or PR text.

## Change workflow

1. Establish the requested outcome, owned paths, and out-of-scope areas.
2. Trace the current behavior and its callers before editing. Use the repository CodeGraph index when available, then verify against source.
3. Identify affected contracts, permissions, persistence, migrations, compatibility, documentation, and tests.
4. Implement the smallest cohesive change without weakening existing fail-closed behavior.
5. Add or update tests at the contract boundary, including negative authorization and idempotency cases where applicable.
6. Update only the canonical documentation affected by the change. Add an ADR for a durable or hard-to-reverse architectural decision.
7. Run the narrowest useful checks during development and the appropriate delivery gate before handoff.
8. Report changed files, behavior, tests, assumptions, limitations, and any manual browser or platform checks still required.

## Area-specific requirements

### Protocol, server, and persistence

- Define wire shapes in `packages/protocol` with strict schemas before relying on them elsewhere.
- Keep `/v1` JSON fields in `snake_case`, preserve structured `{ data }` success and `{ error: { code, message, details? } }` failure envelopes, and use stable idempotency keys for retryable writes.
- Allocate canonical sequence numbers and enforce quotas inside the same SQLite write transaction as the accepted mutation.
- Schema changes need an explicit compatibility or migration plan plus database and service tests.

### Web UI

- Preserve element IDs, event handlers, API calls, loading/error states, keyboard behavior, focus visibility, accessible names, and bilingual strings when changing presentation.
- Keep Safari, Chrome, and Edge behavior aligned. Test Safari-specific form, `backdrop-filter`, sticky/overflow, and layout behavior when relevant.
- Maintain reduced-motion, reduced-transparency, high-contrast, responsive, and keyboard paths.
- User content is untrusted. Keep Markdown, links, code, tables, and math inside the existing sanitization and resource limits.

### Codex, MCP, and DSH integrations

- Keep device credentials inside the connector or DSH credential service. User-facing MCP and browser code must not receive them.
- Hooks require explicit installation and review. Never broaden Hook capture, native transcript access, or filesystem roots silently.
- Preserve durable cursors, outboxes, projected-event IDs, echo suppression, single-writer boundaries, and exact runtime routing.
- Treat upstream Codex App Server and DSH Host APIs as version-sensitive. Add compatibility tests and a safe refusal path for unsupported versions.

## Verification gates

Use Node.js 24 or newer. Common checks are:

```bash
npm run typecheck
npm run test:unit
npm run test:scripts
npm run test:web
npm run test:integration
npm run test:e2e
npm run release:verify
git diff --check
```

Select checks in proportion to risk. Any release candidate must pass `npm run release:verify` plus the real integration checks listed in its release notes. UI changes require a real browser check; cross-platform changes require the relevant Windows and Linux CI results.

## Review, merge, and release authority

- Agents may prepare commits or push a feature branch only when explicitly asked by their operator. Human contributors may push review branches. Neither may push directly to `main`.
- Every version update is proposed through a PR and reviewed by the project lead / designated release maintainer, currently GitHub user `@TH060419`.
- A contributor or Agent must not merge a release PR, create or move a release tag, publish an npm package, create a GitHub Release, or deploy a server unless the project lead explicitly authorizes that exact action after review.
- Prior approval for implementation or for an earlier release does not authorize a later merge, publication, tag, or deployment.
- Do not delete source branches after merge unless their owner or the project lead explicitly requests it.
- `.github/CODEOWNERS` requests the project lead's review. Repository administrators must also enable branch protection for `main`, require pull-request reviews, require Code Owner review, dismiss stale approvals, and require the quality workflow; the files in this repository cannot enforce those GitHub settings by themselves.
