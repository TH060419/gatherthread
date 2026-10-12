# Author-message erasure: review evidence

Status: integration and independent review pending. This note separates source/fixture results from native GUI, live providers and deployment.

## Scope and authority

Users with current write access can delete their own chat, Agent request or answer. There is no owner override for another person's message. Canonical order and envelope metadata remain; live content is scrubbed and a content-revision control is appended. See [ADR-0050](../adr/0050-author-message-erasure-and-context-revisions.md), [contracts](../INTERFACE_CONTRACTS.md) and [security](../SECURITY.md) for the canonical rules.

Future GatherThread-derived model context excludes erased content and invalidated summaries/generated work. Already submitted provider requests, independent manual copies, local files/tasks and already published remote copies are not recalled or deleted. Conservative generated-work invalidation is deliberate; independent human messages survive.

## RED/GREEN checkpoints

- Server/protocol/MCP: foundational deletion, two-handle/reopen/migration/authorization, frozen replay/import, old connector refusal, dispatch/progress/final/checkpoint and private GitHub-cache fences were added incrementally. Additional RED checkpoints include `cb617de` (checkpoint race), `0338081` (private task cache/slot/next-input cases), `4c14dac` (live-file remnants and busy WAL cleanup), `a54daca` (pre-dispatch slot release) and `3ff5e0b` (stopped invalid private task storage). GREEN `b68b57e` passes 798 relevant tests: 797 pass, one existing skip, zero failures.
- Native adapters: RED `cda7ab5` exposes three compacted/summary-free context paths; RED `aefdb78` exposes replacement registry and teardown races. GREEN `5d49e75` passes 387 focused tests: 381 pass, six existing skips. Isolated public DSH 0.1.2-rc.1 Session/Agent/file-tool checks pass 17/17 without a model or real account. Codex uses a controlled stdio App Server fixture, not a real Desktop GUI or model.
- Web: RED `394366c`, `8058de3`, `aecf799`, `466226a` cover generated history, update guidance, late private-cache responses and focus. GREEN `4ac70a1` and browser-strengthening `379c875` pass 470 Web tests plus three build-output checks. Documentation RED checkpoints `9efaadd`, `e34824b`, `e847689` become GREEN `6773e29`: 475 Web tests plus three output checks pass.

## Real interaction fixtures

Six ordinary click/tap matrices cover Chrome and WebKit desktop, phone and tablet in both languages. The fixture uses actual loopback HTTP, HttpOnly browser sessions, SQLite and WebSockets; no forced click or Enter-only bypass substitutes for pointer hit testing.

Covered: author versus another member/viewer/foreign Solo, confirmation and cancel, uncertain 503 retry with the same key and one mutation, late HTTP/WebSocket responses not resurrecting content, nested summary/quote/mention invalidation, current draft/reading anchor/focus, request-linked outputs and reply-only deletion. WebKit results do not claim native Safari GUI coverage. Fixture identifiers and content are synthetic.

## Storage and delivery boundary

Live payload/private caches are scrubbed; secure-delete and durable nonwaiting WAL cleanup do not certify instant erasure of offline storage. Blocked cleanup remains pending and requires operator action before the retention deadline. Existing 14-day backup/unreachable-cloud-object and 30-day identifying-log policies remain explicit. No online VACUUM or unrelated filesystem cleanup is added.

Integrate current main before delivery so personal API configuration revisions and history content revisions both remain effective. Repeat the relevant server/native/Web and real interaction fixtures on the integrated fixed head, run the canonical release gate and exact-head cross-platform/hosted CI, and obtain separate Standards/security and Spec reviews. None of the pre-integration counts above is a claim that those final gates or server installation have completed.

Deployment must use the same reviewed source for server/Web, hosted image and connector/DSH installers. After new application startup/migration is attempted, never automatically restore an old application or database that could reuse erased native context. Preserve current data and keys for forward repair. Final delivery stops at the operator's single authorized sudo apply step.
