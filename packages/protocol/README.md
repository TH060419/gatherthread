# Shared protocol

`@agent-cooperation/protocol` is the transport-independent contract shared by the server, browser, bridges, and MCP package. It defines canonical event names, roles, fidelity labels, runtime provenance, append inputs, replay responses, and WebSocket subscription messages as both TypeScript types and Zod schemas.

The server, rather than a client, supplies `actor_user_id`, `sequence`, and `created_at`. Clients supply a stable `idempotency_key`; repeating it within a session as the same actor returns the event already accepted for that key. A collision from another actor is rejected.

Build and test from the repository root:

```sh
npm run build
npm test
```
