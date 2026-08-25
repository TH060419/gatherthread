# Agent Cooperation Project

An open, harness-neutral collaboration layer for people who each work with their own local AI agent.

The first release targets two session modes:

- `solo`: the owner continues a local agent session while collaborators can follow the shared transcript and context read-only.
- `multi`: collaborators share one ordered project conversation. Human chat is recorded without triggering an agent; an agent request is routed to the sender's local harness, and the reply is published with user, harness, provider, and model provenance.

This repository is under active development. See [the product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), and [related work](docs/REFERENCES.md).

