# ADR-0001: Trust the self-hosted collaboration server with canonical plaintext

**Date**: 2026-08-25  
**Status**: accepted  
**Deciders**: Yuhan He

## Context

The first release needs durable ordered history, low-latency fan-out, authenticated replay after disconnection, session ACL enforcement, and recovery for collaborators who were offline. End-to-end encryption would move content policy, key distribution, member revocation, search, and recovery into every client before the core collaboration flow is proven.

## Decision

Use a trusted, self-hostable central collaboration server as the authoritative source for session ordering, access control, persistence, and replay. Canonical session content authorized for sharing is stored in a form readable by the deployment operator; clients must use HTTPS/WSS in non-local deployments, and access remains private by default under session ACLs.

The protocol may reserve versioned fields for future client-side encrypted payloads, but the first release must not claim end-to-end encryption or treat a future migration path as a current security control.

## Alternatives Considered

### Relay without server-side persistence

- **Pros**: The relay retains less sensitive content and is operationally simple.
- **Cons**: Offline users, late joiners, recovery, and complete-history consistency depend on peers retaining compatible local copies.
- **Why not**: It cannot provide the durable canonical history required by solo and multi sessions.

### Peer-to-peer replication or CRDT

- **Pros**: Removes a single content-hosting authority and can tolerate temporary server unavailability.
- **Cons**: Adds NAT traversal, membership, revocation, ordering, conflict resolution, and durable recovery complexity.
- **Why not**: It expands the first-release problem substantially without removing the need for identity and authorization infrastructure.

### Mandatory end-to-end encryption

- **Pros**: The server operator cannot read canonical event content.
- **Cons**: Requires client key management, secure member onboarding and revocation, encrypted search, multi-device recovery, and a different server-side redaction model.
- **Why not**: The product owner accepts a trusted self-hosted server for the first release and prioritizes reliable collaboration semantics.

## Consequences

### Positive

- The server can allocate authoritative sequence numbers and enforce ACLs transactionally.
- Reconnect replay, offline catch-up, backup, retention, and audit behavior have one durable source of truth.
- Different local harnesses can consume the same canonical history without sharing native session formats.

### Negative

- The deployment operator is inside the confidentiality boundary and can technically access stored shared content.
- A server or backup compromise can expose canonical conversations and uploaded context.
- Server-side storage and deletion policies become product security responsibilities.

### Risks

- Minimize exposure through early client-side redaction, no payload logging, least-privilege service accounts, restrictive database permissions, protected backups, revocable credentials, retention controls, and tested deletion.
- Clearly disclose the trust model so self-hosters and collaborators understand who can access plaintext.
- Treat optional end-to-end encryption as a future protocol evolution requiring its own ADR and threat-model revision.
