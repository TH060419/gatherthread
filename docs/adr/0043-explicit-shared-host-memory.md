# ADR-0043: Explicit shared-host memory

- Status: proposed / implementation review
- Date: 2026-10-11
- Scope: administrator configuration for both hosted runners; no wire or database migration

## Context

A small test host's nested application, rootless-daemon and task memory limits can constrain an Agent even when the host has unused RAM or swap. The project lead explicitly accepts contention with an otherwise idle production service and wants on-demand sharing instead of a small fixed test allowance. This is a capacity policy change, not proof that memory caused the observed missing model response.

## Decision

Add the opt-in `shared-host` memory policy documented in [Hosted Agent](../HOSTED_AGENT.md#shared-host-memory). Omission keeps the existing `limited` defaults and all their validations. Shared-host requires host concurrency one and an explicit single-CPU cpuset, and removes only Docker task RAM/swap caps. It refuses an absent cpuset rather than launching through the unchecked CFS entrypoint. The guarded cpuset entrypoint verifies actual unbounded RAM, high-water and swap controls only when the exact trusted policy marker is supplied. Absent or malformed controllers still fail closed; ordinary limited jobs still refuse unbounded values.

The operator must review and update the real root-owned application/manager/daemon/container ancestry and persistent/runtime controls together. CPU affinity, PID/time bounds, filesystem/network/credential isolation and task authorization do not change. Existing source/image/helper provenance must be honest; no flag-stripping Docker wrapper, unchecked replacement guard or automatic policy fallback is permitted.

## Consequences and verification

No service reserves memory in advance. A task may consume the host's available memory and swap, including memory needed by other services; slowdowns and global OOM are accepted risks of this opt-in, not guarantees of capacity. Single-task concurrency reduces contention but is not memory containment. The host can revert its configuration and image through the existing coordinated operator rollback; do not lower caps beneath a running task.

Verify both runners' arguments and current authorization/cleanup paths, strict policy parsing, unchanged limited-mode behavior, and the real guarded image under shared-host controls. A real exact-provider request must produce completed public text before claiming the live Cloud Agent is repaired. This record partially supersedes only the mandatory finite-memory/zero-swap portions of ADR-0040 when the new policy is explicitly selected.
