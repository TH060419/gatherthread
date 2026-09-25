import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CodexAppServerClient,
  CodexAppServerExecutor,
  CodexProjectHarness,
  HarnessExecutionTerminatedError,
  buildVisibleHistoryImport,
  codexSessionKey,
  discoverCompletedLocalTurns,
  splitUtf8,
  type CanonicalEvent,
  type CollaborationApi,
  type RegisteredRuntime,
} from "../src/index.js";

test("shared summaries rebuild only hidden Codex model context and original mode restores source", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gt-summary-codex-")));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "rpc.jsonl");
  const fake = path.join(directory, "fake.mjs");
  await writeFile(fake, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
let next = 0;
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 if (message.method === "initialized") continue;
 appendFileSync(process.env.CAPTURE, JSON.stringify(message) + "\\n");
 if (message.method === "thread/start") send({id:message.id,result:{thread:{id:"hidden-"+(++next)}}});
 else if (message.method === "turn/start") {
  const turn = {id:"turn-"+next+"-"+message.id,status:"completed",items:[{type:"agentMessage",text:"answer",phase:"final_answer"}]};
  send({id:message.id,result:{turn}});
  send({method:"turn/completed",params:{threadId:message.params.threadId,turn}});
 } else send({id:message.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fake], cwd: directory,
    env: { ...process.env, CAPTURE: capturePath } });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({ client, workspacePath: directory, statePath,
    threadName: "hidden summary test", model: "gpt-test", threadSource: "exec" });
  const runtime = registeredRuntime("local");
  const raw = canonical(1, "human_chat", { text: "VERBATIM_ORIGINAL_ONLY" });
  const summaryRequest = canonical(2, "agent_request", { content: "GENERATION_SOURCE_COPY", history_summary: {} });
  const summaryResponse = canonical(3, "agent_response", { text: "CONCISE_SHARED_SUMMARY" });
  await executor.projectCanonicalEvents([raw, summaryRequest, summaryResponse], runtime);
  const passiveState = JSON.parse(await readFile(statePath, "utf8"));
  const passive = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((message) => message.params?.threadId === passiveState.threadId);
  assert.doesNotMatch(JSON.stringify(passive), /GENERATION_SOURCE_COPY/,
    "passive Codex projection must not duplicate the selected source prompt");
  assert.equal(passiveState.sidecar.find((entry: any) => entry.eventId === summaryRequest.id)?.disposition, "summary_control");
  await executor.execute({ request: canonical(4, "agent_request", { text: "continue" }),
    canonicalHistory: [raw, summaryRequest, summaryResponse], runtime,
    historyContext: { view: "summary", through_sequence: 3, items: [{ kind: "summary", event_id: "event-3",
      sequence: 1, actor_user_id: "user-1", content: "CONCISE_SHARED_SUMMARY", source_event_ids: [raw.id] }] } });
  const summarizedState = JSON.parse(await readFile(statePath, "utf8"));
  const rpc = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const selected = rpc.filter((message) => message.params?.threadId === summarizedState.threadId);
  assert.match(JSON.stringify(selected), /CONCISE_SHARED_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(selected), /VERBATIM_ORIGINAL_ONLY|GENERATION_SOURCE_COPY/);
  assert.ok(rpc.filter((message) => message.method === "thread/start").every((message) =>
    message.params.threadSource === "exec" && message.params.ephemeral === true));

  await executor.execute({ request: canonical(5, "agent_request", { text: "use originals" }),
    canonicalHistory: [raw, summaryRequest, summaryResponse], runtime,
    historyContext: { view: "original", through_sequence: 4, items: [{ kind: "original", event_id: raw.id,
      sequence: 1, actor_user_id: raw.actorId, content: "VERBATIM_ORIGINAL_ONLY" }] } });
  const originalState = JSON.parse(await readFile(statePath, "utf8"));
  assert.notEqual(originalState.threadId, summarizedState.threadId);
  const restored = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((message) => message.params?.threadId === originalState.threadId);
  assert.match(JSON.stringify(restored), /VERBATIM_ORIGINAL_ONLY/);
  assert.doesNotMatch(JSON.stringify(restored), /CONCISE_SHARED_SUMMARY|GENERATION_SOURCE_COPY/);

  const generation = canonical(6, "agent_request", {
    content: "ONLY_SELECTED_RECORDS_FOR_NEW_SUMMARY", history_summary: { version: 1 },
  });
  await executor.execute({ request: generation,
    canonicalHistory: [raw, summaryRequest, summaryResponse], runtime,
    historyContext: { view: "summary", through_sequence: 5, items: [] } });
  const generationState = JSON.parse(await readFile(statePath, "utf8"));
  assert.notEqual(generationState.threadId, originalState.threadId);
  const isolated = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((message) => message.params?.threadId === generationState.threadId);
  assert.match(JSON.stringify(isolated), /ONLY_SELECTED_RECORDS_FOR_NEW_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(isolated), /VERBATIM_ORIGINAL_ONLY|CONCISE_SHARED_SUMMARY|GENERATION_SOURCE_COPY/);
});

test("Codex executor passively skips requests targeted to another exact runtime or provider", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-codex-routing-")));
  const executor = new CodexAppServerExecutor({
    client: { close: async () => undefined } as unknown as CodexAppServerClient,
    workspacePath: directory,
    statePath: path.join(directory, "state.json"),
    threadName: "GatherThread · routing",
    model: "gpt-test",
  });
  const runtime = registeredRuntime("routing-thread");
  const targeted = (profile: Record<string, unknown>) => canonical(1, "agent_request", {
    content: "route exactly once",
    execution_profile: {
      harness: "codex",
      model: "gpt-5.6-sol",
      ...profile,
    },
  });

  assert.equal(await executor.shouldExecute(targeted({ runtime_id: "runtime-other" }), runtime), false);
  assert.equal(await executor.shouldExecute(targeted({ provider: "provider-other" }), runtime), false);
  assert.equal(await executor.shouldExecute(targeted({ runtime_id: runtime.id, provider: runtime.provider }), runtime), true);
});

test("source sync activity probe reads native state and treats unknown or active runs as busy", async () => {
  const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "gt-code-activity-")));
  const statePath = path.join(workspacePath, "state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  const originalState = await readFile(statePath, "utf8");
  let status = "active";
  const executor = new CodexAppServerExecutor({
    client: { readThread: async () => ({ id: "old-thread", status, turns: [] }), close: async () => undefined } as unknown as CodexAppServerClient,
    workspacePath, statePath, threadName: "Code status only", model: "gpt-test",
  });
  assert.equal(await executor.isLocalRunActive(), true);
  status = "unknown";
  assert.equal(await executor.isLocalRunActive(), true);
  status = "idle";
  assert.equal(await executor.isLocalRunActive(), false);
  status = "notLoaded";
  assert.equal(await executor.isLocalRunActive(), false);
  assert.equal(await readFile(statePath, "utf8"), originalState);
});

test("source sync refuses unfinished native turns even when the thread is not loaded", async () => {
  const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "gt-code-turn-activity-")));
  const statePath = path.join(workspacePath, "state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  let turnStatus = "inProgress";
  const executor = new CodexAppServerExecutor({
    client: { readThread: async () => ({
      id: "old-thread", status: "notLoaded", turns: [{ id: "local-turn", status: turnStatus, items: [] }],
    }), close: async () => undefined } as unknown as CodexAppServerClient,
    workspacePath, statePath, threadName: "Code status only", model: "gpt-test",
  });
  assert.equal(await executor.isLocalRunActive(), true);
  turnStatus = "unknown";
  assert.equal(await executor.isLocalRunActive(), true);
  for (turnStatus of ["completed", "failed", "interrupted"]) assert.equal(await executor.isLocalRunActive(), false);
});

test("source sync activity retains durable uncertain runs and fails closed for a missing binding", async () => {
  const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "gt-code-durable-activity-")));
  const statePath = path.join(workspacePath, "state.json");
  const executor = new CodexAppServerExecutor({
    client: { readThread: async () => ({ id: "old-thread", status: "idle", turns: [] }), close: async () => undefined } as unknown as CodexAppServerClient,
    workspacePath, statePath, threadName: "Code status only", model: "gpt-test",
  });
  assert.equal(await executor.isLocalRunActive(), true);
  for (const journal of [
    { hookDrafts: { "local-turn": { threadId: "old-thread", turnId: "local-turn", requestPayload: { text: "unfinished" } } } },
    { executionJournal: { "request-1": { requestId: "request-1", status: "prepared" } } },
    { executionJournal: { "request-1": { requestId: "request-1", status: "started", turnId: "turn-1" } } },
  ]) {
    await writeFile(statePath, JSON.stringify({ ...projectionState(workspacePath), ...journal }));
    assert.equal(await executor.isLocalRunActive(), true);
  }
});

test("visible-history import is deterministic and preserves full history beyond the context window", () => {
  const empty = buildVisibleHistoryImport([], 1, 4_096);
  assert.equal(empty.messages.length, 2);
  assert.match(empty.messages[0]?.text ?? "", /empty shared session/i);
  assert.equal(empty.compacted, false);

  const withSummary = buildVisibleHistoryImport([
    canonical(1, "human_chat", { text: "SOURCE_ORIGINAL" }),
    canonical(2, "agent_request", { content: "DUPLICATED_SELECTION_PROMPT", history_summary: { version: 1 } }),
    canonical(3, "agent_response", { text: "GENERATED_SHARED_SUMMARY" }),
  ], 3, 4_096);
  assert.match(JSON.stringify(withSummary.messages), /SOURCE_ORIGINAL|GENERATED_SHARED_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(withSummary.messages), /DUPLICATED_SELECTION_PROMPT/);

  const events = Array.from({ length: 80 }, (_, index) => canonical(
    index + 1,
    index % 2 === 0 ? "human_chat" : "agent_response",
    { text: `${index}: ${"history ".repeat(120)}` },
    "user-2",
  ));
  const first = buildVisibleHistoryImport(events, 80, 4_096);
  const second = buildVisibleHistoryImport(events, 80, 4_096);
  assert.equal(first.digest, second.digest);
  assert.equal(first.compacted, false);
  assert.ok(first.estimatedTokens > Math.floor(4_096 * 0.8));
  assert.equal(first.messages.length, events.length);
  assert.match(first.messages[0]?.text ?? "", /0: history/);
  assert.match(first.messages.at(-1)?.text ?? "", /79:/);
});

test("visible-history import retains old text and the end of an oversized recent message", () => {
  const recent = `recent-start ${"甲🙂".repeat(12_000)} recent-end`;
  const history = buildVisibleHistoryImport([
    canonical(1, "human_chat", { text: "old-public-text" }),
    canonical(2, "agent_response", { text: recent }),
  ], 2, 4_096);
  assert.equal(history.messages.length, 2);
  assert.match(history.messages[0]?.text ?? "", /old-public-text/);
  assert.ok(history.messages[1]?.text.endsWith(recent));
  assert.equal(history.compacted, false);
});

test("visible-history resource ceiling rejects oversized JSON before importing or switching binding", async () => {
  const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "gt-visible-resource-limit-")));
  const statePath = path.join(workspacePath, "state.json");
  const original = JSON.stringify(projectionState(workspacePath));
  await writeFile(statePath, original);
  let imports = 0;
  const executor = new CodexAppServerExecutor({
    client: { close: async () => undefined } as unknown as CodexAppServerClient,
    workspacePath, statePath, threadName: "Resource ceiling", model: "gpt-test",
    desktopHookOnly: true, gatherThreadSessionId: "session-1",
    visibleHistoryImporter: async () => { imports += 1; throw new Error("oversized snapshot unexpectedly reached native importer"); },
  });
  // JSON escaping, not just text bytes, counts against the resource ceiling.
  await assert.rejects(executor.importVisibleHistorySnapshot([
    canonical(3, "human_chat", { text: '"'.repeat(4 * 1024 * 1024) }),
  ], 3), /visible history.*8 MiB/i);
  assert.equal(imports, 0);
  assert.equal(await readFile(statePath, "utf8"), original);
});

test("large visible snapshots compact natively and preserve the old binding on native failure or known-full usage", async () => {
  for (const outcome of ["ready", "failed", "full", "unknown"]) {
    const fails = outcome === "failed";
    const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "gt-visible-native-compact-")));
    const statePath = path.join(workspacePath, "state.json");
    const original = JSON.stringify({ ...projectionState(workspacePath), contextWindowTokens: 4096 });
    await writeFile(statePath, original);
    let compactions = 0;
    const archived: string[] = [];
    const executor = new CodexAppServerExecutor({
      client: {
        readThread: async (id: string) => ({ id, projectId: "project-1", status: "idle", turns: [completedTurn("imported", null, "full", "history")] }),
        setThreadName: async () => undefined,
        findProjectIdForRoot: async () => "project-1",
        compactThread: async () => { compactions += 1; if (fails) throw new Error("native compact failed"); },
        getThreadTokenUsage: () => compactions > 0 && !fails && outcome !== "unknown"
          ? { modelContextWindow: 4096, totalTokens: outcome === "full" ? 3500 : 300 } : undefined,
        archiveThread: async (id: string) => { archived.push(id); },
        unsubscribeThread: async () => undefined,
        close: async () => undefined,
      } as unknown as CodexAppServerClient,
      workspacePath, statePath, threadName: "Native import", model: "gpt-test",
      contextWindowTokens: 4096, desktopHookOnly: true, gatherThreadSessionId: "session-1",
      visibleHistoryImporter: async ({ history }) => {
        assert.match(history.messages[0]?.text ?? "", /old-public-text/);
        assert.match(history.messages.at(-1)?.text ?? "", /recent-end$/);
        return { threadId: "candidate" };
      },
    });
    const operation = executor.importVisibleHistorySnapshot([
      canonical(1, "human_chat", { text: "old-public-text" }),
      canonical(2, "agent_response", { text: `${"history ".repeat(4000)}recent-end` }),
    ], 2);
    if (fails || outcome === "full") {
      await assert.rejects(operation, fails ? /native compact failed/ : /context.*high-water/i);
      assert.equal(await readFile(statePath, "utf8"), original);
      assert.deepEqual(archived, ["candidate"]);
    } else {
      const result = await operation;
      assert.equal(result.compacted, true);
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.threadId, "candidate");
      assert.equal(saved.contextUsageSource, outcome === "unknown" ? "unknown_after_compaction" : "app_server");
      if (outcome === "unknown") assert.ok(saved.estimatedContextTokens > 9000);
      else assert.equal(saved.estimatedContextTokens, 300);
      assert.deepEqual(archived, []);
    }
    assert.equal(compactions, 1);
  }
});

test("visible-history import gives a metadata-only new session a local user marker", () => {
  const imported = buildVisibleHistoryImport([
    canonical(1, "session_state_change", { action: "created", mode: "multi", title: "New session" }),
  ], 1, 4_096);

  assert.equal(imported.messages[0]?.role, "user");
  assert.match(imported.messages[0]?.text ?? "", /local-only marker/i);
  assert.match(imported.messages[0]?.text ?? "", /never uploaded to GatherThread/i);
  assert.equal(imported.messages.some((message) => /Session State Change/.test(message.text)), true);
});

test("visible-history manual import switches to a verified new task and leaves the previous task untouched", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-visible-history-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const hookRegistryPath = path.join(directory, "hook-registry.json");
  const state = projectionState(workspacePath) as Record<string, unknown>;
  state.visibleHistorySnapshot = {
    digest: "a".repeat(64), threadId: "old-thread", throughSequence: 2,
    importedAt: "2026-08-25T12:00:00.000Z", compacted: false,
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(hookRegistryPath, JSON.stringify({
    version: 1,
    workspacePath,
    threads: { "old-thread": "execution" },
  }), { mode: 0o600 });
  const calls: string[] = [];
  const fakeClient = {
    readThread: async (threadId: string) => {
      calls.push(`read:${threadId}`);
      return {
        id: threadId,
        name: null,
        projectId: "project-1",
        status: "idle",
        turns: threadId === "candidate-thread" ? [completedTurn("external-import-turn-1", null, "visible", "history")] : [],
      };
    },
    resumeThread: async (input: { threadId: string }) => { calls.push(`resume:${input.threadId}`); },
    setThreadName: async (threadId: string) => { calls.push(`name:${threadId}`); },
    findProjectIdForRoot: async () => "project-1",
    setThreadProject: async () => true,
    compactThread: async (threadId: string) => { calls.push(`compact:${threadId}`); },
    getThreadTokenUsage: () => undefined,
    deleteThread: async (threadId: string) => { calls.push(`delete:${threadId}`); },
    archiveThread: async (threadId: string) => { calls.push(`archive:${threadId}`); },
    unsubscribeThread: async () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  let imported = 0;
  const executor = new CodexAppServerExecutor({
    client: fakeClient,
    workspacePath,
    statePath,
    threadName: "GatherThread · visible",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
    hookRegistryPath,
    visibleHistoryImporter: async () => {
      imported += 1;
      calls.push("import:candidate-thread");
      return { threadId: "candidate-thread" };
    },
  });
  const events = [canonical(1, "human_chat", { text: "hello" }), canonical(2, "agent_response", { text: "world" })];
  const importedResult = await executor.importVisibleHistorySnapshot(events, 2);
  assert.equal(importedResult.status, "imported");
  assert.equal(importedResult.previousThreadId, "old-thread");
  assert.equal(importedResult.previousTaskRetained, true);
  assert.match(importedResult.threadName ?? "", /history #2$/);
  assert.equal(imported, 1);
  assert.equal(calls.includes("resume:old-thread"), false);
  assert.equal(calls.includes("delete:old-thread"), false);
  assert.equal(calls.includes("archive:old-thread"), false);
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stored.threadId, "candidate-thread");
  assert.deepEqual(stored.localOnlyThreadIds, ["old-thread"]);
  assert.equal(stored.desktopProjectionCursor, 2);
  assert.deepEqual(stored.connectorTurnIds, ["external-import-turn-1"]);
  assert.deepEqual(JSON.parse(await readFile(hookRegistryPath, "utf8")).threads, {
    "old-thread": "local_only",
    "candidate-thread": "execution",
  });

  const unchanged = await executor.importVisibleHistorySnapshot(events, 2, { onlyIfMissing: true });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(imported, 1);
  const firstConnectionOnly = await executor.importVisibleHistorySnapshot([
    ...events,
    canonical(3, "human_chat", { text: "newer cloud event" }),
  ], 3, { onlyIfMissing: true });
  assert.equal(firstConnectionOnly.status, "unchanged");
  assert.equal(firstConnectionOnly.throughSequence, 2);
  assert.equal(imported, 1);
});

test("manual visible-history import creates a new task without taking the Desktop-held writer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-visible-history-writer-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const hookRegistryPath = path.join(directory, "hook-registry.json");
  const state = projectionState(workspacePath) as Record<string, unknown>;
  state.visibleHistorySnapshot = {
    digest: "a".repeat(64), threadId: "old-thread", throughSequence: 1,
    importedAt: "2026-08-25T12:00:00.000Z", compacted: false,
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(hookRegistryPath, JSON.stringify({
    version: 1,
    workspacePath,
    threads: { "old-thread": "execution" },
  }), { mode: 0o600 });
  let imports = 0;
  let oldTaskMutations = 0;
  const fakeClient = {
    readThread: async (threadId: string) => ({
      id: threadId,
      name: null,
      projectId: "project-1",
      status: "idle",
      turns: threadId === "candidate-thread"
        ? [completedTurn("external-import-turn-1", null, "visible", "history")]
        : [],
    }),
    resumeThread: async () => {
      oldTaskMutations += 1;
      throw new Error("thread old-thread already has an active writer");
    },
    setThreadName: async () => undefined,
    findProjectIdForRoot: async () => "project-1",
    setThreadProject: async () => true,
    compactThread: async () => undefined,
    getThreadTokenUsage: () => undefined,
    deleteThread: async () => {
      oldTaskMutations += 1;
      throw new Error("thread old-thread already has an active writer");
    },
    archiveThread: async () => {
      oldTaskMutations += 1;
      throw new Error("thread old-thread already has an active writer");
    },
    unsubscribeThread: async () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client: fakeClient,
    workspacePath,
    statePath,
    threadName: "GatherThread · visible",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
    hookRegistryPath,
    localPublishingInitiallyActive: false,
    visibleHistoryImporter: async () => {
      imports += 1;
      return { threadId: "candidate-thread" };
    },
  });

  const result = await executor.importVisibleHistorySnapshot([
    canonical(2, "human_chat", { text: "new cloud event" }),
  ], 2);
  assert.equal(result.status, "imported");
  assert.equal(imports, 1);
  assert.equal(oldTaskMutations, 0, "manual import must leave the previous task for the user to archive");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "candidate-thread");
  assert.deepEqual(JSON.parse(await readFile(hookRegistryPath, "utf8")).threads, {
    "old-thread": "local_only",
    "candidate-thread": "local_only",
  });
  await writeFile(hookRegistryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }), { mode: 0o600 });
  await executor.activateLocalPublishing();
  assert.deepEqual(JSON.parse(await readFile(hookRegistryPath, "utf8")).threads, {
    "old-thread": "local_only",
    "candidate-thread": "execution",
  });
});

