# GatherThread documentation

Start with the product story and illustrated workflow, then choose the setup or developer reference you need. Version history and operational checks have their own sections below.

## Use GatherThread

- [Product introduction](../README.md) · [中文](../README.zh-CN.md): work together, across devices, with your Agents.
- [Illustrated product guide](PRODUCT_GUIDE.md) · [中文](PRODUCT_GUIDE.zh-CN.md): a real-interface walkthrough from shared discussion to reviewed files.
- [Disposable example](https://gatherthread.cn/app/example.html?locale=en&topic=browse) · [中文](https://gatherthread.cn/app/example.html?locale=zh-CN&topic=browse): practice without model quota or changes to real projects.
- [Cloud trial Agent](HOSTED_AGENT_GUIDE.md) · [中文](HOSTED_AGENT_GUIDE.zh-CN.md): Beta 1 entry for small tasks; running models require validated operator configuration.

## Product and system contracts

- [Product specification](PRODUCT_SPEC.md): user-visible behavior, roles, and permissions.
- [Architecture](ARCHITECTURE.md): components, persistence, and data flow.
- [Interface contracts](INTERFACE_CONTRACTS.md): protocol and integration compatibility boundaries.
- [Security model](SECURITY.md): trust model, threats, authentication, redaction, and incident expectations.
- [Privacy notice](../site/privacy/): account deletion, shared data, and deletion/retention boundaries.
- [Architecture decisions](adr/README.md): accepted ADRs and their status.
- [Hosted trial Agent](HOSTED_AGENT.md): isolated OpenCode runner, provider budget, and operator setup.
- [GitHub cloud workspace](HOSTED_GITHUB.md): authorized npm repository tasks, saved source review and explicit draft PRs; independent App and server activation required.
- [Hosted model API options](HOSTED_AGENT_PROVIDERS.md): pricing, terms, adapter work, and operator handoff.

## Connect local Agent harnesses

- [Connect Codex](CODEX_CONNECT.md) · [中文](CODEX_CONNECT.zh-CN.md)
- [Connect DeepSeek Harness](DSH_CONNECT.md) · [中文](DSH_CONNECT.zh-CN.md)
- [Git-backed code collaboration](CODE_SYNC.md)

## Run and operate GatherThread

- [Connection modes](CONNECTION_MODES.md) · [中文](CONNECTION_MODES.zh-CN.md)
- [Single-owner self-hosting](SELF_HOSTING.md)
- [Operations](OPERATIONS.md)
- [Isolated test service](TEST_ENVIRONMENT.md): the Beta 1 deployment target; independent accounts and admission, without automatic production promotion.
- [Alibaba Cloud ECS profile](ALIYUN_ECS.md) · [中文](ALIYUN_ECS.zh-CN.md)
- [Private Tailscale testing](ONLINE_TESTING_TAILSCALE.zh-CN.md)
- [Legacy Oracle Cloud alternative](ORACLE_CLOUD.md) · [中文](ORACLE_CLOUD.zh-CN.md)

## Release and contribution records

These are point-in-time records. A source commit, Git tag, npm package and server deployment are separate artifacts; consult the relevant record rather than inferring live state from a branch tip.

- [Changelog](../CHANGELOG.md): Beta 1 changes and preserved Alpha history.
- [Release record index](releases/README.md): which version records have tags or GitHub Releases.
- [Contributing guide](../CONTRIBUTING.md): review, verification, and ownership rules.
- [Repository security policy](../SECURITY.md): private reporting entry point shown by GitHub.
- [References](REFERENCES.md), [design references](DESIGN_REFERENCES.md), and [design QA](design-qa.md).
