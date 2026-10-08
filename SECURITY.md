# Security Policy

## Supported versions

GatherThread Beta 1 (`0.1.0-beta.1`) uses verified-email accounts and password sign-in, not invitation-only account activation. This release targets npm and the isolated test service; production promotion is separate. Security fixes target the current supported deployment and the current `main` branch. Historical preview tags and release candidates do not receive separate security support. Source, package publication and server deployment are separate verification gates. Registration opens only after the operator's provider, security and rollout checks in [OPERATIONS](docs/OPERATIONS.md#public-beta-registration-preflight) pass.

## Report a vulnerability privately

Do not open a public Issue for a vulnerability, exploit payload, production log, private transcript, credential, or other sensitive data. Email [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn) with the affected version or deployment, a minimal redacted reproduction, the expected impact, and a safe way to contact you. Never send email verification codes, device credentials, passwords, private keys, test-environment admission codes or unredacted private source.

Normal account registration happens on the sign-in page, never through an Issue or privately issued qualification code. Project invitations grant project membership after sign-in. The separate test service may require an operator-issued admission code; that grants test-environment access only. Public [Issues](https://github.com/TH060419/gatherthread/issues) remain available for non-sensitive product feedback, not vulnerability reports.

The repository threat model, trust boundaries, and incident expectations are documented in [`docs/SECURITY.md`](docs/SECURITY.md).
