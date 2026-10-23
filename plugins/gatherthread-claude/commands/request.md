---
description: Request an Agent after confirming target, task and compute use
disable-model-invocation: true
---

Read the target context and keep its content_revision. Explain that requesting an Agent is a separate operation and may consume the configured native account's allowance. Confirm the exact conversation/task and compute use with the user before collaboration_request_agent. Use a fresh stable idempotency_key; preserve its revision on retry. Do not silently choose a different Agent/model or invoke a shared Agent without the additional explicit transfer/compute consent required by those tools.