test("first-connect import drops obsolete replacement cleanup state without touching either task", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-visible-history-cleanup-pending-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const hookRegistryPath = path.join(directory, "hook-registry.json");
  const events = [canonical(1, "human_chat", { text: "hello" })];
  const history = buildVisibleHistoryImport(events, 1, 65_536);
  const state = projectionState(workspacePath) as Record<string, unknown>;
  state.threadId = "current-thread";
  state.visibleHistorySnapshot = {
    digest: history.digest,
    threadId: "current-thread",
    throughSequence: 1,
    importedAt: "2026-08-25T12:00:00.000Z",
    compacted: false,
    replacedThreadId: "old-thread",
  };
  await writeFile(statePath, JSON.stringify(state));
  let imports = 0;
  const fakeClient = { close: async () => undefined } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client: fakeClient,
    workspacePath,
    statePath,
    threadName: "GatherThread · visible",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
    hookRegistryPath,
    visibleHistoryImporter: async () => {
      imports += 1;
      return { threadId: "another-thread" };
    },
  });

  const result = await executor.importVisibleHistorySnapshot(events, 1, { onlyIfMissing: true });
  assert.equal(result.status, "unchanged");
  assert.equal(result.threadId, "current-thread");
  assert.equal(imports, 0);
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stored.visibleHistorySnapshot.replacedThreadId, undefined);
  assert.deepEqual(stored.localOnlyThreadIds, ["old-thread"]);
  assert.deepEqual(JSON.parse(await readFile(hookRegistryPath, "utf8")).threads, {
    "old-thread": "local_only",
  });
});

test("local turn discovery uses persisted client ids and stable turn ids", () => {
  const state = {
    threadId: "thread-1",
    connectorClientMessageIds: ["event-cloud"],
    connectorTurnIds: ["turn-cloud"],
    localTurnBindings: {},
  };
  const turns = [
    completedTurn("turn-cloud", "event-cloud", "cloud request", "cloud response"),
    completedTurn("turn-local", "desktop-client-1", "local request", "local response"),
  ];
  const first = discoverCompletedLocalTurns(turns, state);
  const second = discoverCompletedLocalTurns(turns, state);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.requestPayload.text, "local request");
  assert.equal(first[0]?.responsePayload.text, "local response");
  assert.equal(first[0]?.localTurnId, second[0]?.localTurnId);
  assert.match(first[0]?.localTurnId ?? "", /^codex:[a-f0-9]{64}$/);
  assert.equal(discoverCompletedLocalTurns([
    completedTurn("turn-ambiguous", null, "ambiguous", "response"),
    completedTurn("turn-local-2", "desktop-client-2", "later", "response"),
  ], state).length, 1, "an unidentifiable turn must not block later identifiable turns");
});

test("local Codex tool items become canonical local-turn tool pairs", () => {
  const state = {
    threadId: "thread-1",
    connectorClientMessageIds: [],
    connectorTurnIds: [],
    localTurnBindings: {},
  };
  const turn = completedTurn("turn-tools", "desktop-client-tools", "run tests", "all green");
  turn.items.splice(1, 0, {
    type: "commandExecution",
    id: "command-1",
    command: "npm test",
    status: "completed",
    exitCode: 0,
    aggregatedOutput: "27 passed",
  });
  const discovered = discoverCompletedLocalTurns([turn], state);
  assert.deepEqual(discovered[0]?.toolEvents.map((event) => event.type), ["tool_call", "tool_result"]);
  assert.deepEqual(discovered[0]?.toolEvents[0]?.payload, {
    tool_name: "command_execution",
    tool_call_id: "command:command-1",
    arguments: { command: "npm test" },
  });
  assert.equal((discovered[0]?.toolEvents[1]?.payload as { is_error?: boolean }).is_error, false);
});

test("manual Codex upload discovers a completed Desktop turn even when no Hook draft exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-manual-upload-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  const client = {
    readThread: async (threadId: string) => ({
      id: threadId,
      name: "Manual recovery",
      projectId: null,
      status: "idle",
      turns: [completedTurn("missed-hook-turn", "desktop-client-manual", "MANUAL_REQUEST", "MANUAL_RESPONSE")],
    }),
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Manual recovery",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });
  const runtime = registeredRuntime("manual-recovery");
  const committed: Array<{ basedOnSequence: number; requestPayload: unknown; responsePayload: unknown }> = [];
  const api = {
    readEvents: async () => ({ events: [], nextSequence: 2, hasMore: false }),
    commitLocalTurn: async (_sessionId: string, input: any) => {
      committed.push(input);
      return {
        localTurnId: input.localTurnId,
        runtimeId: runtime.id,
        headBeforeCommit: 2,
        reconciliationRequired: false,
        requestEvent: canonical(3, "agent_request", input.requestPayload),
        responseEvent: canonical(4, "agent_response", input.responsePayload),
        toolEvents: [],
      };
    },
  } as unknown as CollaborationApi;

  const disabled = await executor.setLocalAutoUpload(false);
  assert.equal(disabled.automaticUpload, false);
  assert.equal(disabled.uploadableLocalTurns, 1);
  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "UserPromptSubmit", session_id: "old-thread", turn_id: "hook-captured-turn",
    cwd: workspacePath, model: "gpt-test", prompt: "HOOK_REQUEST",
  });
  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "Stop", session_id: "old-thread", turn_id: "hook-captured-turn",
    cwd: workspacePath, model: "gpt-test", stop_hook_active: false, last_assistant_message: "HOOK_RESPONSE",
  });
  await executor.synchronizeLocalTurns(api, runtime);
  assert.equal(committed.length, 0, "a trusted Hook must not bypass the disabled automatic-upload preference");
  const result = await executor.uploadLocalTurns(api, runtime);
  assert.equal(result.discoveredLocalTurns, 1);
  assert.equal(result.uploadedLocalTurns, 2, "manual recovery uploads both Hook-captured and Hook-missed turns");
  assert.equal(result.automaticUpload, false);
  const manual = committed.find((input) => (input.requestPayload as any)?.text === "MANUAL_REQUEST");
  assert.equal(manual?.basedOnSequence, 0, "a Hook-missed turn must use a conservative unknown base");
  assert.deepEqual(manual?.responsePayload, { text: "MANUAL_RESPONSE" });
});

test("a first local prompt can adopt its Desktop task without opening a competing writer", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-adopt-local-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: ["--version"], cwd: directory });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Personal solo",
    model: "gpt-test",
    desktopHookOnly: true,
    localPublishingInitiallyActive: false,
    gatherThreadSessionId: "session-personal-1",
  });
  await executor.adoptDesktopThread("session-personal-1", "desktop-thread-1");
  await executor.adoptDesktopThread("session-personal-1", "desktop-thread-1");
  const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(state.gatherThreadSessionId, "session-personal-1");
  assert.equal(state.threadId, "desktop-thread-1");
  await assert.rejects(
    executor.adoptDesktopThread("session-personal-1", "desktop-thread-other"),
    /different local Codex task binding/,
  );
});

test("trusted desktop hooks publish without opening the Desktop-owned thread writer", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-owner-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    threadName: "A user-renamed local task",
  }));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") fail(message.id, "thread old-thread already has an active writer");
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
function fail(id, message) { process.stdout.write(JSON.stringify({ id, error: { code: -32000, message } }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Desktop owned",
    model: "gpt-test",
    desktopHookOnly: true,
  });
  const runtime = registeredRuntime("desktop-binding");
  const cloudDelta = canonical(3, "human_chat", { text: "cloud context" }, "user-2");
  let committedBase = -1;
  let committedModel: string | undefined;
  let committedReasoningEffort: string | undefined;
  const api = {
    readEvents: async () => ({ events: [cloudDelta], nextSequence: 4, hasMore: false }),
    commitLocalTurn: async (_sessionId: string, input: { basedOnSequence: number; observedModel?: string; observedReasoningEffort?: string; toolEvents: unknown[] }) => {
      committedBase = input.basedOnSequence;
      committedModel = input.observedModel;
      committedReasoningEffort = input.observedReasoningEffort;
      return {
        localTurnId: "local", runtimeId: runtime.id, headBeforeCommit: 4, reconciliationRequired: false,
        requestEvent: canonical(5, "agent_request", { text: "desktop prompt" }),
        responseEvent: canonical(6, "agent_response", { text: "desktop answer" }),
        toolEvents: input.toolEvents,
      };
    },
  } as unknown as CollaborationApi;

  const first = await executor.handleHookEvent(api, runtime, {
    hook_event_name: "UserPromptSubmit", session_id: "old-thread", turn_id: "desktop-turn",
    cwd: workspacePath, model: "gpt-other", reasoning_effort: "high", prompt: "desktop prompt",
  });
  assert.equal(first.handled, true, "the stable native thread id must match even when the local title differs");
  const retry = await executor.handleHookEvent(api, runtime, {
    hook_event_name: "UserPromptSubmit", session_id: "old-thread", turn_id: "desktop-turn",
    cwd: workspacePath, model: "gpt-other", reasoning_effort: "high", prompt: "desktop prompt",
  });
  assert.match(first.additionalContext ?? "", /已加载 1 条云端更新/);
  assert.match(first.additionalContext ?? "", /Loaded 1 cloud update/);
  assert.match(first.additionalContext ?? "", /只显示下方简短的可见同步摘要/);
  assert.match(first.additionalContext ?? "", /BEGIN VISIBLE SYNC SUMMARY/);
  assert.match(first.additionalContext ?? "", /\[sequence 3\].*Human Chat.*cloud context/s);
  assert.match(first.additionalContext ?? "", /BEGIN GatherThread exact cloud context/);
  assert.match(first.additionalContext ?? "", /END GatherThread exact cloud context/);
  assert.equal(retry.additionalContext, first.additionalContext, "a retried hook must receive the same canonical delta");
  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "Stop", session_id: "old-thread", turn_id: "desktop-turn",
    cwd: workspacePath, model: "gpt-other", reasoning_effort: "high", stop_hook_active: false, last_assistant_message: "desktop answer",
  });
  await executor.synchronizeLocalTurns(api, runtime);
  await executor.synchronizeLocalTurns(api, runtime);

  const captures = await readFile(capturePath, "utf8").catch(() => "");
  assert.doesNotMatch(captures, /thread\/read|thread\/resume|thread\/inject_items|turn\/start/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(committedBase, 4, "ACL-hidden canonical tails still advance the Desktop context base");
  assert.equal(committedModel, "gpt-other", "Desktop-selected model is frozen per local turn");
  assert.equal(committedReasoningEffort, "high", "reasoning effort is frozen when the Hook exposes it");
  assert.equal(state.cloudCursor, 6);
  assert.equal(state.pendingLocalTurns.length, 0);
});

test("idle Desktop-owned tasks receive remote canonical history through native item injection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-native-history-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  const calls: Array<{ method: string; threadId?: string; items?: readonly unknown[] }> = [];
  const client = {
    readThread: async (threadId: string) => {
      calls.push({ method: "thread/read", threadId });
      return { id: threadId, name: "Session · GatherThread", status: "idle", turns: [] };
    },
    resumeThread: async ({ threadId }: { threadId: string }) => { calls.push({ method: "thread/resume", threadId }); },
    injectItems: async (threadId: string, items: readonly unknown[]) => { calls.push({ method: "thread/inject_items", threadId, items }); },
    unsubscribeThread: async (threadId: string) => { calls.push({ method: "thread/unsubscribe", threadId }); },
    getThreadTokenUsage: () => undefined,
    close: async () => { calls.push({ method: "client/close" }); },
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });
  const runtime = registeredRuntime("desktop-native-history");
  const remoteRuntime = { ...runtimeProvenance(runtime), runtimeId: "other-harness-remote", harness: "claude-code" as const };
  const events = [
    canonical(3, "human_chat", { text: "remote human message" }, "user-2"),
    canonical(4, "agent_response", { text: "remote DSH answer" }, "user-2", remoteRuntime),
  ];

  await executor.projectCanonicalEvents(events, runtime);
  await executor.projectCanonicalEvents(events, runtime);

  const injections = calls.filter((call) => call.method === "thread/inject_items");
  assert.equal(injections.length, 2, "each canonical event must be injected exactly once across repeated polls");
  assert.deepEqual(injections.map((call) => (call.items?.[0] as any)?.role), ["user", "assistant"]);
  assert.equal(calls.filter((call) => call.method === "thread/resume").length, 1,
    "an idempotent retry with no new history must not claim another writer lease");
  assert.equal(calls.filter((call) => call.method === "thread/unsubscribe").length, 1,
    "the short-lived writer lease must be released after native history projection");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.desktopProjectionCursor, 4);
  assert.equal(state.desktopDeliveryCursor, 4, "native model history supersedes Hook-only delivery for these events");
  assert.equal(state.lastInjectedSequence, 2, "the background projection cursor must remain independent");
});

test("Desktop native history skips acknowledged local turns and queues while its turn is active", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-native-queue-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    localTurnBindings: {
      "codex:local": {
        localTurnId: "codex:local",
        threadId: "old-thread",
        turnId: "local-turn",
        basedOnSequence: 3,
        status: "acked",
        requestEventId: "event-4",
        responseEventId: "event-5",
      },
    },
  }));
  let status: "active" | "idle" = "active";
  const injected: string[] = [];
  let resumes = 0;
  const client = {
    readThread: async (threadId: string) => ({ id: threadId, name: null, status, turns: [] }),
    resumeThread: async () => { resumes += 1; },
    injectItems: async (_threadId: string, items: readonly any[]) => { injected.push(items[0].content[0].text); },
    unsubscribeThread: async () => undefined,
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });
  const runtime = registeredRuntime("desktop-native-queue");
  const events = [
    { ...canonical(3, "human_chat", { text: "remote before local" }, "user-2"), actorDisplayName: "Remote" },
    canonical(4, "agent_request", { text: "local request" }),
    canonical(5, "agent_response", { text: "local response" }),
    { ...canonical(6, "human_chat", { text: "remote after local" }, "user-2"), actorDisplayName: "Remote" },
  ];

  await assert.rejects(executor.projectCanonicalEvents(events, runtime), /active|queued/);
  assert.equal(resumes, 0);
  assert.deepEqual(injected, []);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).desktopProjectionCursor, undefined,
    "a busy Desktop task must retain the replay cursor for the next poll");

  status = "idle";
  await executor.projectCanonicalEvents(events, runtime);
  assert.equal(resumes, 1);
  assert.deepEqual(injected, [
    "Remote · Human Chat：remote before local",
    "Remote · Human Chat：remote after local",
  ]);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).desktopProjectionCursor, 6);
});

test("Desktop native history abandons its lease when a local turn starts during resume", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-native-resume-race-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  let status: "idle" | "active" = "idle";
  let injections = 0;
  let unsubscribes = 0;
  const client = {
    readThread: async (threadId: string) => ({ id: threadId, name: null, status, turns: [] }),
    resumeThread: async () => { status = "active"; },
    injectItems: async () => { injections += 1; },
    unsubscribeThread: async () => { unsubscribes += 1; },
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });

  await assert.rejects(
    executor.projectCanonicalEvents([
      { ...canonical(3, "human_chat", { text: "raced update" }, "user-2"), actorDisplayName: "Remote" },
    ], registeredRuntime("desktop-native-resume-race")),
    /active|queued/,
  );

  assert.equal(injections, 0, "a turn that wins the resume race must retain the visible thread writer");
  assert.equal(unsubscribes, 1, "the connector must release the short-lived subscription after losing the race");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).desktopProjectionCursor, undefined);
});

