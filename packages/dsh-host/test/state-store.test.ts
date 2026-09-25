import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileConnectorStateStore,
  MemoryConnectorStateStore,
  validateConnectorState,
} from "../src/state-store.js";
import type { ConnectorState } from "../src/types.js";

const state: ConnectorState = {
  version: 3,
  binding: {
    projectId: "project-1",
    sessionId: "session-1",
    dshSessionId: "gatherthread-deadbeef",
  },
  serverCursor: 8,
  projectionCursor: 8,
  publishedDshSequence: 34,
  automaticUpload: true,
  activeRequest: {
    requestId: "request-1",
    requestSequence: 9,
    dshFromSequence: 35,
    promptDigest: "a".repeat(64),
    claimAttempt: 2,
  },
  outbox: [{
    id: "operation-1",
    kind: "complete",
    requestId: "request-1",
    input: {
      runtimeId: "runtime-1",
      claimAttempt: 2,
      idempotencyKey: "device:request:complete",
      payload: { text: "safe" },
    },
  }],
};

test("memory state is cloned and schema validated", async () => {
  const store = new MemoryConnectorStateStore();
  assert.equal(await store.load(), undefined);
  await store.save(state);
  const loaded = await store.load();
  assert.deepEqual(loaded, state);
  loaded!.binding.sessionId = "mutated";
  assert.equal((await store.load())?.binding.sessionId, "session-1");
});

test("frozen DSH context stays in the private active request, is bounded, and validates the exact request fence", async () => {
  const contextExecution = {
    sessionId: `gatherthread-execution-${"a".repeat(32)}`, selectedOnly: false,
    historyContext: { view: "summary" as const, through_sequence: 8, items: [
      { kind: "summary" as const, event_id: "summary-8", sequence: 1, actor_user_id: "user-1", content: "PUBLIC_FROZEN_DECISION", source_event_ids: ["source-1", "source-3"] },
    ] },
  };
  const contextual = { ...state, activeRequest: { ...state.activeRequest!, contextExecution } };
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-context-state-")));
  const filename = path.join(root, "state.json");
  const store = new FileConnectorStateStore(filename);
  await store.save(contextual);
  assert.deepEqual(await store.load(), contextual);
  if (process.platform !== "win32") assert.equal((await stat(filename)).mode & 0o777, 0o600);
  for (const bad of [
    { ...contextExecution, sessionId: "some-unrelated-native-session" },
    { ...contextExecution, selectedOnly: true },
    { ...contextExecution, historyContext: { ...contextExecution.historyContext, through_sequence: 7 } },
    { ...contextExecution, historyContext: { ...contextExecution.historyContext, items: [{ ...contextExecution.historyContext.items[0]!, content: "x".repeat(256 * 1024) }] } },
  ]) assert.throws(() => validateConnectorState({ ...contextual, activeRequest: { ...state.activeRequest!, contextExecution: bad } }), /context|Context|256|Selected/);
  const settled = { ...contextual }; delete (settled as ConnectorState).activeRequest;
  await store.save(settled);
  assert.doesNotMatch(await readFile(filename, "utf8"), /PUBLIC_FROZEN_DECISION/);
});

test("legacy state resets only its native projection cursor for safe history backfill", () => {
  const legacy = {
    ...state,
    version: 1,
  };
  delete (legacy as { projectionCursor?: number }).projectionCursor;
  delete (legacy as { automaticUpload?: boolean }).automaticUpload;
  assert.deepEqual(validateConnectorState(legacy), {
    ...state,
    version: 3,
    projectionCursor: 0,
  });
});

test("version two state migrates to automatic upload enabled", () => {
  const legacy = { ...state, version: 2 } as Record<string, unknown>;
  delete legacy.automaticUpload;
  assert.equal(validateConnectorState(legacy).automaticUpload, true);
});

test("file state uses an atomic private artifact and restores exactly", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-state-")));
  const statePath = path.join(root, "nested", "connector.json");
  const store = new FileConnectorStateStore(statePath);
  assert.equal(await store.load(), undefined);
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(statePath))).mode & 0o777, 0o700);
  }
  assert.doesNotMatch(await readFile(statePath, "utf8"), /token|reasoning|thinking/i);
});

test("corrupt, unknown, and secret-bearing state fails closed", async () => {
  assert.throws(
    () => validateConnectorState({ ...state, unknown: true }),
    /unsupported keys/,
  );
  assert.throws(
    () => validateConnectorState({
      ...state,
      outbox: [{
        ...state.outbox[0],
        input: { ...state.outbox[0]!.input, payload: { api_key: "top-secret" } },
      }],
    }),
    /secret-bearing/,
  );

  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-corrupt-")));
  const statePath = path.join(root, "connector.json");
  await writeFile(statePath, "{not-json\n", { mode: 0o600 });
  await assert.rejects(new FileConnectorStateStore(statePath).load(), /not valid JSON/);
});

test("state reads and writes reject symlink and directory replacement surfaces", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-symlink-")));
  const target = path.join(root, "target.json");
  const statePath = path.join(root, "state.json");
  await writeFile(target, JSON.stringify(state), { mode: 0o600 });
  await symlink(target, statePath);
  const linkedStore = new FileConnectorStateStore(statePath);
  await assert.rejects(linkedStore.load(), /never a symbolic link/);
  await assert.rejects(linkedStore.save(state), /never a symbolic link/);
  assert.equal(await readFile(target, "utf8"), JSON.stringify(state));

  const realDirectory = path.join(root, "real-state");
  const linkedDirectory = path.join(root, "linked-state");
  await mkdir(realDirectory, { mode: 0o700 });
  await symlink(realDirectory, linkedDirectory, "dir");
  const directoryStore = new FileConnectorStateStore(path.join(linkedDirectory, "connector.json"));
  await assert.rejects(directoryStore.save(state), /symbolic-link ancestor/);

  const nestedRealDirectory = path.join(root, "ancestor-target", "level-one");
  const nestedLinkedDirectory = path.join(root, "ancestor-link");
  await mkdir(nestedRealDirectory, { recursive: true, mode: 0o700 });
  await symlink(path.dirname(nestedRealDirectory), nestedLinkedDirectory, "dir");
  const ancestorStore = new FileConnectorStateStore(path.join(
    nestedLinkedDirectory,
    "level-one",
    "level-two",
    "connector.json",
  ));
  await assert.rejects(ancestorStore.save(state), /symbolic-link ancestor/);
});

test("state rejects a pre-existing directory that is not private", {
  skip: process.platform === "win32",
}, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-permissions-")));
  const directory = path.join(root, "state");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o750);
  const store = new FileConnectorStateStore(path.join(directory, "connector.json"));
  await assert.rejects(store.save(state), /permissions must be 0700/);
});

test("state rejects a regular target whose owner permission bits are not exactly 0600", {
  skip: process.platform === "win32",
}, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-file-mode-")));
  const statePath = path.join(root, "connector.json");
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await chmod(statePath, 0o400);
  await assert.rejects(new FileConnectorStateStore(statePath).load(), /permissions must be 0600/);
});
