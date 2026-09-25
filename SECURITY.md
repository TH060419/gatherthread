# Security Policy

## Supported versions

GatherThread is currently an invitation-only Alpha. Security fixes target the current hosted Alpha and the current `main` branch. Historical preview tags and release candidates do not receive separate security support. Because `main` may contain unreleased work, do not infer the hosted deployment version from the branch tip.

## Report a vulnerability privately

Do not open a public Issue for a vulnerability, exploit payload, production log, private transcript, credential, or other sensitive data. Email [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn) with the affected version or deployment, a minimal redacted reproduction, the expected impact, and a safe way to contact you. Never send live qualification codes, device tokens, passwords, private keys, or unredacted private source.

Alpha test-access requests use the separate public [Alpha access Issue template](https://github.com/TH060419/gatherthread/issues/new?template=test-access.yml). That workflow is not a vulnerability-reporting channel. Its email field is optional and public; applicants should use it only if they are comfortable publishing that address.

The repository threat model, trust boundaries, and incident expectations are documented in [`docs/SECURITY.md`](docs/SECURITY.md).