test("Desktop history polling advances across ACL-hidden canonical sequences", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-native-poll-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  const injected: string[] = [];
  const client = {
    readThread: async (threadId: string) => ({ id: threadId, name: null, status: "idle", turns: [] }),
    resumeThread: async () => undefined,
    injectItems: async (_threadId: string, items: readonly any[]) => { injected.push(items[0].content[0].text); },
    unsubscribeThread: async () => undefined,
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });
  const afterSequences: number[] = [];
  const api = {
    readEvents: async (_sessionId: string, afterSequence: number) => {
      afterSequences.push(afterSequence);
      return {
        events: afterSequence < 4
          ? [{ ...canonical(3, "human_chat", { text: "visible three" }, "user-2"), actorDisplayName: "Remote" }]
          : [],
        nextSequence: 4,
        hasMore: false,
      };
    },
  } as unknown as CollaborationApi;

  await executor.synchronizeCanonicalHistory(api, registeredRuntime("desktop-native-poll"));
  await executor.synchronizeCanonicalHistory(api, registeredRuntime("desktop-native-poll"));

  assert.deepEqual(afterSequences, [0, 4]);
  assert.deepEqual(injected, ["Remote · Human Chat：visible three"]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.desktopProjectionCursor, 4, "the hidden sequence must not cause a permanent replay gap");
  assert.equal(state.desktopDeliveryCursor, 4);
});

test("Desktop native history disables repeated polling after a resume timeout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-resume-timeout-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  let resumes = 0;
  let injections = 0;
  const client = {
    readThread: async (threadId: string) => ({ id: threadId, name: null, status: "idle", turns: [] }),
    resumeThread: async (input: { timeoutMs?: number }) => {
      resumes += 1;
      assert.equal(input.timeoutMs, 3_000, "visible history uses a short lease distinct from normal App Server requests");
      throw new Error("Codex App Server thread/resume request timed out");
    },
    injectItems: async () => { injections += 1; },
    unsubscribeThread: async () => undefined,
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });
  const api = {
    readEvents: async () => ({
      events: [{ ...canonical(3, "human_chat", { text: "remote delta" }, "user-2"), actorDisplayName: "Remote" }],
      nextSequence: 3,
      hasMore: false,
    }),
  } as unknown as CollaborationApi;

  await executor.synchronizeCanonicalHistory(api, registeredRuntime("desktop-resume-timeout"));
  await executor.synchronizeCanonicalHistory(api, registeredRuntime("desktop-resume-timeout"));

  assert.equal(resumes, 1, "a timed-out visible-thread lease must not stall every connector poll");
  assert.equal(injections, 0);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).desktopProjectionCursor ?? 0, 0,
    "trusted Hook delivery remains the fallback and native projection must not claim an undelivered event");
});

test("Desktop native history recovers an acknowledged injection without duplicating its stable item id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-native-recovery-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  const event = canonical(3, "human_chat", { text: "already persisted" }, "user-2");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    desktopProjectionCursor: 2,
    desktopProjectionJournal: { eventId: event.id, sequence: event.sequence, nextChunk: 0, totalChunks: 1 },
  }));
  const digest = createHash("sha256")
    .update(`${event.sessionId}\0${event.id}\0${event.sequence}\0${0}`)
    .digest("hex");
  const persistedItemId = `msg_gatherthread_${digest.slice(0, 40)}`;
  let injections = 0;
  let itemLists = 0;
  const client = {
    readThread: async (threadId: string) => ({ id: threadId, name: null, status: "idle", turns: [] }),
    resumeThread: async () => undefined,
    listThreadItemIds: async () => { itemLists += 1; return new Set([persistedItemId]); },
    injectItems: async () => { injections += 1; },
    unsubscribeThread: async () => undefined,
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    desktopHookOnly: true,
    gatherThreadSessionId: "session-1",
  });

  await executor.projectCanonicalEvents([event], registeredRuntime("desktop-native-recovery"));

  assert.equal(itemLists, 1);
  assert.equal(injections, 0, "a lost JSON-RPC acknowledgement must not duplicate the native history item");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.desktopProjectionCursor, 3);
  assert.equal(state.desktopProjectionJournal, undefined);
});

test("oversized Desktop cloud deltas advance only after acknowledged UTF-8 chunks", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-capsule-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
}
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
  });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Desktop capsule",
    model: "gpt-test",
    desktopHookOnly: true,
  });
  const runtime = registeredRuntime("desktop-capsule");
  const oversized = canonical(3, "human_chat", { text: `BEGIN-${"云".repeat(4_000)}-END` }, "user-2");
  const tail = canonical(4, "human_chat", { text: `tail update ${"t".repeat(4_000)}` }, "user-3");
  const committedBases: number[] = [];
  let commitSequence = 10;
  const api = {
    readEvents: async (_sessionId: string, afterSequence: number) => ({
      events: [oversized, tail].filter((event) => event.sequence > afterSequence),
      nextSequence: 4,
      hasMore: false,
    }),
    commitLocalTurn: async (_sessionId: string, input: { basedOnSequence: number; toolEvents: unknown[] }) => {
      committedBases.push(input.basedOnSequence);
      const requestSequence = commitSequence;
      const responseSequence = commitSequence + 1;
      commitSequence += 2;
      return {
        localTurnId: `local-${requestSequence}`,
        runtimeId: runtime.id,
        headBeforeCommit: 4,
        reconciliationRequired: true,
        requestEvent: canonical(requestSequence, "agent_request", { text: "desktop prompt" }),
        responseEvent: canonical(responseSequence, "agent_response", { text: "desktop answer" }),
        toolEvents: input.toolEvents,
      };
    },
  } as unknown as CollaborationApi;

  const submit = async (turnId: string) => executor.handleHookEvent(api, runtime, {
    hook_event_name: "UserPromptSubmit",
    session_id: "old-thread",
    turn_id: turnId,
    cwd: workspacePath,
    model: "gpt-test",
    prompt: `prompt ${turnId}`,
  });
  const stopAndCommit = async (turnId: string) => {
    await executor.handleHookEvent(api, runtime, {
      hook_event_name: "Stop",
      session_id: "old-thread",
      turn_id: turnId,
      cwd: workspacePath,
      model: "gpt-test",
      stop_hook_active: false,
      last_assistant_message: `answer ${turnId}`,
    });
    await executor.synchronizeLocalTurns(api, runtime);
  };

  const first = await submit("desktop-turn-1");
  assert.match(first.additionalContext ?? "", /sequence 3, part 1\//);
  assert.match(first.additionalContext ?? "", /do not repeat the exact context block/i);
  assert.ok(Buffer.byteLength(first.additionalContext ?? "") <= 7 * 1024);
  const visibleSummary = /--- BEGIN VISIBLE SYNC SUMMARY ---\n(?<summary>[\s\S]*?)\n--- END VISIBLE SYNC SUMMARY ---/u
    .exec(first.additionalContext ?? "")?.groups?.summary ?? "";
  assert.ok(Buffer.byteLength(visibleSummary) <= 1_024, "the user-visible relay summary must stay concise");
  assert.doesNotMatch(visibleSummary, /-END/, "the visible response must preview rather than repeat an oversized body");
  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "Stop",
    session_id: "old-thread",
    turn_id: "desktop-turn-1",
    cwd: workspacePath,
    model: "gpt-test",
    stop_hook_active: false,
    last_assistant_message: "",
  });
  const cancelledRetry = await submit("desktop-turn-1-retry");
  assert.match(cancelledRetry.additionalContext ?? "", /sequence 3, part 1\//,
    "a cancelled Desktop turn must not acknowledge its relay chunk");
  await stopAndCommit("desktop-turn-1-retry");
  const afterFirst = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(afterFirst.desktopDeliveryCursor, 2, "a partial event must not advance the delivered sequence");
  assert.equal(afterFirst.desktopRelayCheckpoint?.nextChunk, 1);
  assert.equal(committedBases[0], 2, "the local answer must not claim unseen cloud history as its context base");

  const second = await submit("desktop-turn-2");
  assert.match(second.additionalContext ?? "", /sequence 3, part 2\//);
  assert.doesNotMatch(second.additionalContext ?? "", /sequence 3, part 1\//);
  await stopAndCommit("desktop-turn-2");
  const afterSecond = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(afterSecond.desktopDeliveryCursor, 2);
  assert.equal(afterSecond.desktopRelayCheckpoint?.nextChunk, 2);

  const seenContexts = [first.additionalContext ?? "", second.additionalContext ?? ""];
  for (let turn = 3; turn <= 20; turn += 1) {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.desktopDeliveryCursor >= 4) break;
    const relay = await submit(`desktop-turn-${turn}`);
    seenContexts.push(relay.additionalContext ?? "");
    await stopAndCommit(`desktop-turn-${turn}`);
  }
  const finalState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(finalState.desktopDeliveryCursor, 4, "every oversized event chunk and its tail must eventually be acknowledged");
  assert.equal(finalState.desktopRelayCheckpoint, undefined);
  assert.equal(seenContexts.filter((context) => /sequence 3, part 1\//.test(context)).length, 1,
    "an acknowledged chunk must never be repeated");
  assert.match(seenContexts.join("\n"), /tail update/);
});

test("pre-capsule Desktop state replays canonical history from zero instead of trusting its cloud cursor", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-capsule-migration-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "desktop-state.json");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const legacy = projectionState(workspacePath) as Record<string, unknown>;
  delete legacy.desktopDeliveryCursor;
  legacy.cloudCursor = 99;
  await writeFile(statePath, JSON.stringify(legacy));
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fakeCodex], cwd: directory });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Desktop capsule migration",
    model: "gpt-test",
    desktopHookOnly: true,
  });
  let observedAfter = -1;
  const api = {
    readEvents: async (_sessionId: string, afterSequence: number) => {
      observedAfter = afterSequence;
      return { events: [canonical(1, "human_chat", { text: "recovered history" })], nextSequence: 1, hasMore: false };
    },
  } as unknown as CollaborationApi;
  const relay = await executor.handleHookEvent(api, registeredRuntime("desktop-migration"), {
    hook_event_name: "UserPromptSubmit",
    session_id: "old-thread",
    turn_id: "desktop-turn-migration",
    cwd: workspacePath,
    model: "gpt-test",
    prompt: "continue",
  });
  assert.equal(observedAfter, 0);
  assert.match(relay.additionalContext ?? "", /recovered history/);
});

