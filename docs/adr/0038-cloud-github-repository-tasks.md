# ADR-0038: Private cloud GitHub tasks with explicit pull-request publication

- Status: proposed / source preview
- Date: 2026-09-30

## Context

The limited hosted trial reads GT Cloud snapshots. The local GitHub adapter uses each user's device and does not provide a cloud development environment. A GitHub/npm workflow requires separately authorized source acquisition, dependency preparation, durable task source and a reviewed external write.

## Decision

Use expiring GitHub App user access tokens with PKCE and a single-use device-bound OAuth state. Server-side AES-256-GCM encrypts credentials and private source snapshots with distinct identity-bound associated data. Repository bindings and tasks belong to the authenticated user. An App's installation alone grants no GT participant access.

Keep GitHub transport outside the untrusted execution container. Acquire eligible source at a fixed Git commit via GitHub Git Data APIs. Run the existing OpenCode harness in an isolated, larger Node.js 24 container. Install exact public npm dependencies through a second Unix socket that permits only validated lockfile tarballs; npm integrity checks and disabled installation lifecycle scripts bound that path. General egress and GitHub/provider credentials remain absent.

Atomically reserve existing account/host quotas, append the canonical request and create the private task. The HTTP response is asynchronous. Save eligible result source for seven days; continuing reconstructs a fresh container from saved source and prepares dependencies again. Restart requires explicit retry and never replays a paid task automatically. This single-process design has bounded capacity, no waiting queue and no persisted shell/VM state.

Redact request content at the task boundary before canonical/private persistence and execution. Preserve exact original-input retries using a private identity-bound HMAC receipt, including conflicts between inputs whose redacted text is identical. Startup atomically scrubs retained earlier inputs before task access; the migration contract belongs to the operator guide. Current-day consumption follows the independent ledger in ADR-0037.

A human reviews before/after files and executable modes. PR publication requires the exact saved revision, current membership/device authorization, unchanged repository consent and base commit. Use a unique task branch, never force-push, and reconcile remote branch/PR state after uncertain responses. Do not update shared main, merge, run workflow edits or attach credentials to canonical history.

## Consequences

The first supported scope is public-registry npm Node.js/TypeScript projects. Full remote Git history, arbitrary environment provisioning, private package registries, long-lived VM state and distributed scheduling are outside this preview. Operational setup, limits and the real App/provider/container activation gate are owned by [HOSTED_GITHUB.md](../HOSTED_GITHUB.md).
