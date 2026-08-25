# Contract E2E harness

This directory owns cross-module acceptance scenarios. The scenarios depend on a small driver interface instead of any server route shape, so application modules can evolve without weakening the contract assertions.

## Run now

```sh
npm run test:e2e
```

With no configuration, the suite uses `lib/memory-driver.mjs`, an executable reference model. A green reference run proves that the scenarios and harness work. It does **not** prove that the production modules conform.

## Run against an integrated stack

Provide an ESM module exporting `createDriver()` and optionally start the stack through the runner:

```sh
COLLAB_E2E_DRIVER=./tests/e2e/drivers/integrated-driver.mjs \
E2E_SERVER_COMMAND='npm run dev' \
E2E_HEALTH_URL='http://127.0.0.1:3000/health' \
npm run test:e2e
```

The integrated driver is deliberately left to the owning application teams because HTTP, WebSocket, authentication, and bridge entry points are not specified yet. It must implement the methods documented in `lib/driver-contract.mjs`. Driver methods should return only after the durable operation commits. `connectClient().nextEvent()` must observe the same post-commit stream an actual client sees.

## Scenario inventory

| Scenario | Contract evidence |
|---|---|
| two users, two clients | both authenticated clients observe identical server sequences |
| solo viewer denial | viewer append fails with `forbidden` and no event is persisted |
| multi realtime order | live delivery matches canonical total order |
| idempotent retry | same key returns the original event and creates one row |
| reconnect replay | `afterSequence` returns every missed event exactly once |
| concurrent append | sequences are unique and contiguous under contention |
| runtime claim | only the initiating user's runtime claims; one active turn per runtime |
| hydration | preceding human chat is present but does not create a runtime claim |
| redaction | credentials and excluded private context never reach persisted payloads |

Each driver instance must isolate its state. The suite never relies on sleeps; it waits on durable results or explicit stream events.