test("project harness keeps Desktop hooks and Web execution on separate native writers", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-dual-projection-"));
  const workspacePath = await realpath(directory);
  const stateRoot = path.join(directory, "state");
  const desktopStatePath = path.join(stateRoot, "binding-session.json");
  const registryPath = path.join(stateRoot, "hook-registry.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(desktopStatePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/start") respond(message.id, { thread: { id: message.params.threadSource === "exec" ? "background-thread" : "desktop-thread" } });
  else if (message.method === "thread/read" && message.params.threadId === "old-thread") fail(message.id, "thread old-thread already has an active writer");
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
function fail(id, message) { process.stdout.write(JSON.stringify({ id, error: { code: -32000, message } }) + "\\n"); }
`);
  const harness = new CodexProjectHarness({
    workspacePath,
    stateRoot,
    mappingId: "mapping-dual",
    projectName: "Dual",
    model: "gpt-test",
    command: process.execPath,
    commandArgs: [fakeCodex],
    env: { ...process.env, CAPTURE: capturePath },
    hookRegistryPath: registryPath,
    localTurnsEnabled: true,
  });
  t.after(() => harness.close());
  const binding = harness.createSessionBinding({
    session: { id: "session-1", projectId: "project-1", name: "Session", mode: "multi" },
    sessionKey: "binding",
    statePath: desktopStatePath,
  });
  const runtime = registeredRuntime(binding.localSessionId);
  assert.equal(await binding.executor.prepareCanonicalProjection?.(runtime), 0);
  await binding.activateLocalPublishing?.();

  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const starts = captures.filter((message) => message.method === "thread/start");
  assert.deepEqual(starts.map((message) => message.params.threadSource), ["exec"]);
  assert.equal(captures.some((message) => message.method === "thread/read" && message.params.threadId === "old-thread"), false);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.threads["old-thread"], "execution");
  assert.equal(registry.threads["background-thread"], "background_execution");
  assert.ok(binding.relayLocalHarnessEvent, "trusted Desktop hooks must be routed to the Desktop projection");
});

test("project harness polling projects canonical deltas into its visible Desktop binding", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-project-visible-poll-"));
  const workspacePath = await realpath(directory);
  const stateRoot = path.join(directory, "state");
  const desktopStatePath = path.join(stateRoot, "binding-session.json");
  const registryPath = path.join(stateRoot, "hook-registry.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(desktopStatePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: message.params.threadId, name: "Session · GatherThread", status: { type: "idle" }, turns: [],
  } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: message.params.threadId } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const harness = new CodexProjectHarness({
    workspacePath,
    stateRoot,
    mappingId: "mapping-visible-poll",
    projectName: "Visible poll",
    model: "gpt-test",
    command: process.execPath,
    commandArgs: [fakeCodex],
    env: { ...process.env, CAPTURE: capturePath },
    hookRegistryPath: registryPath,
    localTurnsEnabled: true,
  });
  t.after(() => harness.close());
  const binding = harness.createSessionBinding({
    session: { id: "session-1", projectId: "project-1", name: "Session", mode: "multi" },
    sessionKey: "binding",
    statePath: desktopStatePath,
  });
  const api = {
    readEvents: async () => ({
      events: [{ ...canonical(3, "human_chat", { text: "live delta" }, "user-2"), actorDisplayName: "Remote" }],
      nextSequence: 3,
      hasMore: false,
    }),
  } as unknown as CollaborationApi;

  assert.ok(binding.synchronizeLocalTurns);
  assert.ok(binding.synchronizeCanonicalHistory);
  const runtime = registeredRuntime(binding.localSessionId);
  await binding.synchronizeLocalTurns({ api, runtime });
  await binding.synchronizeCanonicalHistory({ api, runtime });

  const captures = (await readFile(capturePath, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "thread/inject_items").length, 1);
  assert.ok(captures.some((message) => message.method === "thread/unsubscribe"));
  assert.equal(JSON.parse(await readFile(desktopStatePath, "utf8")).desktopProjectionCursor, 3);
});

test("canonical projection uses type-specific visible prefixes and only canonical response provenance", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-prefixes-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capture = process.env.CAPTURE;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  appendFileSync(capture, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "prefix-thread" } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath: directory,
    statePath,
    threadName: "GatherThread · Prefixes",
    model: "local-model-must-not-leak",
  });
  const runtime = registeredRuntime("prefix-thread");
  const canonicalRuntime: NonNullable<CanonicalEvent["runtime"]> = {
    ...runtimeProvenance(runtime),
    runtimeId: "remote-runtime",
    harness: "claude-code",
    model: "canonical-model",
  };
  const visible = (event: CanonicalEvent): CanonicalEvent => ({ ...event, actorDisplayName: "Alice" });
  const events: CanonicalEvent[] = [
    visible({ ...canonical(1, "human_chat", { text: "hello" }), runtime: canonicalRuntime }),
    visible({ ...canonical(2, "agent_request", { text: "do work" }), runtime: canonicalRuntime }),
    visible({ ...canonical(3, "agent_response", { text: "done" }), runtime: canonicalRuntime }),
    visible(canonical(4, "agent_response", { text: "missing provenance" })),
    visible({ ...canonical(5, "tool_call", { tool_name: "shell" }), runtime: canonicalRuntime }),
    visible({ ...canonical(6, "tool_result", { result: "ok" }), runtime: canonicalRuntime }),
    visible(canonical(7, "attachment", { name: "notes.txt" })),
    visible(canonical(8, "context_snapshot", { summary: "state" })),
    visible(canonical(9, "membership_change", { role: "viewer" })),
    visible(canonical(10, "session_state_change", { state: "archived" })),
  ];

  await executor.projectCanonicalEvents(events, runtime);

  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const injected = captures
    .filter((message) => message.method === "thread/inject_items")
    .map((message) => message.params.items[0]);
  assert.deepEqual(injected.map((item) => item.content[0].text), [
    "Alice · Human Chat：hello",
    "Alice · Agent Request：do work",
    "Alice · Agent Response · claude-code · canonical-model：done",
    "Alice · Agent Response · GatherThread · shared：missing provenance",
    'Alice · Tool Call：{"tool_name":"shell"}',
    'Alice · Tool Result：{"result":"ok"}',
    'Alice · Attachment：{"name":"notes.txt"}',
    'Alice · Context Snapshot：{"summary":"state"}',
    'Alice · Membership Change：{"role":"viewer"}',
    'Alice · Session State Change：{"state":"archived"}',
  ]);
  assert.deepEqual(injected.map((item) => item.role), [
    "user", "user", "assistant", "assistant", "assistant",
    "assistant", "assistant", "assistant", "assistant", "assistant",
  ]);
  assert.doesNotMatch(injected[1].content[0].text, /local-model-must-not-leak|canonical-model|claude-code/);
});

test("each top-level projection releases its App Server writer before connector idle", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-short-writer-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "lifecycle.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const existingState = { ...projectionState(workspacePath), connectorTurnIds: ["visible-turn"] };
  await writeFile(statePath, JSON.stringify(existingState));
  await writeFile(fakeCodex, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capture = process.env.CAPTURE;
appendFileSync(capture, JSON.stringify({ event: "start", pid: process.pid }) + "\\n");
process.on("SIGTERM", () => {
  appendFileSync(capture, JSON.stringify({ event: "stop", pid: process.pid }) + "\\n");
  process.exit(0);
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: "old-thread", name: "GatherThread · Project · Session", status: { type: "idle" }, turns: [],
  } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "old-thread" } });
  else if (message.method === "thread/name/set" || message.method === "thread/unsubscribe") respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: workspacePath,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  const revealed: string[] = [];
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Project · Session",
    model: "gpt-test",
    revealThread: async (threadId) => {
      const lifecycle = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const writerPid = lifecycle.filter((event) => event.event === "start").at(-1)?.pid;
      assert.equal(typeof writerPid, "number");
      assert.throws(
        () => process.kill(writerPid, 0),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
        "Desktop reveal must happen only after the App Server writer exits",
      );
      revealed.push(threadId);
      return true;
    },
  });
  const runtime = registeredRuntime("managed-binding");

  assert.equal(await executor.prepareCanonicalProjection(runtime), 2);
  let lifecycle = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    lifecycle.map((event) => event.event),
    process.platform === "win32" ? ["start"] : ["start", "stop"],
  );
  assert.deepEqual(revealed, ["old-thread"]);
  assert.equal(await executor.prepareCanonicalProjection(runtime), 2);
  lifecycle = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    lifecycle.map((event) => event.event),
    process.platform === "win32" ? ["start", "start"] : ["start", "stop", "start", "stop"],
  );
  assert.deepEqual(revealed, ["old-thread"], "a revealed native task must not steal focus on every poll");
  const starts = lifecycle.filter((event) => event.event === "start");
  assert.notEqual(starts[0]?.pid, starts[1]?.pid, "a later operation must use a fresh App Server process");
});

test("concurrent close is single-flight, restart waits for exit, and dispose is terminal", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-close-flight-"));
  const capturePath = path.join(directory, "lifecycle.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capture = process.env.CAPTURE;
appendFileSync(capture, JSON.stringify({ event: "start", pid: process.pid }) + "\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  appendFileSync(capture, JSON.stringify({ event: "request", pid: process.pid, method: message.method }) + "\\n");
  respond(message.id, message.method === "initialize" ? {} : { ok: true });
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const abort = new AbortController();
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
    signal: abort.signal,
  });
  t.after(() => client.dispose());
  await client.start();
  const firstPid = JSON.parse((await readFile(capturePath, "utf8")).trim().split("\n")[0] as string).pid;

  const firstClose = client.close();
  const concurrentClose = client.close();
  assert.equal(firstClose, concurrentClose, "concurrent close callers must share the exact lifecycle promise");
  const immediateRequest = client.request("test/ping", {});
  await Promise.all([firstClose, concurrentClose, immediateRequest]);
  const lifecycle = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const starts = lifecycle.filter((event) => event.event === "start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[1]?.pid, firstPid);
  const ping = lifecycle.find((event) => event.method === "test/ping");
  assert.equal(ping?.pid, starts[1]?.pid, "the immediate request must run only in the post-close child");

  const firstDispose = client.dispose();
  const concurrentDispose = client.dispose();
  assert.equal(firstDispose, concurrentDispose, "dispose must also be single-flight");
  await firstDispose;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  await assert.rejects(client.start(), /disposed/);
  await assert.rejects(client.request("test/ping", {}), /disposed/);
  const finalStarts = (await readFile(capturePath, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line)).filter((event) => event.event === "start");
  assert.equal(finalStarts.length, 2, "disposed clients must never spawn another child");
});

test("a timed-out thread start recycles the shared App Server before the next retry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-thread-start-timeout-"));
  const capturePath = path.join(directory, "capture.jsonl");
  const generationPath = path.join(directory, "first-generation-seen");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capture = process.env.CAPTURE;
const generation = process.env.GENERATION;
const staleGeneration = !existsSync(generation);
appendFileSync(capture, JSON.stringify({ event: "start", pid: process.pid, staleGeneration }) + "\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  appendFileSync(capture, JSON.stringify({ event: "request", pid: process.pid, method: message.method }) + "\\n");
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/start" && staleGeneration) writeFileSync(generation, "seen");
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "recovered-thread" } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath, GENERATION: generationPath },
    requestTimeoutMs: 1_000,
    threadStartTimeoutMs: 250,
  });
  t.after(() => client.dispose());

  await assert.rejects(
    client.startThread({ cwd: directory, model: "gpt-test", sandbox: "workspace-write", threadSource: "exec" }),
    /thread\/start request timed out/,
  );
  assert.equal(
    await client.startThread({ cwd: directory, model: "gpt-test", sandbox: "workspace-write", threadSource: "exec" }),
    "recovered-thread",
    "the persistent project client must not reuse the generation that stopped answering",
  );

  const lifecycle = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const starts = lifecycle.filter((event) => event.event === "start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]?.pid, starts[1]?.pid);
});

test("project discovery falls back cleanly when an older App Server lacks project/list", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-old-project-api-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "project/list") fail(message.id, -32601, "Method not found");
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ id, error: { code, message } }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
  });
  t.after(() => client.dispose());

  assert.equal(await client.findProjectIdForRoot(directory), undefined);
});

test("recycling a shared App Server invalidates other sessions' ephemeral thread leases", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-shared-timeout-"));
  const workspacePath = await realpath(directory);
  const capturePath = path.join(directory, "capture.jsonl");
  const generationPath = path.join(directory, "generation");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capture = process.env.CAPTURE;
const generationPath = process.env.GENERATION;
const generation = existsSync(generationPath) ? 2 : 1;
if (generation === 1) writeFileSync(generationPath, "started");
let threadStarts = 0;
appendFileSync(capture, JSON.stringify({ event: "start", pid: process.pid, generation }) + "\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  appendFileSync(capture, JSON.stringify({ event: "request", pid: process.pid, generation, method: message.method, threadId: message.params?.threadId }) + "\\n");
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/start" && generation === 1 && threadStarts++ === 0) {
    respond(message.id, { thread: { id: "old-thread" } });
  } else if (message.method === "thread/start" && generation === 1) {
    // Leave the second session's creation indeterminate to force recycling.
  } else if (message.method === "thread/start") {
    respond(message.id, { thread: { id: "replacement-thread" } });
  } else if (message.method === "thread/inject_items" && message.params.threadId !== "replacement-thread") {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: "unknown thread in this process" } }) + "\\n");
  } else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath, GENERATION: generationPath },
    // This test targets lease invalidation after a deliberate thread/start
    // timeout. Give process initialization enough headroom when the full test
    // suite is concurrently spawning many child processes.
    requestTimeoutMs: 5_000,
    threadStartTimeoutMs: 250,
  });
  t.after(() => client.dispose());
  const survivor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath: path.join(directory, "survivor.json"),
    threadName: "Survivor background",
    model: "gpt-test",
    threadSource: "exec",
  });
  const stalled = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath: path.join(directory, "stalled.json"),
    threadName: "Stalled background",
    model: "gpt-test",
    threadSource: "exec",
  });
  const survivorRuntime = registeredRuntime("survivor-session");

  assert.equal(await survivor.prepareCanonicalProjection(survivorRuntime), 0);
  await assert.rejects(stalled.prepareCanonicalProjection(registeredRuntime("stalled-session")), /thread\/start request timed out/);
  await survivor.projectCanonicalEvents([
    { ...canonical(1, "human_chat", { text: "after recycle" }, "user-2"), sessionId: survivorRuntime.sessionId },
  ], survivorRuntime);

  const survivorState = JSON.parse(await readFile(path.join(directory, "survivor.json"), "utf8"));
  assert.equal(survivorState.threadId, "replacement-thread");
  assert.equal(survivorState.projectionGeneration, 2);
  const lifecycle = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lifecycle.some((event) => event.method === "thread/inject_items" && event.threadId === "replacement-thread"));
  assert.equal(lifecycle.some((event) => event.method === "thread/inject_items" && event.threadId === "old-thread"), false);
});

test("native compaction rejects failed, interrupted and terminal error races without waiting for timeout", async (t) => {
  for (const failure of ["failed", "interrupted", "error"]) {
    const directory = await mkdtemp(path.join(tmpdir(), "gt-compact-native-failure-"));
    const fakeCodex = path.join(directory, "fake.mjs");
    await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method !== "thread/compact/start") { send({ id: message.id, result: {} }); continue; }
  send({ method: "item/started", params: { threadId: "thread-1", turnId: "compact-turn", item: { type: "contextCompaction" } } });
  if (process.env.FAILURE === "error") send({ method: "error", params: {
    threadId: "thread-1", turnId: "compact-turn", willRetry: false, error: { message: "native compact rejected" },
  } });
  else send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-turn", status: process.env.FAILURE } } });
  // The completion precedes the start-RPC reply, as in a fast native failure.
  setTimeout(() => send({ id: message.id, result: {} }), 20);
}
`);
    const client = new CodexAppServerClient({
      command: process.execPath, commandArgs: [fakeCodex], cwd: directory,
      env: { ...process.env, FAILURE: failure }, turnTimeoutMs: 300,
    });
    t.after(() => client.dispose());
    await assert.rejects(client.compactThread("thread-1"), failure === "error" ? /native compact rejected/ : new RegExp(failure));
  }
});

