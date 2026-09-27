# GatherThread documentation

This index separates current product contracts, operator guidance, connection guides, and point-in-time release records. See the [release record index](releases/README.md) for current hosted-source, Git-tag, npm-package, and GitHub Release status. Later `main` changes may still be undeployed; do not infer live state from the branch tip alone.

## Product and system contracts

- [Product specification](PRODUCT_SPEC.md): user-visible behavior, roles, and permissions.
- [Architecture](ARCHITECTURE.md): components, persistence, and data flow.
- [Interface contracts](INTERFACE_CONTRACTS.md): protocol and integration compatibility boundaries.
- [Security model](SECURITY.md): trust model, threats, authentication, redaction, and incident expectations.
- [Architecture decisions](adr/README.md): accepted ADRs and their status.

## Connect local Agent harnesses

- [Connect Codex](CODEX_CONNECT.md) · [中文](CODEX_CONNECT.zh-CN.md)
- [Connect DeepSeek Harness](DSH_CONNECT.md) · [中文](DSH_CONNECT.zh-CN.md)
- [Git-backed code collaboration](CODE_SYNC.md)

## Run and operate GatherThread

- [Connection modes](CONNECTION_MODES.md) · [中文](CONNECTION_MODES.zh-CN.md)
- [Single-owner self-hosting](SELF_HOSTING.md)
- [Operations](OPERATIONS.md)
- [Alibaba Cloud ECS profile](ALIYUN_ECS.md) · [中文](ALIYUN_ECS.zh-CN.md)
- [Private Tailscale testing](ONLINE_TESTING_TAILSCALE.zh-CN.md)
- [Legacy Oracle Cloud alternative](ORACLE_CLOUD.md) · [中文](ORACLE_CLOUD.zh-CN.md)

## Release and contribution records

- [Changelog](../CHANGELOG.md): Alpha 7 changes and subsequent version history.
- [Release record index](releases/README.md): which version records have tags or GitHub Releases.
- [Contributing guide](../CONTRIBUTING.md): review, verification, and ownership rules.
- [Repository security policy](../SECURITY.md): private reporting entry point shown by GitHub.
- [References](REFERENCES.md), [design references](DESIGN_REFERENCES.md), and [design QA](design-qa.md).
