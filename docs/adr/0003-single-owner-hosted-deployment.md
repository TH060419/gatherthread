# ADR-0003: Use one owner-hosted authoritative server per deployment

**Date**: 2026-08-25
**Status**: accepted
**Deciders**: Yuhan He

## Context

The first release must operate without a paid VPS or managed database while preserving one durable ordering authority for realtime events and replay. Collaborators have their own local harnesses, but concurrent writable server replicas would introduce split-brain ordering, membership conflicts, and recovery complexity.

## Decision

Run exactly one active authoritative GatherThread server for a deployment on a participating user's computer. That server may hold multiple solo and multi sessions. It binds only to loopback, stores its SQLite database locally, and is exposed to known collaborators over a private Tailscale tailnet using Tailscale Serve HTTPS. Router port forwarding and Tailscale Funnel are not supported deployment defaults.

Each collaborator runs their own local bridge and harness. Any user may create a separate deployment on their own machine, but one shared deployment has only one writable host. The zero-cost Tailscale Personal route is intended for small, non-commercial groups within its current plan limits; deployments outside those terms must choose another network or paid plan.

## Alternatives Considered

### Paid VPS or managed platform

- **Pros**: Better uptime and no dependence on a participant's computer.
- **Cons**: Creates recurring cost and may not provide durable free SQLite storage or WebSocket support.
- **Why not**: The product owner requires a no-cost first release.

### Multi-primary peer hosting

- **Pros**: No single participant must remain online.
- **Cons**: Requires consensus or conflict-free replication for events, membership, claims, invitations, deletion, and credential state.
- **Why not**: It undermines the simple authoritative log and substantially expands the first release.

### Public tunnel or direct router port forwarding

- **Pros**: Collaborators do not need a private-network client.
- **Cons**: Exposes authentication endpoints to Internet scanning and adds denial-of-service, TLS, firewall, and router risks.
- **Why not**: A private tailnet provides a smaller network attack surface at zero service cost for the intended group size.

## Consequences

### Positive

- No VPS, managed database, public IP, router port mapping, or owned domain is required.
- SQLite remains local to one process while collaborators receive private HTTPS access.
- A single server continues to provide ordered commits, ACL enforcement, replay, and backup.

### Negative

- The deployment is unavailable while the host sleeps, shuts down, loses connectivity, or stops the process.
- The host operator is responsible for updates, disk protection, backup, and incident response.
- Active automatic failover and federation are outside the first release.

### Risks

- Keep the service bound to loopback and allow only named collaborators to the Serve endpoint with least-privilege Tailscale grants.
- Retain application authentication and ACL checks even inside the tailnet; network membership is defense in depth, not application identity.
- Use online SQLite backups, verify restores, and provide a documented single-host migration procedure before relying on the deployment for irreplaceable history.
