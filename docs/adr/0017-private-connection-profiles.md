# ADR-0017: Support local, private LAN, and tailnet connection profiles

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: Yuhan He

## Context

The first public testers should be able to evaluate GatherThread without registering a cloud account. The original alpha documentation treated Tailscale Serve as the only supported network edge. That excludes same-device evaluation and trusted local networks, while manually editing production origins, bind addresses, and proxy settings is error-prone.

## Decision

Provide three explicit, reversible connection profiles:

1. Local mode uses loopback HTTP for same-device development and evaluation.
2. LAN mode keeps GatherThread on loopback and uses a dedicated Caddy listener for private HTTPS on one selected RFC1918, ULA, or `.home.arpa` address.
3. Tailnet mode keeps GatherThread on loopback and exposes it through Tailscale Serve on one exact `.ts.net` HTTPS origin.

Profile commands update only connection-related `.env` fields and preserve the database path, credential Pepper, quotas, identities, and history. LAN and tailnet modes require production HTTPS. The application itself never listens on a LAN or tailnet interface.

Router port forwarding, UPnP, Tailscale Funnel, certificate-warning bypasses, and arbitrary public tunnels are not supported by these profiles. GatherThread authentication and ACLs remain mandatory in every mode; the selected network boundary is defense in depth rather than application identity.

The hosted Alibaba Cloud ECS deployment is deliberately separate from these no-cloud-account profiles. It keeps the same loopback application boundary behind Caddy, disables public bootstrap and registration, and admits Beta users only through application invitations. See `../ALIYUN_ECS.md`.

## Consequences

### Positive

- A new tester can start locally without a cloud or VPN account.
- A trusted room can collaborate over private LAN HTTPS without Internet service.
- Remote testers retain the established private Tailscale option.
- Mode changes are repeatable and do not rotate credentials or discard history.

### Negative

- LAN clients must trust the deployment-specific local CA before opening the site.
- LAN availability and addressing depend on the router; the host should use a DHCP reservation or stable `.home.arpa` name.
- Local mode is intentionally same-device only and is not a production sharing path.

### Risks

- Bind the LAN proxy only to the selected private interface and allow only its HTTPS port through the host firewall.
- Never expose the loopback application port, enable router forwarding, or publish the private CA key.
- Treat installation of the LAN root certificate as a security-sensitive administrative action and verify its source and fingerprint out of band.
