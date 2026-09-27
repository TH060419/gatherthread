# Contributing to GatherThread

Thank you for improving GatherThread. The project is developed by people working with multiple local Agent harnesses, so changes must remain reviewable, attributable, secure, and compatible across the full stack.

Read [`AGENTS.md`](AGENTS.md) before starting. It is the repository constitution for both human-directed Agents and contributors. Architecture and API boundaries are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md).

## Governance

The project lead and designated release maintainer is currently `@TH060419`.

- All version updates are reviewed through a pull request before release.
- Only the project lead may give final approval to merge a release PR and authorize the corresponding Git tag, GitHub Release, npm publication, or server deployment.
- An approval to implement a feature is not release authorization. Each consequential release action requires explicit approval for that action.
- Contributors and Agents must not push directly to `main`, self-merge a release PR, publish packages, deploy, or delete another contributor's branch.
- Maintainers should enable GitHub branch protection for `main` with required pull-request review, required Code Owner review, dismissal of stale approvals, and the required quality workflow. `CODEOWNERS` requests review but does not enforce branch protection by itself.

## Development principles

1. **Canonical history first.** The committed server event log is the source of truth. Native Codex and DSH conversations are local projections and must remain recoverable.
2. **Authorization at the write boundary.** UI visibility is not security. The server rechecks identity, device, membership, ownership, session mode, runtime purpose, and quotas for each protected operation.
3. **Explicit user intent.** Keep chat, Agent execution, automatic upload, manual upload, history import, invitation, deletion, and Hook trust as distinct actions.
4. **Fail closed.** Ambiguous runtime selection, unsupported upstream versions, incomplete local turns, uncertain transcript provenance, and conflicting idempotency retries must stop safely.
5. **Local autonomy.** Never delete or rewrite local files, workspaces, tasks, or conversations as a side effect of a cloud mutation.
6. **Privacy by construction.** Share only allowlisted, redacted content. Never transmit hidden reasoning, credentials, private instructions, headers, raw tool payloads, or native identifiers by default.
7. **Durable recovery.** Cursors, outboxes, snapshot jobs, and projected-event IDs must survive retries and must advance only after the authoritative operation succeeds.
8. **Compatibility over convenience.** Preserve current clients when changing `/v1`, MCP, connector, DSH, persistent state, Hook, or UI contracts. Alpha status permits change, not silent breakage.
9. **Accessible and practical UI.** Preserve keyboard access, focus, reduced motion/transparency, high contrast, responsive layout, bilingual behavior, and Safari/Chromium parity.
10. **Evidence before claims.** A build is not proof of runtime behavior. Report the exact tests and real entry points exercised, plus anything that still needs manual validation.

## Starting work

1. Confirm the issue or requested outcome and define what is out of scope.
2. Inspect `git status --short`; preserve all existing and untracked work.
3. Read the architecture, product, security, and interface documents plus relevant ADRs.
4. Trace the current implementation and tests. Synchronize the local CodeGraph index if present, but never commit `.codegraph/`.
5. State ownership boundaries before parallel work. Use separate modules or files wherever possible.

Use a focused branch for review. Agent-created branch names should use the `codex/` prefix unless the maintainer requests another name. Do not rewrite shared history or force-push a branch owned by someone else.

## Making changes

- Prefer small patches over whole-file replacement.
- Keep domain validation in `packages/protocol` and authorization and persistence decisions in `apps/server`. Authenticated application presentation belongs in `apps/web`; the separate product-home presentation belongs in `site` and is published only through the `apps/web` build, as defined by ADR-0022.
- Reuse the harness-neutral `ProjectHarnessAdapter` and collaboration client boundaries instead of introducing a direct harness-specific server path.
- Keep retryable mutations idempotent and add mismatch tests.
- Preserve explicit error states; do not convert a failed or ambiguous operation into apparent success.
- Add negative tests for unauthorized roles, revoked devices, wrong runtime purpose, malformed input, and retry collisions when the change touches those paths.
- Do not mix feature behavior, broad refactoring, generated output, dependency upgrades, and release publication in one PR without a documented reason.

## Interface changes

Read [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md) before changing a route, schema, event, WebSocket message, MCP tool/resource, connector interface, DSH RPC, Hook payload, persistent sidecar, or stable DOM control.

An interface-changing PR must include:

- the current and proposed contract;
- affected producers, consumers, persisted data, and supported versions;
- backward-compatibility or migration behavior;
- authorization, privacy, quota, retry, and failure semantics;
- contract tests at both sides of the boundary;
- updated canonical documentation and an ADR when the decision is durable or hard to reverse.

Do not remove or reinterpret a field in place. During Alpha, an intentional breaking change still requires an explicit version or migration boundary and release-note disclosure.

## Verification

Use Node.js 24 or newer. During development, run the narrow tests closest to the change. Before requesting review, run the broadest applicable set:

```bash
npm run typecheck
npm run test:unit
npm run test:scripts
npm run test:web
npm run test:integration
git diff --check
```

Use `npm run test:e2e` for collaboration, authentication, replay, or connector changes. Use the real DSH and package checks when their surfaces change. A release candidate must satisfy `npm run release:verify` and the additional fixed-version checks named in its release notes.

UI changes also require a real browser review in Safari and at least one Chromium browser when the change touches layout, forms, scrolling, glass effects, Markdown/math, dialogs, or responsive behavior.

## Pull request requirements

Use the repository PR template and include:

- a concise outcome and scope;
- changed interfaces and compatibility impact, or an explicit “none”;
- security and privacy impact;
- exact verification commands and results;
- manual checks with browser, OS, Codex, or DSH versions where relevant;
- documentation and ADR changes;
- known limitations, follow-ups, and intentionally untouched areas.

Keep the PR branch available after review. The project lead decides when it may be merged and whether its source branch should be retained or deleted.

## Documentation ownership

- `AGENTS.md` and this guide own contribution rules.
- `docs/ARCHITECTURE.md` owns component structure and data flow.
- `docs/INTERFACE_CONTRACTS.md` owns integration boundaries and compatibility policy.
- `docs/PRODUCT_SPEC.md` owns product behavior and user-visible permissions.
- `docs/SECURITY.md` owns the trust model and security controls.
- `docs/OPERATIONS.md` owns deployment operations and incident procedure.
- `CHANGELOG.md` and `docs/releases/` own current release status.
- `docs/adr/` owns durable technical decisions.

Update the owner of a changed fact rather than copying the same fact into several files.

## Security reports

Do not place credentials, private transcripts, exploit payloads, production logs, or another person's personal data in a public issue or PR. Vulnerabilities and any personal data related to them must be reported privately to the project lead at [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn) with a minimal redacted reproduction. Alpha test-access applications are a separate public workflow: use the [dedicated Issue template](https://github.com/TH060419/gatherthread/issues/new?template=test-access.yml), whose optional fields may include the applicant's reason, discovery channel, and email. The Issue and every field are public; email is recommended only for applicants comfortable sharing it publicly for private code delivery. Applicants who prefer not to publish an email can, after approval, privately send the Issue link to the project lead. Never include qualification codes, device tokens, passwords, keys, or private source. See [`docs/SECURITY.md`](docs/SECURITY.md) for the repository threat model and incident expectations.