test("native compaction terminal failure does not wait for a missing start RPC reply", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gt-compact-missing-ack-"));
  const fakeCodex = path.join(directory, "fake.mjs");
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method === "thread/compact/start") {
    process.stdout.write(JSON.stringify({ method: "error", params: {
      threadId: "thread-1", turnId: "compact-turn", willRetry: false, error: { message: "terminal native failure without RPC ack" },
    } }) + "\\n");
  } else process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
}
`);
  const client = new CodexAppServerClient({
    command: process.execPath, commandArgs: [fakeCodex], cwd: directory,
    requestTimeoutMs: 250, turnTimeoutMs: 300,
  });
  t.after(() => client.dispose());
  await assert.rejects(client.compactThread("thread-1"), /terminal native failure without RPC ack/);
});

test("native compaction ignores unrelated and retryable errors and accepts completion before the RPC reply", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gt-compact-native-success-"));
  const fakeCodex = path.join(directory, "fake.mjs");
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method === "thread/compact/start") {
    send({ method: "item/started", params: { threadId: "thread-1", turnId: "compact-turn", item: { type: "contextCompaction" } } });
    for (const params of [
      { threadId: "other-thread", turnId: "compact-turn", willRetry: false },
      { threadId: "thread-1", turnId: "other-turn", willRetry: false },
      { threadId: "thread-1", turnId: "compact-turn", willRetry: true },
    ]) send({ method: "error", params: { ...params, error: { message: "must ignore" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "compact-turn", item: { type: "contextCompaction" } } });
  }
  send({ id: message.id, result: {} });
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fakeCodex], cwd: directory, turnTimeoutMs: 300 });
  t.after(() => client.dispose());
  await client.compactThread("thread-1");
});

test("close during pending turn and compact starts rejects cleanly without unhandled completions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-close-pending-"));
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, pendingOperationFakeCodex());
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const turn = client.runTurn({
      threadId: "thread-1",
      prompt: "pending",
      clientUserMessageId: "pending-turn",
    });
    await waitForCapturedMethod(capturePath, "turn/start", 1);
    await Promise.all([
      assert.rejects(turn, /closing/),
      client.close(),
    ]);

    const compact = client.compactThread("thread-1");
    await waitForCapturedMethod(capturePath, "thread/compact/start", 1);
    await Promise.all([
      assert.rejects(compact, /closing/),
      client.close(),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await client.dispose();
  }
});

test("abort during pending turn and compact starts is terminal without unhandled completions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-abort-pending-"));
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, pendingOperationFakeCodex());
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const [index, method] of ["turn/start", "thread/compact/start"].entries()) {
      const abort = new AbortController();
      const client = new CodexAppServerClient({
        command: process.execPath,
        commandArgs: [fakeCodex],
        cwd: directory,
        env: { ...process.env, CAPTURE: capturePath },
        signal: abort.signal,
      });
      const operation = method === "turn/start"
        ? client.runTurn({ threadId: "thread-1", prompt: "pending", clientUserMessageId: `pending-${index}` })
        : client.compactThread("thread-1");
      await waitForCapturedMethod(capturePath, method, 1);
      abort.abort();
      await assert.rejects(operation, /aborted/);
      await client.dispose();
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      await assert.rejects(client.start(), /disposed/);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("opening a Desktop project preserves the existing thread and execution journal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-reveal-generation-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    threadId: "pre-reveal-thread",
    threadName: "GatherThread · Project · Old name",
    desktopProjectGeneration: 0,
    cloudCursor: 3,
    coveredThroughSequence: 3,
    lastInjectedSequence: 3,
    executionJournal: {
      "event-2": {
        requestId: "event-2",
        status: "completed",
        turnId: "completed-before-reveal",
        events: [{
          kind: "assistant",
          localEventId: "completed-answer",
          harness: "codex",
          captureFidelity: "harness_transcript",
          content: "cached completed answer",
        }],
      },
      "event-4": {
        requestId: "event-4",
        status: "failed",
        turnId: "failed-before-reveal",
        failure: { code: "codex_turn_failed", message: "cached bounded failure" },
      },
    },
  }));
  const calls: Array<{ method: string; threadId?: string; name?: string }> = [];
  const fakeClient = {
    startThread: async () => {
      calls.push({ method: "thread/start" });
      return "must-not-start";
    },
    readThread: async (threadId: string) => {
      calls.push({ method: "thread/read", threadId });
      return { id: threadId, status: "idle", turns: [] };
    },
    resumeThread: async ({ threadId }: { threadId: string }) => {
      calls.push({ method: "thread/resume", threadId });
    },
    setThreadName: async (threadId: string, name: string) => {
      calls.push({ method: "thread/name/set", threadId, name });
    },
    archiveThread: async (threadId: string) => {
      calls.push({ method: "thread/archive", threadId });
    },
    unsubscribeThread: async (threadId: string) => {
      calls.push({ method: "thread/unsubscribe", threadId });
    },
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client: fakeClient,
    workspacePath,
    statePath,
    threadName: "GatherThread · Project · Session",
    model: "gpt-test",
  });
  const runtime = registeredRuntime("managed-binding");

  assert.equal(await executor.prepareCanonicalProjection(runtime), 3);
  const preservedState = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(Object.keys(preservedState.executionJournal), ["event-2", "event-4"]);
  const completed = await executor.execute({
    request: canonical(2, "agent_request", { text: "two" }),
    canonicalHistory: [],
    runtime,
  });
  assert.equal(completed.events.at(-1)?.content, "cached completed answer");
  await assert.rejects(executor.execute({
    request: canonical(4, "agent_request", { text: "four" }),
    canonicalHistory: [],
    runtime,
  }), (error: unknown) => error instanceof HarnessExecutionTerminatedError && error.failureCode === "codex_turn_failed");
  assert.equal(await executor.prepareCanonicalProjection(runtime), 3);
  await executor.renameThread("GatherThread · Project · Renamed");

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "pre-reveal-thread");
  assert.equal(state.desktopProjectGeneration, 0);
  assert.equal(state.lastInjectedSequence, 3);
  assert.deepEqual(Object.keys(state.executionJournal), ["event-2", "event-4"]);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 0, "Desktop reveal must not create a replacement thread");
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 0, "Desktop reveal must not execute a canonical request");
  assert.equal(calls.filter((call) => call.method === "thread/archive").length, 0, "Desktop reveal must not archive a user thread");
  assert.equal(calls.at(-1)?.method, "thread/name/set");
  assert.deepEqual(calls.at(-1), {
    method: "thread/name/set",
    threadId: "pre-reveal-thread",
    name: "GatherThread · Project · Renamed",
  });
});

test("legacy post-switch migration keeps both threads while retiring the inactive hook authorization", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-migration-cleanup-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    threadId: "post-reveal-thread",
    desktopProjectGeneration: 1,
    desktopProjectMigration: {
      oldThreadId: "pre-reveal-thread",
      candidateThreadId: "post-reveal-thread",
      targetGeneration: 1,
      phase: "binding_switched",
    },
  }));
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    workspacePath,
    threads: {
      "pre-reveal-thread": "execution",
      "post-reveal-thread": "execution",
    },
  }));
  const calls: Array<{ method: string; threadId?: string }> = [];
  const fakeClient = {
    startThread: async () => { calls.push({ method: "thread/start" }); return "must-not-start"; },
    readThread: async (threadId: string) => ({ id: threadId, name: null, status: "idle", turns: [] }),
    resumeThread: async ({ threadId }: { threadId: string }) => { calls.push({ method: "thread/resume", threadId }); },
    setThreadName: async (threadId: string) => { calls.push({ method: "thread/name/set", threadId }); },
    archiveThread: async (threadId: string) => { calls.push({ method: "thread/archive", threadId }); },
    unsubscribeThread: async (threadId: string) => { calls.push({ method: "thread/unsubscribe", threadId }); },
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client: fakeClient,
    workspacePath,
    statePath,
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
    threadName: "GatherThread · Project · Session",
    model: "gpt-test",
  });
  assert.equal(await executor.prepareCanonicalProjection(registeredRuntime("managed-binding")), 2);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 0);
  assert.equal(calls.filter((call) => call.method === "thread/archive").length, 0);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.threads["pre-reveal-thread"], "local_only");
  assert.equal(registry.threads["post-reveal-thread"], "execution");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "post-reveal-thread");
  assert.deepEqual(state.localOnlyThreadIds, ["pre-reveal-thread"]);
  assert.equal(state.desktopProjectMigration, undefined);
});

test("legacy pre-switch migration keeps the original binding and does not restart its candidate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-migration-pre-switch-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    threadId: "original-thread",
    desktopProjectMigration: {
      oldThreadId: "original-thread",
      candidateThreadId: "unused-candidate-thread",
      targetGeneration: 1,
      phase: "candidate_started",
    },
  }));
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    workspacePath,
    threads: {
      "original-thread": "execution",
      "unused-candidate-thread": "execution",
    },
  }));
  const calls: Array<{ method: string; threadId?: string }> = [];
  const fakeClient = {
    startThread: async () => { calls.push({ method: "thread/start" }); return "must-not-start"; },
    readThread: async (threadId: string) => ({ id: threadId, name: null, status: "idle", turns: [] }),
    resumeThread: async ({ threadId }: { threadId: string }) => { calls.push({ method: "thread/resume", threadId }); },
    setThreadName: async (threadId: string) => { calls.push({ method: "thread/name/set", threadId }); },
    archiveThread: async (threadId: string) => { calls.push({ method: "thread/archive", threadId }); },
    unsubscribeThread: async (threadId: string) => { calls.push({ method: "thread/unsubscribe", threadId }); },
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client: fakeClient,
    workspacePath,
    statePath,
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
    threadName: "GatherThread · Project · Session",
    model: "gpt-test",
  });

  assert.equal(await executor.prepareCanonicalProjection(registeredRuntime("managed-binding")), 2);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 0);
  assert.equal(calls.filter((call) => call.method === "thread/archive").length, 0);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.threads["original-thread"], "execution");
  assert.equal(registry.threads["unused-candidate-thread"], "local_only");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "original-thread");
  assert.deepEqual(state.localOnlyThreadIds, ["unused-candidate-thread"]);
  assert.equal(state.desktopProjectMigration, undefined);
});

test("hook drafts lock projection, clear on cancelled Stop, and publish exact completed tools", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-binding-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: "old-thread", name: "Desktop Local Name", status: { type: "idle" }, turns: [{
      id: "hook-turn-tools", status: "completed", startedAt: 1787676000, completedAt: 1787676001,
      items: [
        { type: "userMessage", id: "u", clientId: "desktop-tools", content: [{ type: "text", text: "run exact tests" }] },
        { type: "commandExecution", id: "cmd", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "all passed" },
        { type: "agentMessage", id: "a", phase: "final_answer", text: "tests passed" },
      ],
    }],
  } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "old-thread" } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  assert.equal((await client.readThread("old-thread")).name, "Desktop Local Name");
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · hooks",
    model: "gpt-test",
  });
  const runtime = registeredRuntime("old-thread");
  const delta = canonical(3, "human_chat", { content: "cloud delta" }, "user-2");
  const api = {
    readEvents: async (_sessionId: string, after: number) => ({
      events: after < 3 ? [delta] : [],
      nextSequence: 3,
      hasMore: false,
    }),
  } as unknown as CollaborationApi;
  const prompt = await executor.handleHookEvent(api, runtime, {
    hook_event_name: "UserPromptSubmit",
    session_id: "old-thread",
    turn_id: "hook-turn-cancelled",
    cwd: workspacePath,
    model: "gpt-test",
    prompt: "local draft",
  });
  assert.match(prompt.additionalContext ?? "", /sequence 3.*cloud delta/s);
  let state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.hookDrafts["hook-turn-cancelled"].basedOnSequence, 3, "hook turns bind to the authoritative context coverage they receive");
  await assert.rejects(executor.projectCanonicalEvents([delta], runtime), /desktop turn is active/);
  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "Stop",
    session_id: "old-thread",
    turn_id: "hook-turn-cancelled",
    cwd: workspacePath,
    model: "gpt-test",
    stop_hook_active: false,
    last_assistant_message: null,
  });
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.hookDrafts["hook-turn-cancelled"], undefined);
  await executor.projectCanonicalEvents([delta], runtime);

  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "UserPromptSubmit",
    session_id: "old-thread",
    turn_id: "hook-turn-tools",
    cwd: workspacePath,
    model: "gpt-test",
    prompt: "run exact tests",
  });
  await executor.handleHookEvent(api, runtime, {
    hook_event_name: "Stop",
    session_id: "old-thread",
    turn_id: "hook-turn-tools",
    cwd: workspacePath,
    model: "gpt-test",
    stop_hook_active: false,
    last_assistant_message: "tests passed",
  });
  const committed: Array<{ basedOnSequence: number; observedModel?: string; observedReasoningEffort?: string; toolEvents?: readonly unknown[] }> = [];
  const localApi = {
    commitLocalTurn: async (_sessionId: string, input: { basedOnSequence: number; toolEvents?: readonly unknown[] }) => {
      committed.push(input);
      return {
        localTurnId: "local",
        runtimeId: runtime.id,
        headBeforeCommit: 3,
        reconciliationRequired: false,
        requestEvent: canonical(4, "agent_request", { content: "run exact tests" }),
        responseEvent: canonical(5, "agent_response", { text: "tests passed" }),
        toolEvents: [],
      };
    },
  } as unknown as CollaborationApi;
  await executor.synchronizeLocalTurns(localApi, runtime);
  assert.equal(committed.length, 1);
  assert.equal(committed[0]?.basedOnSequence, 3);
  assert.equal(committed[0]?.observedModel, "gpt-test");
  assert.deepEqual((committed[0]?.toolEvents as Array<{ type: string }>).map((event) => event.type), ["tool_call", "tool_result"]);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "thread/inject_items").length, 1);
});

test("offline hook replay keeps an unknown base and rebuilds after cloud history advanced", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-offline-base-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: message.params.threadId, status: { type: "idle" }, turns: message.params.threadId === "old-thread" ? [{
      id: "offline-turn", status: "completed", startedAt: 1, completedAt: 2, items: [
        { type: "userMessage", id: "u", clientId: "offline-client", content: [{ type: "text", text: "offline question" }] },
        { type: "agentMessage", id: "a", phase: "final_answer", text: "offline answer" },
      ],
    }] : [],
  } });
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "rebuilt-offline-thread" } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: message.params.threadId } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · offline replay",
    model: "gpt-test",
  });
  const runtime = registeredRuntime("old-thread");
  const cloudEvents = [
    canonical(3, "human_chat", { content: "cloud three" }, "user-2"),
    canonical(4, "human_chat", { content: "cloud four" }, "user-2"),
    canonical(5, "agent_response", { text: "cloud five" }, "user-2"),
  ];
  await executor.projectCanonicalEvents(cloudEvents, runtime);
  await executor.handleHookEvent({} as CollaborationApi, runtime, {
    hook_event_name: "UserPromptSubmit", session_id: "old-thread", turn_id: "offline-turn",
    cwd: workspacePath, model: "gpt-test", prompt: "offline question",
  }, true);
  await executor.handleHookEvent({} as CollaborationApi, runtime, {
    hook_event_name: "Stop", session_id: "old-thread", turn_id: "offline-turn",
    cwd: workspacePath, model: "gpt-test", stop_hook_active: false, last_assistant_message: "offline answer",
  }, true);
  const canonicalHistory = [
    canonical(1, "human_chat", { content: "one" }, "user-2"),
    canonical(2, "agent_response", { text: "two" }, "user-2"),
    ...cloudEvents,
    canonical(6, "agent_request", { content: "offline question" }),
    canonical(7, "agent_response", { text: "offline answer" }),
  ];
  let basedOnSequence = -1;
  const api = {
    commitLocalTurn: async (_sessionId: string, input: { basedOnSequence: number }) => {
      basedOnSequence = input.basedOnSequence;
      return {
        localTurnId: "offline", runtimeId: runtime.id, headBeforeCommit: 5, reconciliationRequired: true,
        requestEvent: canonicalHistory[5], responseEvent: canonicalHistory[6], toolEvents: [],
      };
    },
    readEvents: async () => ({ events: canonicalHistory, nextSequence: 7, hasMore: false }),
  } as unknown as CollaborationApi;
  await executor.synchronizeLocalTurns(api, runtime);
  assert.equal(basedOnSequence, 0);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "rebuilt-offline-thread");
  assert.equal(state.coveredThroughSequence, 7);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(captures.some((message) => message.method === "thread/archive" && message.params.threadId === "old-thread"));
});

test("local-turn upload bounds UTF-8 payloads and tool count below the server request ceiling", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-local-budget-"));
  const statePath = path.join(directory, "state.json");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  const state = projectionState(workspacePath) as Record<string, any>;
  state.localTurnBindings = {
    local: { localTurnId: "local", threadId: "old-thread", turnId: "turn-large", basedOnSequence: 2, status: "pending" },
  };
  state.pendingLocalTurns = [{
    localTurnId: "local", threadId: "old-thread", turnId: "turn-large", basedOnSequence: 2,
    occurredAt: "2026-08-25T00:00:00.000Z",
    requestPayload: { text: "问".repeat(80_000) },
    responsePayload: { text: "答🙂".repeat(120_000) },
    toolEvents: Array.from({ length: 40 }, (_, index) => ({
      type: index % 2 === 0 ? "tool_call" : "tool_result",
      payload: { text: `tool-${index}-` + "数".repeat(4_000) },
    })),
  }];
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: { id: "old-thread", status: { type: "idle" }, turns: [] } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fakeCodex], cwd: directory });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({ client, workspacePath, statePath, threadName: "GatherThread · budget", model: "gpt-test" });
  let upload: any;
  const api = {
    commitLocalTurn: async (_sessionId: string, input: unknown) => {
      upload = input;
      return {
        localTurnId: "local", runtimeId: "runtime-1", headBeforeCommit: 2, reconciliationRequired: false,
        requestEvent: canonical(3, "agent_request", { text: "bounded" }),
        responseEvent: canonical(4, "agent_response", { text: "bounded" }), toolEvents: [],
      };
    },
  } as unknown as CollaborationApi;
  await executor.synchronizeLocalTurns(api, registeredRuntime("old-thread"));
  assert.ok(Buffer.byteLength(JSON.stringify(upload)) < 192 * 1024);
  assert.equal(upload.toolEvents.length, 32);
  assert.equal(upload.requestPayload.truncated, true);
  assert.equal(upload.responsePayload.truncated, true);
  assert.doesNotThrow(() => Buffer.from(JSON.stringify(upload), "utf8").toString("utf8"));
});

test("UTF-8 projection chunking never exceeds the byte budget", () => {
  const chunks = splitUtf8("甲乙丙丁🙂abcdef", 7);
  assert.equal(chunks.join(""), "甲乙丙丁🙂abcdef");
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 7));
});

test("permission downgrade revokes hooks and makes uncommitted local turns permanently local-only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-deactivate-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  const pendingState = {
    ...projectionState(workspacePath),
    contextUsageSource: "fallback_estimate",
    hookDrafts: {
      "draft-turn": {
        localTurnId: "codex:draft",
        threadId: "old-thread",
        turnId: "draft-turn",
        basedOnSequence: 2,
        occurredAt: "2026-08-25T00:00:00.000Z",
        requestPayload: { text: "must remain local" },
      },
    },
    pendingLocalTurns: [{
      localTurnId: "codex:pending",
      threadId: "old-thread",
      turnId: "pending-turn",
      basedOnSequence: 2,
      occurredAt: "2026-08-25T00:00:00.000Z",
      requestPayload: { text: "offline request" },
      responsePayload: { text: "offline response" },
      toolEvents: [],
    }],
    localTurnBindings: {
      "codex:draft": {
        localTurnId: "codex:draft", threadId: "old-thread", turnId: "draft-turn", basedOnSequence: 2, status: "pending",
      },
      "codex:acked": {
        localTurnId: "codex:acked", threadId: "old-thread", turnId: "acked-turn", basedOnSequence: 1, status: "acked",
        requestEventId: "event-1", responseEventId: "event-2",
      },
    },
    executionJournal: {},
  };
  await writeFile(statePath, JSON.stringify(pendingState));
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    workspacePath,
    threads: { "old-thread": "execution", "snapshot-thread": "snapshot_connector" },
  }));
  const client = {
    readThread: async () => ({ id: "old-thread", status: "idle", turns: [] }),
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · downgrade",
    model: "gpt-test",
    hookRegistryPath: registryPath,
  });

  await executor.deactivateLocalPublishing("read_only");
  let state = JSON.parse(await readFile(statePath, "utf8"));
  let registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(state.pendingLocalTurns, []);
  assert.deepEqual(state.hookDrafts, {});
  assert.deepEqual(Object.keys(state.localTurnBindings), ["codex:acked"]);
  assert.deepEqual(registry.threads, {
    "old-thread": "local_only",
    "snapshot-thread": "snapshot_connector",
  });

  await executor.activateLocalPublishing();
  registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.threads["old-thread"], "execution");
  let uploads = 0;
  const api = {
    commitLocalTurn: async () => { uploads += 1; throw new Error("stale local work must not upload"); },
  } as unknown as CollaborationApi;
  await executor.synchronizeLocalTurns(api, registeredRuntime("old-thread"));
  assert.equal(uploads, 0);
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.pendingLocalTurns, []);

  state.pendingLocalTurns = pendingState.pendingLocalTurns;
  state.localTurnBindings["codex:pending"] = {
    localTurnId: "codex:pending", threadId: "old-thread", turnId: "pending-turn", basedOnSequence: 2, status: "pending",
  };
  await writeFile(statePath, JSON.stringify(state));
  const harness = new CodexProjectHarness({
    workspacePath,
    stateRoot: directory,
    mappingId: "viewer-startup",
    projectName: "Project",
    model: "gpt-test",
    command: process.execPath,
    hookRegistryPath: registryPath,
    localTurnsEnabled: true,
  });
  await harness.deactivateExecutionBindings({ retainSessionIds: [] });
  await harness.close();
  state = JSON.parse(await readFile(statePath, "utf8"));
  registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(state.pendingLocalTurns, [], "viewer startup must scrub an old execution outbox");
  assert.equal(state.localTurnBindings["codex:pending"], undefined);
  assert.deepEqual(registry.threads, { "snapshot-thread": "snapshot_connector" });
});

test("managed session rename updates the native Codex thread and durable state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-rename-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  const names: string[] = [];
  const client = {
    readThread: async () => ({ id: "old-thread", status: "idle", turns: [] }),
    setThreadName: async (_threadId: string, name: string) => { names.push(name); },
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client, workspacePath, statePath, threadName: "GatherThread · Project · Old", model: "gpt-test",
  });
  await executor.renameThread("GatherThread · Project · Renamed");
  assert.deepEqual(names, ["GatherThread · Project · Renamed"]);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadName, "GatherThread · Project · Renamed");
});

test("suspended project binding stays known-local without entering the hook allowlist until explicit activation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-suspended-binding-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(registryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }));
  const client = {
    readThread: async () => ({ id: "old-thread", status: "idle", turns: [] }),
    resumeThread: async () => undefined,
    setThreadName: async () => undefined,
    injectItems: async () => undefined,
    unsubscribeThread: async () => undefined,
    getThreadTokenUsage: () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Project · Suspended",
    model: "gpt-test",
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
  });
  await executor.deactivateLocalPublishing("initializing");
  await executor.projectCanonicalEvents([
    canonical(3, "human_chat", { text: "materialize before activation" }),
  ], registeredRuntime("old-thread"));
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, { "old-thread": "local_only" });
  await executor.activateLocalPublishing();
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, { "old-thread": "execution" });
});

test("new Desktop binding is committed only after cross-process rollout verification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-persisted-desktop-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }));
  const calls: Array<{ method: string; threadId?: string }> = [];
  let closed = false;
  const client = {
    startThread: async () => { calls.push({ method: "thread/start" }); return "persisted-thread"; },
    setThreadName: async (threadId: string) => { calls.push({ method: "thread/name/set", threadId }); },
    unsubscribeThread: async (threadId: string) => { calls.push({ method: "thread/unsubscribe", threadId }); },
    close: async () => { calls.push({ method: "client/close" }); closed = true; },
    readThread: async (threadId: string) => {
      assert.equal(closed, true, "verification must use a restarted App Server process");
      calls.push({ method: "thread/read", threadId });
      return { id: threadId, name: "Session · GatherThread", status: "notLoaded", turns: [] };
    },
    deleteThread: async (threadId: string) => { calls.push({ method: "thread/delete", threadId }); },
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
    desktopHookOnly: true,
    threadSource: "vscode",
    gatherThreadSessionId: "session-1",
  });

  await executor.activateLocalPublishing();

  assert.deepEqual(calls.slice(0, 5).map((call) => call.method), [
    "thread/start", "thread/name/set", "thread/unsubscribe", "client/close", "thread/read",
  ]);
  assert.equal(calls.some((call) => call.method === "thread/delete"), false);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "persisted-thread");
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, { "persisted-thread": "execution" });
});

test("new Desktop binding is assigned to the exact Codex project before it becomes a Hook writer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-project-bound-desktop-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }));
  const starts: Array<Record<string, unknown>> = [];
  const assignments: Array<{ threadId: string; projectId: string }> = [];
  let closed = false;
  const client = {
    findProjectIdForRoot: async (root: string) => {
      assert.equal(root, workspacePath);
      return "desktop-project-1";
    },
    startThread: async (input: Record<string, unknown>) => {
      starts.push(input);
      return "project-bound-thread";
    },
    setThreadProject: async (threadId: string, projectId: string) => {
      assignments.push({ threadId, projectId });
      return true;
    },
    setThreadName: async () => undefined,
    unsubscribeThread: async () => undefined,
    close: async () => { closed = true; },
    readThread: async (threadId: string) => {
      assert.equal(closed, true, "project verification must cross an App Server process boundary");
      return {
        id: threadId,
        name: "Session · GatherThread",
        projectId: "desktop-project-1",
        status: "notLoaded",
        turns: [],
      };
    },
    deleteThread: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
    desktopHookOnly: true,
    threadSource: "vscode",
    gatherThreadSessionId: "session-1",
  });

  await executor.activateLocalPublishing();

  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.projectId, "desktop-project-1",
    "thread/start must persist the project assignment instead of relying on cwd inference");
  assert.deepEqual(assignments, [{ threadId: "project-bound-thread", projectId: "desktop-project-1" }]);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, {
    "project-bound-thread": "execution",
  });
});

test("activation repairs an older Desktop binding's missing project before authorizing Hooks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-repair-project-binding-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(registryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }));
  const calls: string[] = [];
  let assignedProjectId: string | undefined;
  const client = {
    findProjectIdForRoot: async () => "desktop-project-1",
    setThreadProject: async (_threadId: string, projectId: string) => {
      calls.push("thread/metadata/update");
      assignedProjectId = projectId;
      return true;
    },
    close: async () => { calls.push("client/close"); },
    readThread: async (threadId: string) => {
      calls.push("thread/read");
      return { id: threadId, name: "Session · GatherThread", projectId: assignedProjectId ?? null, status: "notLoaded", turns: [] };
    },
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
    desktopHookOnly: true,
    threadSource: "vscode",
    gatherThreadSessionId: "session-1",
  });

  await executor.activateLocalPublishing();

  assert.deepEqual(calls, ["thread/metadata/update", "client/close", "thread/read", "client/close"]);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, { "old-thread": "execution" });
});

test("unpersisted empty Desktop thread never becomes a binding or Hook writer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-unpersisted-desktop-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }));
  const calls: Array<{ method: string; threadId?: string }> = [];
  const client = {
    startThread: async () => { calls.push({ method: "thread/start" }); return "missing-rollout"; },
    setThreadName: async (threadId: string) => { calls.push({ method: "thread/name/set", threadId }); },
    unsubscribeThread: async (threadId: string) => { calls.push({ method: "thread/unsubscribe", threadId }); },
    close: async () => { calls.push({ method: "client/close" }); },
    readThread: async (threadId: string) => {
      calls.push({ method: "thread/read", threadId });
      throw new Error("failed to resolve rollout path: file does not exist");
    },
    deleteThread: async (threadId: string) => { calls.push({ method: "thread/delete", threadId }); },
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "Session · GatherThread",
    model: "gpt-test",
    hookRegistryPath: registryPath,
    localPublishingInitiallyActive: false,
    desktopHookOnly: true,
    threadSource: "vscode",
    gatherThreadSessionId: "session-1",
  });

  await assert.rejects(executor.activateLocalPublishing(), /not persisted across App Server restart/);

  assert.deepEqual(calls.map((call) => call.method), [
    "thread/start", "thread/name/set", "thread/unsubscribe", "client/close", "thread/read", "thread/delete", "client/close",
  ]);
  await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, {});
});

test("archived or missing managed Codex threads require explicit repair and are never resumed", async () => {
  for (const readThread of [
    async () => ({ id: "old-thread", status: "archived", turns: [] }),
    async () => { throw new Error("not found"); },
  ]) {
    const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-managed-thread-"));
    const workspacePath = await realpath(directory);
    const statePath = path.join(directory, "binding-session.json");
    await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
    let resumes = 0;
    const client = {
      readThread,
      resumeThread: async () => { resumes += 1; },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const executor = new CodexAppServerExecutor({
      client, workspacePath, statePath, threadName: "GatherThread · managed", model: "gpt-test",
    });
    await assert.rejects(
      executor.projectCanonicalEvents([canonical(3, "human_chat", { text: "new" })], registeredRuntime("old-thread")),
      /repair|reset/,
    );
    assert.equal(resumes, 0);
  }
});

test("connector restart replaces a missing ephemeral exec projection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-missing-ephemeral-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "execution.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  const starts: Array<{ threadSource?: string }> = [];
  const unsubscribed: string[] = [];
  const client = {
    readThread: async () => { throw new Error("ephemeral thread not found after restart"); },
    startThread: async (input: { threadSource?: string }) => {
      starts.push(input);
      return "replacement-ephemeral-thread";
    },
    unsubscribeThread: async (threadId: string) => { unsubscribed.push(threadId); },
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread background · restarted",
    model: "gpt-test",
    threadSource: "exec",
  });

  await executor.renameThread("GatherThread background · restarted and renamed");
  assert.equal(await executor.prepareCanonicalProjection(registeredRuntime("old-thread")), 0);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.threadSource, "exec");
  assert.deepEqual(unsubscribed, [], "ephemeral projections must remain loaded for the App Server lifetime");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "replacement-ephemeral-thread");
  assert.equal(state.threadName, "GatherThread background · restarted and renamed");
  assert.equal(state.lastInjectedSequence, 0, "canonical history must replay into the replacement");
});

test("connector model changes rebuild the private execution projection from canonical history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-model-change-execution-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "execution.json");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    model: "gpt-5.6-sol",
    contextWindowTokens: 65_536,
  }));
  const starts: Array<{ model?: string; threadSource?: string }> = [];
  const client = {
    startThread: async (input: { model?: string; threadSource?: string }) => {
      starts.push(input);
      return "luna-execution-thread";
    },
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread background · Luna",
    model: "gpt-5.6-luna",
    contextWindowTokens: 131_072,
    threadSource: "exec",
  });

  assert.equal(await executor.prepareCanonicalProjection(registeredRuntime("old-thread")), 0);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.model, "gpt-5.6-luna");
  assert.equal(starts[0]?.threadSource, "exec");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "luna-execution-thread");
  assert.equal(state.model, "gpt-5.6-luna");
  assert.equal(state.contextWindowTokens, 131_072);
  assert.equal(state.projectionGeneration, 2);
  assert.equal(state.lastInjectedSequence, 0, "canonical history must replay under the new model");
});

test("connector model changes preserve the Desktop-owned task and Hook binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-model-change-desktop-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  const registryPath = path.join(directory, "hook-registry.json");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    model: "gpt-5.6-sol",
    contextWindowTokens: 65_536,
  }));
  await writeFile(registryPath, JSON.stringify({ version: 1, workspacePath, threads: {} }));
  let starts = 0;
  const client = {
    startThread: async () => { starts += 1; return "must-not-replace-desktop-thread"; },
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · Desktop Luna default",
    model: "gpt-5.6-luna",
    contextWindowTokens: 131_072,
    hookRegistryPath: registryPath,
    desktopHookOnly: true,
    localPublishingInitiallyActive: false,
    gatherThreadSessionId: "session-1",
  });

  await executor.deactivateLocalPublishing("initializing");
  await executor.activateLocalPublishing();
  assert.equal(starts, 0, "changing the connector default must not replace a Desktop-owned task");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "old-thread");
  assert.equal(state.model, "gpt-5.6-luna");
  assert.equal(state.contextWindowTokens, 131_072);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).threads, { "old-thread": "execution" });
});

test("a Desktop-active thread is queued without takeover and releases the short-lived client", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-active-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "binding-session.json");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  let closes = 0;
  let mutations = 0;
  const client = {
    readThread: async () => ({ id: "old-thread", status: "active", turns: [] }),
    resumeThread: async () => { mutations += 1; },
    startThread: async () => { mutations += 1; return "must-not-start"; },
    archiveThread: async () => { mutations += 1; },
    close: async () => { closes += 1; },
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client, workspacePath, statePath, threadName: "GatherThread · active", model: "gpt-test",
  });

  await assert.rejects(
    executor.projectCanonicalEvents([canonical(3, "human_chat", { text: "queued" })], registeredRuntime("old-thread")),
    /active in another client|queued/,
  );
  assert.equal(mutations, 0, "the connector must not resume, replace, or archive a Desktop-owned task");
  assert.equal(closes, 1, "the failed attempt must still release its App Server process");
});

test("connector restart replaces an externally claimed background projection before replay", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-restart-active-writer-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "execution.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: message.params.threadId, status: { type: message.params.threadId === "old-thread" ? "active" : "idle" }, turns: [],
  } });
  else if (message.method === "thread/resume" && message.params.threadId === "old-thread") {
    fail(message.id, "thread old-thread already has an active writer");
  } else if (message.method === "thread/resume") respond(message.id, { thread: { id: message.params.threadId } });
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "replacement-thread" } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
function fail(id, message) { process.stdout.write(JSON.stringify({ id, error: { code: -32000, message } }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread background · restart",
    model: "gpt-test",
    threadSource: "exec",
  });
  const runtime = registeredRuntime("background-binding");

  assert.equal(await executor.prepareCanonicalProjection(runtime), 0);
  await executor.projectCanonicalEvents([
    canonical(1, "human_chat", { text: "first" }, "user-2"),
    canonical(2, "agent_response", { text: "second" }, "user-2"),
  ], runtime);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "replacement-thread");
  assert.equal(state.projectionGeneration, 2);
  assert.equal(state.lastInjectedSequence, 2);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "thread/start").length, 1);
  assert.equal(captures.filter((message) => message.method === "thread/inject_items").length, 2);
});

test("unknown local-turn commit survives downgrade and resolves idempotently before execution resumes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-unknown-local-commit-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const state = projectionState(workspacePath) as Record<string, any>;
  state.pendingLocalTurns = [{
    localTurnId: "codex:unknown", threadId: "old-thread", turnId: "local-turn",
    basedOnSequence: 2, occurredAt: "2026-08-25T00:00:00.000Z",
    requestPayload: { text: "question" }, responsePayload: { text: "answer" }, toolEvents: [],
  }];
  state.localTurnBindings = {
    "codex:unknown": {
      localTurnId: "codex:unknown", threadId: "old-thread", turnId: "local-turn",
      basedOnSequence: 2, status: "pending",
    },
  };
  await writeFile(statePath, JSON.stringify(state));
  const client = {
    readThread: async () => ({ id: "old-thread", status: "idle", turns: [] }),
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  const executor = new CodexAppServerExecutor({
    client, workspacePath, statePath, threadName: "GatherThread · unknown commit", model: "gpt-test",
  });
  const runtime = registeredRuntime("old-thread");
  const committed = {
    localTurnId: "codex:unknown", runtimeId: runtime.id, headBeforeCommit: 2, reconciliationRequired: false,
    requestEvent: canonical(3, "agent_request", { content: "question" }),
    responseEvent: canonical(4, "agent_response", { text: "answer" }),
    toolEvents: [],
  };
  let attempts = 0;
  await assert.rejects(executor.synchronizeLocalTurns({
    commitLocalTurn: async () => {
      attempts += 1;
      throw new Error("response lost after commit");
    },
  } as unknown as CollaborationApi, runtime), /response lost/);
  let persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.localTurnBindings["codex:unknown"].status, "commit_unknown");
  assert.equal(persisted.pendingLocalTurns.length, 1);

  await executor.deactivateLocalPublishing("read_only");
  persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.localTurnBindings["codex:unknown"].status, "commit_unknown");
  assert.equal(persisted.pendingLocalTurns.length, 1, "an attempted mutation with unknown outcome must retain its exact retry body");
  await assert.rejects(executor.shouldExecute(committed.requestEvent, runtime), /unknown server outcome/);

  await executor.synchronizeLocalTurns({
    commitLocalTurn: async () => {
      attempts += 1;
      return committed;
    },
  } as unknown as CollaborationApi, runtime);
  assert.equal(attempts, 2);
  persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.localTurnBindings["codex:unknown"].status, "acked");
  assert.equal(persisted.localTurnBindings["codex:unknown"].requestEventId, committed.requestEvent.id);
  assert.deepEqual(persisted.pendingLocalTurns, []);
  assert.equal(await executor.shouldExecute(committed.requestEvent, runtime), false);
});

type AccountingUsage = { turnId?: string; modelContextWindow: number; total: { totalTokens: number }; last?: { totalTokens: number } };

async function accountingFixture(t: TestContext, options: {
  window?: number;
  estimated?: number;
  resumeUsage?: AccountingUsage;
  injectionUsage?: AccountingUsage;
  injectionUsageAfter?: number;
  compactUsage?: AccountingUsage;
}) {
  const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "gt-native-context-accounting-")));
  const statePath = path.join(workspacePath, "state.json");
  const capturePath = path.join(workspacePath, "capture.jsonl");
  const settingsPath = path.join(workspacePath, "accounting.json");
  const fakeCodex = path.join(workspacePath, "fake.mjs");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    contextWindowTokens: options.window ?? 128_000,
    estimatedContextTokens: options.estimated ?? 0,
  }));
  await writeFile(settingsPath, JSON.stringify(options));
  await writeFile(fakeCodex, `
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
let resumed = false;
let injected = false;
let injectionCount = 0;
function usage(value, threadId = "old-thread") { if (value) send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: value.turnId, tokenUsage: value } }); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
for await (const line of createInterface({ input: process.stdin })) {
  const settings = JSON.parse(await readFile(process.env.ACCOUNTING_PATH, "utf8"));
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "rebuild-" + message.id } } });
  else if (message.method === "thread/read") send({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: "idle" }, turns: [] } } });
  else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "old-thread" } } });
    if (!resumed) usage(settings.resumeUsage);
    resumed = true;
  } else if (message.method === "thread/compact/start") {
    usage(settings.compactUsage, message.params.threadId);
    send({ method: "item/completed", params: { threadId: message.params.threadId, item: { type: "contextCompaction" } } });
    send({ id: message.id, result: {} });
  } else {
    send({ id: message.id, result: {} });
    if (message.method === "thread/inject_items" && !injected) {
      injectionCount += 1;
      if (injectionCount >= (settings.injectionUsageAfter ?? 1)) { usage(settings.injectionUsage); injected = true; }
    }
  }
}
`);
  const client = new CodexAppServerClient({
    command: process.execPath, commandArgs: [fakeCodex], cwd: workspacePath,
    env: { ...process.env, ACCOUNTING_PATH: settingsPath, CAPTURE: capturePath },
  });
  t.after(() => client.dispose());
  const executor = new CodexAppServerExecutor({
    client, workspacePath, statePath, threadName: "Accounting", model: "gpt-test",
    contextWindowTokens: options.window ?? 128_000,
  });
  return {
    executor, statePath,
    setResumeUsage: (resumeUsage: AccountingUsage) => writeFile(settingsPath, JSON.stringify({ ...options, resumeUsage })),
    captured: async () => (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
  };
}

test("native large windows use last context usage, not cumulative tokens or a 4096-token ceiling", async (t) => {
  const fixture = await accountingFixture(t, {
    resumeUsage: { modelContextWindow: 262_144, total: { totalTokens: 2_000_000 }, last: { totalTokens: 100 } },
  });
  await fixture.executor.projectCanonicalEvents([
    canonical(3, "human_chat", { text: "x".repeat(70_000) }, "user-2"),
  ], registeredRuntime("old-thread"));
  // Reloading fallback token estimates must not erase an observed native window.
  await fixture.executor.projectCanonicalEvents([
    canonical(4, "human_chat", { text: "native-window-after-reload" }, "user-2"),
  ], registeredRuntime("old-thread"));
  const saved = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal((await fixture.captured()).filter((entry) => entry.method === "thread/compact/start").length, 0);
  assert.equal(saved.contextWindowTokens, 262_144);
  assert.equal(saved.contextWindowSource, "app_server");
  assert.equal(saved.contextUsageSource, "fallback_estimate");
  assert.ok(saved.estimatedContextTokens > 23_000 && saved.estimatedContextTokens < 30_000);
});

test("identical native usage after reconnect preserves estimates, while a new turn with equal tokens resets them", async (t) => {
  const usage = { turnId: "native-turn-1", modelContextWindow: 128_000, total: { totalTokens: 10_000 }, last: { totalTokens: 100 } };
  const fixture = await accountingFixture(t, { resumeUsage: usage });
  for (const sequence of [3, 4]) {
    await fixture.executor.projectCanonicalEvents([
      canonical(sequence, "human_chat", { text: "x".repeat(5000) }, "user-2"),
    ], registeredRuntime("old-thread"));
  }
  const before = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.ok(before.estimatedContextTokens > 3400);
  assert.match(before.contextUsageFingerprint, /^[a-f0-9]{64}$/);
  await fixture.setResumeUsage({ ...usage, turnId: "native-turn-2" });
  await fixture.executor.projectCanonicalEvents([
    canonical(5, "human_chat", { text: "small new delta" }, "user-2"),
  ], registeredRuntime("old-thread"));
  const after = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.ok(after.estimatedContextTokens > 100 && after.estimatedContextTokens < 200);
  assert.notEqual(after.contextUsageFingerprint, before.contextUsageFingerprint);
});

test("an old native report never erases subsequently injected unobserved bytes", async (t) => {
  const fixture = await accountingFixture(t, {
    injectionUsage: { modelContextWindow: 128_000, total: { totalTokens: 500 } },
    injectionUsageAfter: 2,
  });
  await fixture.executor.projectCanonicalEvents([
    canonical(3, "human_chat", { text: "x".repeat(40_000) }, "user-2"),
  ], registeredRuntime("old-thread"));
  const saved = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.ok(saved.estimatedContextTokens > 10_000);
  assert.equal(saved.contextUsageSource, "fallback_estimate");
  assert.equal((await fixture.captured()).filter((entry) => entry.method === "thread/compact/start").length, 0);
  await fixture.executor.projectCanonicalEvents([
    canonical(4, "human_chat", { text: "next event" }, "user-2"),
  ], registeredRuntime("old-thread"));
  const later = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.ok(later.estimatedContextTokens >= saved.estimatedContextTokens);
});

test("native compact uses fresh post-compact usage and genuine small windows remain safe", async (t) => {
  const fixture = await accountingFixture(t, {
    window: 4096, estimated: 3000,
    compactUsage: { modelContextWindow: 4096, total: { totalTokens: 2_000_000 }, last: { totalTokens: 200 } },
  });
  await fixture.executor.projectCanonicalEvents([
    canonical(3, "human_chat", { text: "x".repeat(2000) }, "user-2"),
  ], registeredRuntime("old-thread"));
  const saved = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(saved.compactionGeneration, 1);
  assert.ok(saved.estimatedContextTokens > 850 && saved.estimatedContextTokens < 950);
  assert.equal(saved.contextWindowSource, "app_server");
  assert.equal(saved.contextUsageSource, "fallback_estimate");
  assert.equal((await fixture.captured()).filter((entry) => entry.method === "thread/inject_items").length, 1);
});

test("native compact with unknown or still-full usage fails safely without injecting or inventing 15 percent", async (t) => {
  for (const compactUsage of [undefined, { modelContextWindow: 4096, total: { totalTokens: 3500 } }, { modelContextWindow: 4096, total: { totalTokens: 3000 } }]) {
    const fixture = await accountingFixture(t, {
      window: 4096, estimated: 3000,
      resumeUsage: { modelContextWindow: 4096, total: { totalTokens: 3000 } },
      ...(compactUsage === undefined ? {} : { compactUsage }),
    });
    await assert.rejects(fixture.executor.projectCanonicalEvents([
      canonical(3, "human_chat", { text: "x".repeat(2000) }, "user-2"),
    ], registeredRuntime("old-thread")), /context|usage/i);
    const saved = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(saved.estimatedContextTokens, compactUsage?.total.totalTokens ?? 3000);
    assert.equal(saved.contextUsageSource, compactUsage?.total.totalTokens === 3500 ? "app_server" : "unknown_after_compaction");
    assert.equal(saved.lastInjectedSequence, 2);
    assert.equal((await fixture.captured()).filter((entry) => entry.method === "thread/inject_items").length, 0);
  }
});

test("unknown compact usage pauses repeated projection and reconciliation without clearing real injection journals", async (t) => {
  for (const partial of [false, true]) {
    const fixture = await accountingFixture(t, { window: 4096, estimated: partial ? 0 : 3000 });
    const event = canonical(3, "human_chat", { text: "x".repeat(partial ? 40_000 : 2000) }, "user-2");
    const runtime = registeredRuntime("old-thread");
    await assert.rejects(fixture.executor.projectCanonicalEvents([event], runtime), /fresh context usage/);
    const saved = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(saved.contextUsageSource, "unknown_after_compaction");
    if (partial) assert.equal(saved.projectionJournal.nextChunk, 1);
    else assert.equal(saved.projectionJournal, undefined, "compaction alone is not an uncertain injection");
    let reads = 0;
    const api = { readEvents: async () => { reads += 1; return { events: [event], nextSequence: 3, hasMore: false }; } } as unknown as CollaborationApi;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(fixture.executor.projectCanonicalEvents([event], runtime), /waiting for fresh.*usage/i);
      if (partial) await assert.rejects(fixture.executor.synchronizeLocalTurns(api, runtime), /waiting for fresh.*usage/i);
      else await fixture.executor.synchronizeLocalTurns(api, runtime);
    }
    const after = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.deepEqual(after.projectionJournal, saved.projectionJournal);
    assert.equal(reads, 0);
    const captured = await fixture.captured();
    assert.equal(captured.filter((entry) => entry.method === "thread/compact/start").length, 1);
    assert.equal(captured.filter((entry) => entry.method === "thread/start").length, 0);
    if (!partial) {
      await fixture.setResumeUsage({ turnId: "recovered-native-turn", modelContextWindow: 4096, total: { totalTokens: 100 } });
      await fixture.executor.projectCanonicalEvents([event], runtime);
      const recovered = JSON.parse(await readFile(fixture.statePath, "utf8"));
      assert.equal(recovered.contextRecovery, undefined);
      assert.equal(recovered.lastInjectedSequence, 3);
      assert.equal((await fixture.captured()).filter((entry) => entry.method === "thread/compact/start").length, 1);
    }
  }
});

test("unknown compaction inside a rebuild persists a recovery stop instead of paying for another rebuild", async (t) => {
  const fixture = await accountingFixture(t, { window: 4096 });
  const original = JSON.parse(await readFile(fixture.statePath, "utf8"));
  original.projectionJournal = { eventId: "event-3", sequence: 3, nextChunk: 0, totalChunks: 6 };
  await writeFile(fixture.statePath, JSON.stringify(original));
  const event = canonical(3, "human_chat", { text: "x".repeat(40_000) }, "user-2");
  const api = { readEvents: async () => ({ events: [event], nextSequence: 3, hasMore: false }) } as unknown as CollaborationApi;
  const runtime = registeredRuntime("old-thread");
  await assert.rejects(fixture.executor.synchronizeLocalTurns(api, runtime), /fresh context usage/);
  const saved = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(saved.threadId, "old-thread");
  assert.equal(saved.contextRecovery.threadId, saved.rebuild.threadId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(fixture.executor.synchronizeLocalTurns(api, runtime), /waiting for fresh.*usage/i);
  }
  const captured = await fixture.captured();
  assert.equal(captured.filter((entry) => entry.method === "thread/start").length, 1);
  assert.equal(captured.filter((entry) => entry.method === "thread/compact/start").length, 1);
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, "utf8")).projectionJournal, original.projectionJournal);
});

test("4096-token projection splits and compacts before any chunk can cross the high-water budget", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-small-context-"));
  const workspacePath = await realpath(directory);
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  await writeFile(statePath, JSON.stringify({
    ...projectionState(workspacePath),
    contextWindowTokens: 4096,
    estimatedContextTokens: 0,
  }));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: { id: "old-thread", status: { type: "idle" }, turns: [] } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "old-thread" } });
  else if (message.method === "thread/compact/start") {
    respond(message.id, {});
    process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "old-thread", turnId: "compact-" + message.id, tokenUsage: { modelContextWindow: 4096, last: { totalTokens: 500 } },
    } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "old-thread", item: { type: "contextCompaction" } } }) + "\\n");
  } else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · small context",
    model: "gpt-test",
    contextWindowTokens: 4096,
    contextHighWatermark: 0.8,
    maxInjectionItemBytes: 64 * 1024,
  });
  await executor.projectCanonicalEvents([
    canonical(3, "human_chat", { content: "x".repeat(40_000) }, "user-2"),
  ], registeredRuntime("old-thread"));
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const injections = captures.filter((message) => message.method === "thread/inject_items");
  assert.ok(injections.length > 1);
  assert.ok(injections.every((message) => Buffer.byteLength(message.params.items[0].content[0].text) < 8_192));
  assert.ok(captures.filter((message) => message.method === "thread/compact/start").length >= 1);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.lastInjectedSequence, 3);
  assert.ok(persisted.compactionGeneration >= 1);
});

test("App Server token usage controls compaction and model windows stay isolated", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-token-usage-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
let injections = 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: { id: "old-thread", status: { type: "idle" }, turns: [] } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "old-thread" } });
  else if (message.method === "thread/compact/start") {
    // This case verifies that an observed native usage report controls the
    // following projection. Emit it before the RPC acknowledgement; a later
    // asynchronous report is intentionally allowed to leave the current
    // persisted state on its conservative fallback until the next operation.
    process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "old-thread", turnId: "compact-" + message.id, tokenUsage: { modelContextWindow: 4096, last: { totalTokens: 500 } },
    } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "old-thread", item: { type: "contextCompaction" } } }) + "\\n");
    respond(message.id, {});
  } else if (message.method === "thread/inject_items") {
    injections += 1;
    process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "old-thread", turnId: "injected-" + message.id, tokenUsage: { modelContextWindow: 4096, total: { totalTokens: injections === 1 ? 3500 : 700 } },
    } }) + "\\n");
    respond(message.id, {});
  } else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fakeCodex], cwd: directory, env: { ...process.env, CAPTURE: capturePath } });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · token usage",
    model: "gpt-test",
    contextWindowTokens: 128_000,
    contextHighWatermark: 0.8,
  });
  const runtime = registeredRuntime("old-thread");
  await executor.projectCanonicalEvents([
    canonical(3, "human_chat", { content: "first observed event " + "x".repeat(70_000) }, "user-2"),
    canonical(4, "human_chat", { content: "second event crosses observed window" }, "user-2"),
  ], runtime);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.contextWindowTokens, 4096);
  // The native window is observed, but a report emitted near an injection
  // cannot prove that it includes every acknowledged chunk.
  assert.equal(state.contextWindowSource, "app_server");
  assert.equal(state.contextUsageSource, "fallback_estimate");
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const compactCount = captures.filter((message) => message.method === "thread/compact/start").length;
  assert.ok(compactCount >= 1);
  assert.equal(state.compactionGeneration, compactCount);
  const injections = captures.filter((message) => message.method === "thread/inject_items");
  assert.ok(injections.length >= 3);
  assert.ok(injections.every((message) => Buffer.byteLength(message.params.items[0].content[0].text) <= 64 * 1024));
  const otherModel = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · other model",
    model: "gpt-other",
  });
  await assert.rejects(otherModel.projectCanonicalEvents([canonical(5, "human_chat", { content: "no reuse" })], runtime), /different model/);
});

test("completed execution journal recovers without starting a duplicate turn and malformed journals fail closed", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-execution-journal-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  const state = projectionState(workspacePath) as Record<string, unknown>;
  state.executionJournal = {
    "event-3": { requestId: "event-3", status: "started", turnId: "recovered-turn" },
  };
  state.connectorClientMessageIds = ["event-3"];
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: { id: "old-thread", status: { type: "idle" }, turns: [{
    id: "recovered-turn", status: "completed", startedAt: 1, completedAt: 2, items: [
      { type: "userMessage", id: "u", clientId: "event-3", content: [{ type: "text", text: "recover" }] },
      { type: "agentMessage", id: "a", phase: "final_answer", text: "R".repeat(500000) },
    ],
  }] } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "old-thread" } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fakeCodex], cwd: directory, env: { ...process.env, CAPTURE: capturePath } });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({ client, workspacePath, statePath, threadName: "GatherThread · journal", model: "gpt-test" });
  const request = canonical(3, "agent_request", { content: "recover" });
  const result = await executor.execute({ request, canonicalHistory: [request], runtime: registeredRuntime("old-thread") });
  assert.ok(Buffer.byteLength(result.events.at(-1)?.content ?? "") < 161 * 1024);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "turn/start").length, 0);
  const recoveredState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(recoveredState.executionJournal["event-3"].status, "completed");
  assert.ok(Buffer.byteLength(JSON.stringify(recoveredState.executionJournal)) < 170 * 1024);

  recoveredState.executionJournal = { broken: { requestId: "different", status: "completed", events: "not-an-array" } };
  await writeFile(statePath, JSON.stringify(recoveredState));
  await assert.rejects(
    executor.projectCanonicalEvents([canonical(4, "human_chat", { content: "must not mutate" })], registeredRuntime("old-thread")),
    /state is invalid/,
  );
});

test("failed and cancelled Codex turns persist terminal journals for idempotent claim completion", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-terminal-journal-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  await writeFile(statePath, JSON.stringify(projectionState(workspacePath)));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: "old-thread", status: { type: "idle" }, turns: [{
      id: "cancelled-turn", status: "cancelled", startedAt: 1, completedAt: 2, items: [],
    }],
  } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "old-thread" } });
  else if (message.method === "turn/start") {
    respond(message.id, { turn: { id: "failed-turn" } });
    setImmediate(() => process.stdout.write(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "old-thread", turn: { id: "failed-turn", status: "failed", error: { message: "token=${"z".repeat(40)}" }, items: [] } },
    }) + "\\n"));
  } else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · terminal",
    model: "gpt-test",
  });
  const runtime = registeredRuntime("old-thread");
  const failedRequest = canonical(3, "agent_request", { content: "fail safely" });
  await assert.rejects(
    executor.execute({ request: failedRequest, canonicalHistory: [failedRequest], runtime }),
    (error: unknown) => error instanceof HarnessExecutionTerminatedError
      && error.failureCode === "codex_turn_failed"
      && !error.publicMessage.includes("token=z"),
  );
  let state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.executionJournal[failedRequest.id].status, "failed");
  assert.equal(state.executionJournal[failedRequest.id].failure.code, "codex_turn_failed");
  assert.doesNotMatch(JSON.stringify(state.executionJournal), /token=z/);

  await assert.rejects(
    executor.execute({ request: failedRequest, canonicalHistory: [failedRequest], runtime }),
    (error: unknown) => error instanceof HarnessExecutionTerminatedError && error.failureCode === "codex_turn_failed",
  );
  state.executionJournal["event-4"] = { requestId: "event-4", status: "started", turnId: "cancelled-turn" };
  await writeFile(statePath, JSON.stringify(state));
  const cancelledRequest = canonical(4, "agent_request", { content: "cancel safely" });
  await assert.rejects(
    executor.execute({ request: cancelledRequest, canonicalHistory: [cancelledRequest], runtime }),
    (error: unknown) => error instanceof HarnessExecutionTerminatedError && error.failureCode === "codex_turn_cancelled",
  );
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.executionJournal["event-4"].status, "failed");
  assert.equal(state.executionJournal["event-4"].failure.code, "codex_turn_cancelled");
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "turn/start").length, 1);
});

test("uncertain projection abandons the old thread and rebuilds canonical history on a fresh thread", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-projection-journal-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  const state = projectionState(workspacePath) as Record<string, unknown>;
  state.projectionJournal = { eventId: "event-2", sequence: 2, nextChunk: 1, totalChunks: 2 };
  state.rebuild = {
    threadId: "half-built-thread", generation: 2, targetThroughSequence: 2,
    lastInjectedSequence: 1, estimatedContextTokens: 100, compactionGeneration: 0,
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "fresh-thread" } });
  else if (message.method === "thread/read") respond(message.id, { thread: { id: message.params.threadId, status: { type: "idle" }, turns: [] } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fakeCodex], cwd: directory, env: { ...process.env, CAPTURE: capturePath } });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({ client, workspacePath, statePath, threadName: "GatherThread · rebuild uncertain", model: "gpt-test" });
  const events = [
    canonical(1, "human_chat", { content: "one" }, "user-2"),
    canonical(2, "agent_response", { text: "two" }, "user-2"),
  ];
  const api = {
    commitLocalTurn: async () => { throw new Error("no local turn expected"); },
    readEvents: async () => ({ events, nextSequence: 2, hasMore: false }),
  } as unknown as CollaborationApi;
  await executor.synchronizeLocalTurns(api, registeredRuntime("old-thread"));
  const rebuilt = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(rebuilt.threadId, "fresh-thread");
  assert.equal(rebuilt.projectionJournal, undefined);
  assert.equal(rebuilt.lastInjectedSequence, 2);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "thread/inject_items" && message.params.threadId === "fresh-thread").length, 2);
  assert.equal(captures.filter((message) => message.method === "thread/inject_items" && message.params.threadId === "old-thread").length, 0);
  assert.ok(captures.some((message) => message.method === "thread/archive" && message.params.threadId === "old-thread"));
  assert.ok(captures.some((message) => message.method === "thread/archive" && message.params.threadId === "half-built-thread"));
});

test("snapshot accepts an authoritative cursor past a viewer-hidden tail without inventing injected events", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-snapshot-hidden-tail-"));
  const statePath = path.join(directory, "snapshot.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "snapshot-thread" } });
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: "snapshot-thread", name: "GatherThread snapshot · hidden tail", status: { type: "idle" }, turns: [],
  } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: "snapshot-thread" } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread snapshot · hidden tail",
    model: "gpt-test",
  });
  await executor.projectSnapshot(
    "session-1",
    [canonical(1, "human_chat", { content: "viewer-visible" }, "user-2")],
    3,
    3,
    "snapshot-runtime",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.lastInjectedSequence, 1);
  assert.equal(state.coveredThroughSequence, 3);
  assert.equal(state.cloudCursor, 3);
  assert.deepEqual(state.sidecar.map((entry: { sequence: number }) => entry.sequence), [1]);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "thread/inject_items").length, 1);

  const workerStateRoot = path.join(directory, "worker-state");
  const workerAbort = new AbortController();
  const harness = new CodexProjectHarness({
    workspacePath,
    stateRoot: workerStateRoot,
    mappingId: "viewer-mapping",
    projectName: "Viewer project",
    model: "gpt-test",
    command: process.execPath,
    commandArgs: [fakeCodex],
    env: { ...process.env, CAPTURE: capturePath },
    signal: workerAbort.signal,
  });
  t.after(() => harness.close());
  let completedResult: unknown;
  let rejectCompletion = false;
  let failedSnapshots = 0;
  const job = { id: "snapshot-job-hidden", kind: "immutable" as const, sessionId: "session-1", throughSequence: 3, status: "pending" as const };
  const api = {
    listSnapshotRequests: async (status: string) => status === "pending"
      ? [job, { ...job, id: "code-job-not-a-conversation", kind: "code_upload" }]
      : [],
    registerRuntime: async () => ({ ...registeredRuntime("snapshot-local"), purpose: "snapshot_connector" as const }),
    claimSnapshotRequest: async () => ({ ...job, status: "claimed" as const }),
    readEvents: async () => ({
      events: [canonical(1, "human_chat", { content: "viewer-visible" }, "user-2")],
      nextSequence: 3,
      hasMore: false,
    }),
    completeSnapshotRequest: async (_id: string, _runtimeId: string, result: unknown) => {
      if (rejectCompletion) throw new Error("simulated completion failure");
      completedResult = result;
      return { ...job, status: "completed" as const, result };
    },
    failSnapshotRequest: async () => { failedSnapshots += 1; return { ...job, status: "failed" as const }; },
  } as unknown as CollaborationApi;
  await harness.processSnapshotJobs({
    api,
    actorDeviceId: "device-1",
    sessions: [{ id: "session-1", projectId: "project-1", name: "Hidden", mode: "multi", role: "viewer" }],
  });
  assert.equal(getEventListeners(workerAbort.signal, "abort").length, 0, "a completed snapshot must dispose its client listener");
  await harness.processSnapshotJobs({
    api,
    actorDeviceId: "device-1",
    sessions: [{ id: "session-1", projectId: "project-1", name: "Hidden", mode: "multi", role: "viewer" }],
  });
  assert.equal(getEventListeners(workerAbort.signal, "abort").length, 0, "a repeated snapshot retry must not grow client listeners");
  rejectCompletion = true;
  await harness.processSnapshotJobs({
    api,
    actorDeviceId: "device-1",
    sessions: [{ id: "session-1", projectId: "project-1", name: "Hidden", mode: "multi", role: "viewer" }],
  });
  assert.equal(failedSnapshots, 1);
  assert.equal(getEventListeners(workerAbort.signal, "abort").length, 0, "a failed snapshot completion must also dispose its client listener");
  assert.equal((completedResult as { through_sequence?: number }).through_sequence, 3);
  assert.equal(
    (completedResult as { thread_name?: string }).thread_name,
    "Hidden · MULTI · GatherThread snapshot · through 3",
  );
  const workerState = JSON.parse(await readFile(
    path.join(workerStateRoot, "snapshots", `${codexSessionKey("snapshot-job-hidden")}.json`),
    "utf8",
  ));
  assert.equal(workerState.lastInjectedSequence, 1);
  assert.equal(workerState.coveredThroughSequence, 3);
  assert.equal(workerState.threadName, "Hidden · MULTI · GatherThread snapshot · through 3");
});

test("reconciliation rebuilds off to the side before atomically switching and archiving the fork", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-rebuild-"));
  const statePath = path.join(directory, "state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake.mjs");
  const workspacePath = await realpath(directory);
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") respond(message.id, {});
  else if (message.method === "thread/read") respond(message.id, { thread: {
    id: message.params.threadId, status: { type: "idle" }, turns: message.params.threadId === "old-thread" ? [{
      id: "desktop-turn", status: "completed", startedAt: 1787676000, completedAt: 1787676001,
      items: [
        { type: "userMessage", id: "u", clientId: "desktop-client", content: [{ type: "text", text: "local question" }] },
        { type: "agentMessage", id: "a", phase: "final_answer", text: "local answer" },
      ],
    }] : [],
  } });
  else if (message.method === "thread/start") respond(message.id, { thread: { id: "rebuilt-thread" } });
  else if (message.method === "thread/resume") respond(message.id, { thread: { id: message.params.threadId } });
  else respond(message.id, {});
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const initialState = projectionState(workspacePath) as Record<string, any>;
  initialState.localTurnBindings = {
    "codex:older-acked": {
      localTurnId: "codex:older-acked", threadId: "old-thread", turnId: "older-turn",
      basedOnSequence: 0, status: "acked", requestEventId: "event-1", responseEventId: "event-2",
    },
    "codex:trusted-local": {
      localTurnId: "codex:trusted-local", threadId: "old-thread", turnId: "desktop-turn",
      basedOnSequence: 2, status: "pending",
    },
  };
  initialState.pendingLocalTurns = [{
    localTurnId: "codex:trusted-local", threadId: "old-thread", turnId: "desktop-turn",
    basedOnSequence: 2, occurredAt: "2026-08-25T00:00:00.000Z",
    requestPayload: { text: "local question" }, responsePayload: { text: "local answer" }, toolEvents: [],
  }];
  initialState.connectorClientMessageIds = ["event-3"];
  await writeFile(statePath, JSON.stringify(initialState));
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
  });
  t.after(() => client.close());
  const executor = new CodexAppServerExecutor({
    client,
    workspacePath,
    statePath,
    threadName: "GatherThread · rebuild",
    model: "gpt-test",
  });
  const events = [
    canonical(1, "human_chat", { content: "base" }, "user-2"),
    canonical(2, "agent_response", { text: "base answer" }, "user-1"),
    canonical(3, "agent_request", { content: "local question" }, "user-1"),
    canonical(4, "agent_response", { text: "local answer" }, "user-1"),
  ];
  const api = {
    commitLocalTurn: async () => ({
      localTurnId: "local",
      runtimeId: "runtime-1",
      headBeforeCommit: 2,
      reconciliationRequired: true,
      requestEvent: events[2],
      responseEvent: events[3],
      toolEvents: [],
    }),
    readEvents: async () => ({ events, nextSequence: 4, hasMore: false }),
  } as unknown as CollaborationApi;
  await executor.synchronizeLocalTurns(api, registeredRuntime("old-thread"));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "rebuilt-thread");
  assert.equal(state.projectionGeneration, 2);
  assert.equal(state.coveredThroughSequence, 4);
  assert.equal(state.rebuild, undefined);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captures.filter((message) => message.method === "thread/inject_items").length, 4);
  assert.deepEqual(state.sidecar.map((entry: { sequence: number; disposition: string }) => [entry.sequence, entry.disposition]), [
    [1, "injected"], [2, "injected"], [3, "injected"], [4, "injected"],
  ]);
  assert.ok(captures.some((message) => message.method === "thread/name/set" && message.params.threadId === "old-thread" && /offline fork/.test(message.params.name)));
  assert.ok(captures.some((message) => message.method === "thread/archive" && message.params.threadId === "old-thread"));
});

test("App Server integration fails closed on unexpected interactive requests", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-app-server-request-"));
  const fakeCodex = path.join(directory, "unexpected-request.mjs");
  await writeFile(fakeCodex, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method !== "initialize") continue;
  process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }) + "\\n");
  process.stdout.write(JSON.stringify({
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: { command: "unsafe" },
  }) + "\\n");
}
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
  });
  t.after(() => client.close());
  await assert.rejects(
    async () => {
      await client.start();
      await client.request("thread/start", {});
    },
    /unsupported interaction/,
  );
});

test("headless App Server execution declines MCP elicitations without interrupting the turn", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-app-server-elicitation-"));
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "elicitation-request.mjs");
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.env.CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake" });
  } else if (message.method === "turn/start") {
    respond(message.id, { turn: { id: "turn-1" } });
    process.stdout.write(JSON.stringify({
      id: 99,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-1",
        serverName: "test-mcp",
        mode: "form",
        _meta: null,
        message: "Provide a secret",
        requestedSchema: { type: "object", properties: {} },
      },
    }) + "\\n");
  } else if (message.id === 99) {
    process.stdout.write(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "Checking files" },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "continued safely" }],
        },
      },
    }) + "\\n");
  }
}
function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
`);
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: [fakeCodex],
    cwd: directory,
    env: { ...process.env, CAPTURE: capturePath },
    turnTimeoutMs: 500,
  });
  t.after(() => client.dispose());
  const completedItems: unknown[] = [];
  const completed = await client.runTurn({
    threadId: "thread-1",
    prompt: "continue without interactive input",
    clientUserMessageId: "elicitation-turn",
    onItemCompleted: async (item) => { completedItems.push(item); },
  });
  assert.deepEqual(completed.items, [{ type: "agentMessage", text: "continued safely" }]);
  assert.deepEqual(completedItems, [{
    id: "commentary-1",
    type: "agentMessage",
    phase: "commentary",
    text: "Checking files",
  }]);
  const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(captures.find((message) => message.id === 99), {
    id: 99,
    result: { action: "decline", content: null, _meta: null },
  });
});

test("project harness retains its process-owned ephemeral exec projection across Web requests", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-app-server-"));
  const stateRoot = path.join(directory, "state");
  const statePath = path.join(stateRoot, "session-state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex-app-server.mjs");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(fakeCodex, `
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli test-version\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using test account\\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  await appendFile(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({
    message,
    gatherThreadTokenPresent: process.env.GATHERTHREAD_TOKEN !== undefined,
  }) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake", codexHome: "/tmp/fake" });
  } else if (message.method === "thread/start") {
    const counterPath = process.env.FAKE_CODEX_CAPTURE + ".thread-counter";
    const nextThread = Number(await readFile(counterPath, "utf8").catch(() => "0")) + 1;
    await writeFile(counterPath, String(nextThread));
    respond(message.id, { thread: { id: "thread-app-server-" + nextThread } });
  } else if (message.method === "thread/resume") {
    if (message.params.threadId === "thread-app-server-1") {
      fail(message.id, "thread thread-app-server-1 already has an active writer");
    } else {
      respond(message.id, { thread: { id: message.params.threadId } });
    }
  } else if (message.method === "thread/read") {
    respond(message.id, { thread: { id: message.params.threadId, status: { type: "idle" }, turns: [] } });
  } else if (message.method === "thread/name/set") {
    respond(message.id, {});
  } else if (message.method === "thread/inject_items" || message.method === "thread/unsubscribe") {
    respond(message.id, {});
  } else if (message.method === "thread/compact/start") {
    respond(message.id, {});
    process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: message.params.threadId, turnId: "compact-" + message.id, tokenUsage: { modelContextWindow: 4096, last: { totalTokens: 500 } },
    } }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "item/completed",
      params: { threadId: message.params.threadId, turnId: "compact-turn", item: { id: "compact-1", type: "contextCompaction" } },
    }) + "\\n");
  } else if (message.method === "turn/start") {
    const turn = JSON.stringify(message.params.input).includes("implement second") ? 2 : 1;
    const turnId = "turn-" + turn;
    respond(message.id, { turn: { id: turnId } });
    process.stdout.write(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: message.params.threadId,
        turnId,
        item: { id: "commentary-" + turn, type: "agentMessage", phase: "commentary", text: "Checking turn " + turn },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: message.params.threadId,
        turnId,
        item: { id: "reasoning-" + turn, type: "reasoning", summary: ["private reasoning"] },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: {
          id: turnId,
          status: "completed",
          items: [
            {
              id: "command-" + turn,
              type: "commandExecution",
              command: "npm test",
              commandActions: [],
              cwd: process.cwd(),
              status: "completed",
              exitCode: 0,
              aggregatedOutput: "tests passed",
            },
            {
              id: "answer-" + turn,
              type: "agentMessage",
              phase: "final_answer",
              text: turn === 1 ? "first app answer" : "second app answer",
            },
          ],
        },
      },
    }) + "\\n");
  }
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}
function fail(id, message) {
  process.stdout.write(JSON.stringify({ id, error: { code: -32000, message } }) + "\\n");
}
`);
  await writeFile(statePath, JSON.stringify({
    version: 1,
    gatherThreadSessionId: "session-1",
    workspacePath: directory,
    threadId: "legacy-exec-thread",
    coveredThroughSequence: 99,
  }));

  const revealedThreads: string[] = [];
  const harness = new CodexProjectHarness({
    workspacePath: directory,
    stateRoot,
    mappingId: "mapping-1",
    projectName: "Project Atlas",
    model: "gpt-test",
    command: process.execPath,
    commandArgs: [fakeCodex],
    env: {
      ...process.env,
      FAKE_CODEX_CAPTURE: capturePath,
      GATHERTHREAD_TOKEN: "gta_secret-that-must-not-reach-codex",
    },
    maxInjectionItemBytes: 1024,
    contextWindowTokens: 4096,
    contextHighWatermark: 0.26,
    revealThread: async (threadId) => {
      revealedThreads.push(threadId);
      return true;
    },
  });
  t.after(() => harness.close());
  const preflight = await harness.preflight();
  assert.match(preflight.version, /test-version/);
  assert.match(preflight.authentication, /Logged in/);

  const binding = harness.createSessionBinding({
    session: { id: "session-1", projectId: "project-1", name: "Planning", mode: "multi" },
    sessionKey: "session-key",
    statePath,
  });
  assert.equal(binding.synchronizeLocalTurns, undefined,
    "desktop local-turn upload stays disabled without explicitly enabled trusted hooks");
  assert.equal(binding.synchronizeCanonicalHistory, undefined,
    "visible Desktop projection stays disabled without explicitly enabled trusted hooks");
  const runtime = registeredRuntime(binding.localSessionId);
  const firstRequest = canonical(2, "agent_request", {
    content: "implement first",
    execution_profile: { harness: "codex", model: "gpt-5.6-terra", reasoning_effort: "high" },
  });
  const progress: Array<{ id: string; content: string }> = [];
  const first = await binding.executor.execute({
    request: firstRequest,
    canonicalHistory: [canonical(1, "human_chat", { content: "shared constraint" }, "user-2"), firstRequest],
    runtime,
    publishProgress: async (update) => { progress.push(update); },
  });
  assert.equal(first.localSessionId, "thread-app-server-1");
  assert.deepEqual(first.events.map((event) => event.kind), ["tool_call", "tool_result", "assistant"]);
  assert.equal(first.events.at(-1)?.content, "first app answer");
  assert.equal(first.observedModel, "gpt-5.6-terra");
  assert.equal(first.observedReasoningEffort, "high");
  assert.deepEqual(progress, [{ id: "commentary-1", content: "Checking turn 1" }]);
  assert.deepEqual(revealedThreads, [], "background execution tasks must never be opened in Desktop");

  const secondRequest = canonical(5, "agent_request", { content: "implement second" });
  const second = await binding.executor.execute({
    request: secondRequest,
    canonicalHistory: [
      canonical(1, "human_chat", { content: "shared constraint" }, "user-2"),
      firstRequest,
      canonical(3, "agent_response", { text: "first app answer" }, "user-1", runtimeProvenance(runtime)),
      canonical(4, "human_chat", { content: `new shared context ${"x".repeat(4_000)}` }, "user-2"),
      secondRequest,
    ],
    runtime,
  });
  assert.equal(second.events.at(-1)?.content, "second app answer");
  assert.deepEqual(revealedThreads, [], "replacement Web turns stay in the background projection");

  const captures = (await readFile(capturePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(captures.every((capture) => capture.gatherThreadTokenPresent === false));
  const starts = captures.filter((capture) => capture.message.method === "thread/start");
  const resumes = captures.filter((capture) => capture.message.method === "thread/resume");
  assert.equal(starts.length, 1, "a process-owned ephemeral projection must be created exactly once");
  assert.equal(starts[0].message.params.ephemeral, true, "background execution must not create a user-visible Desktop task");
  assert.equal(starts[0].message.params.approvalPolicy, "never");
  assert.equal(starts[0].message.params.threadSource, "exec");
  assert.equal(starts[0].message.params.historyMode, "legacy");
  assert.equal(starts[0].message.params.serviceName, "gatherthread");
  const initialize = captures.find((capture) => capture.message.method === "initialize");
  assert.equal(initialize.message.params.capabilities.experimentalApi, true);
  assert.equal(resumes.length, 0, "a loaded ephemeral projection must not be resumed through the persistent-thread API");
  const names = captures.filter((capture) => capture.message.method === "thread/name/set");
  assert.equal(names.length, 0, "ephemeral background threads must never receive unsupported metadata updates");
  assert.equal(captures.filter((capture) => capture.message.method === "thread/archive").length, 0,
    "ephemeral background threads must never receive unsupported archival updates");
  assert.equal(captures.filter((capture) => capture.message.method === "thread/unsubscribe").length, 0,
    "ephemeral background threads must remain loaded between connector operations");
  const injections = captures.filter((capture) => capture.message.method === "thread/inject_items");
  assert.ok(injections.length >= 5, "oversized canonical events are injected as bounded chunks");
  assert.match(injections[0].message.params.items[0].content[0].text, /user-2 · Human Chat：shared constraint/);
  assert.match(injections.slice(1).map((capture) => capture.message.params.items[0].content[0].text).join(""), /new shared context/);
  assert.ok(injections.every((capture) => Buffer.byteLength(capture.message.params.items[0].content[0].text) < 1_200));
  const compactCount = captures.filter((capture) => capture.message.method === "thread/compact/start").length;
  assert.ok(compactCount >= 2);
  const turns = captures.filter((capture) => capture.message.method === "turn/start");
  assert.equal(turns[0].message.params.model, "gpt-5.6-terra");
  assert.equal(turns[0].message.params.effort, "high");
  assert.equal(turns[1].message.params.model, "gpt-test");
  assert.equal(turns[1].message.params.effort, undefined);
  const firstPrompt = turns[0].message.params.input[0].text;
  const secondPrompt = turns[1].message.params.input[0].text;
  assert.doesNotMatch(firstPrompt, /shared constraint/);
  assert.match(firstPrompt, /implement first/);
  assert.doesNotMatch(secondPrompt, /shared constraint/);
  assert.doesNotMatch(secondPrompt, /first app answer/);
  assert.match(secondPrompt, /implement second/);

  const state = JSON.parse(await readFile(`${statePath}.execution.json`, "utf8"));
  assert.equal(state.version, 3);
  assert.equal(state.transport, "app-server");
  assert.equal(state.threadId, "thread-app-server-1");
  assert.equal(state.coveredThroughSequence, 5);
  assert.equal(state.lastInjectedSequence, 5);
  assert.equal(state.cloudCursor, 5);
  assert.equal(state.model, "gpt-test");
  assert.equal(state.contextWindowTokens, 4096);
  assert.equal(state.projectionGeneration, 1);
  assert.equal(state.compactionGeneration, compactCount);
  assert.deepEqual(state.sidecar.map((entry: { sequence: number }) => entry.sequence), [1, 2, 3, 4, 5]);
});

test("project harness shares one background App Server across session projections", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-project-process-"));
  const stateRoot = path.join(directory, "state");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex-app-server.mjs");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
if (process.argv[2] !== "app-server") process.exit(2);
let nextThread = 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  await appendFile(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({ pid: process.pid, method: message.method }) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake", codexHome: "/tmp/fake" });
  } else if (message.method === "thread/start") {
    nextThread += 1;
    respond(message.id, { thread: { id: "thread-" + process.pid + "-" + nextThread } });
  } else {
    respond(message.id, {});
  }
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}
`);

  const harness = new CodexProjectHarness({
    workspacePath: directory,
    stateRoot,
    mappingId: "mapping-shared-process",
    projectName: "Shared process",
    model: "gpt-test",
    command: process.execPath,
    commandArgs: [fakeCodex],
    env: { ...process.env, FAKE_CODEX_CAPTURE: capturePath },
  });
  t.after(() => harness.close());
  const first = harness.createSessionBinding({
    session: { id: "session-1", projectId: "project-1", name: "One", mode: "multi" },
    sessionKey: "one",
    statePath: path.join(stateRoot, "one-session.json"),
  });
  const second = harness.createSessionBinding({
    session: { id: "session-2", projectId: "project-1", name: "Two", mode: "multi" },
    sessionKey: "two",
    statePath: path.join(stateRoot, "two-session.json"),
  });

  await first.executor.prepareCanonicalProjection?.({
    ...registeredRuntime(first.localSessionId),
    sessionId: "session-1",
  });
  await second.executor.prepareCanonicalProjection?.({
    ...registeredRuntime(second.localSessionId),
    sessionId: "session-2",
  });

  const starts = (await readFile(capturePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { pid: number; method: string })
    .filter((entry) => entry.method === "thread/start");
  assert.equal(starts.length, 2, "each session still owns an independent native thread");
  assert.equal(new Set(starts.map((entry) => entry.pid)).size, 1,
    "all background session threads must share one project-scoped App Server process");
});

function registeredRuntime(localSessionId: string): RegisteredRuntime {
  return {
    id: "runtime-1",
    runtimeId: "runtime-1",
    userId: "user-1",
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-test",
    localSessionId,
    captureFidelity: "harness_transcript",
  };
}

function runtimeProvenance(runtime: RegisteredRuntime) {
  return {
    userId: runtime.userId,
    deviceId: runtime.deviceId,
    runtimeId: runtime.id,
    harness: runtime.harness,
    provider: runtime.provider,
    model: runtime.model,
    localSessionId: runtime.localSessionId,
    captureFidelity: runtime.captureFidelity,
  };
}

function canonical(
  sequence: number,
  type: CanonicalEvent["type"],
  payload: unknown,
  actorId = "user-1",
  runtime?: CanonicalEvent["runtime"],
): CanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type,
    actorId,
    timestamp: `2026-08-25T00:00:0${sequence}.000Z`,
    payload,
    ...(runtime === undefined ? {} : { runtime }),
  };
}

function completedTurn(turnId: string, clientId: string | null, request: string, response: string): {
  id: string;
  status: string;
  startedAt: number;
  completedAt: number;
  items: Array<Record<string, unknown>>;
} {
  return {
    id: turnId,
    status: "completed",
    startedAt: 1_787_676_000,
    completedAt: 1_787_676_001,
    items: [
      { type: "userMessage", id: `${turnId}-user`, clientId, content: [{ type: "text", text: request }] },
      { type: "agentMessage", id: `${turnId}-assistant`, phase: "final_answer", text: response },
    ],
  };
}

function projectionState(workspacePath: string) {
  return {
    version: 3,
    transport: "app-server",
    gatherThreadSessionId: "session-1",
    workspacePath,
    threadId: "old-thread",
    threadName: "GatherThread · rebuild",
    model: "gpt-test",
    contextWindowTokens: 128000,
    estimatedContextTokens: 100,
    cloudCursor: 2,
    desktopDeliveryCursor: 2,
    projectionGeneration: 1,
    compactionGeneration: 0,
    coveredThroughSequence: 2,
    lastInjectedSequence: 2,
    sidecar: [],
    connectorClientMessageIds: [],
    connectorTurnIds: [],
    localTurnBindings: {},
    pendingLocalTurns: [],
  };
}

function pendingOperationFakeCodex(): string {
  return `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const capture = process.env.CAPTURE;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  appendFileSync(capture, JSON.stringify({ method: message.method, pid: process.pid }) + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
}
`;
}

async function waitForCapturedMethod(capturePath: string, method: string, expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const captures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string });
      if (captures.filter((capture) => capture.method === method).length >= expectedCount) return;
    } catch {
      // The child creates the capture file after it starts.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${method}`);
}
