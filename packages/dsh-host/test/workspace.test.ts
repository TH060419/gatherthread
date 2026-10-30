import assert from "node:assert/strict";
import test from "node:test";
import { dshWorkspaceAction, DshWorkspaceError, workspaceErrorCode, type DshWorkspaceOptions } from "../src/workspace.js";
import type { DshNativeGrant } from "../src/native-connection.js";

const grant: DshNativeGrant = { schemaVersion: 2, serverUrl: "https://workspace.example", apiUrl: "https://workspace.example/v1",
  deviceId: "device-a", deviceName: "Fixture", token: "fixture-never-visible", route: { provider: "deepseek", model: "fixture" } };
function event(sequence = 1, extra: Record<string, unknown> = {}) {
  return { id: `event-${sequence}`, session_id: "session-a", actor_user_id: "member-b", actor_display_name: "参与者 B", sequence,
    type: "human_chat", created_at: "2026-10-29T12:00:00Z", payload: { content: "大家统一采用蓝色按钮", private_tool: "must-not-cross" }, ...extra };
}
function fixture() {
  const writes: Record<string, any>[] = [], calls: string[] = [];
  const state = { role: "participant", mode: "multi", owner: "member-a", sessionRole: "participant", active: true, runtime: "runtime-a",
    revision: 0, events: [event()], current: true, onRead: () => {}, onMembers: () => {}, denied: false };
  const options: DshWorkspaceOptions = {
    grant, signal: new AbortController().signal,
    assertCurrent() { if (!state.current) throw new DshWorkspaceError("workspace_connection_changed"); },
    runtime: () => state.runtime || undefined,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push(url.pathname + url.search);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${grant.token}`);
      const data = (body: unknown) => Response.json({ data: body });
      if (url.pathname === "/v1/me") return data({ id: "member-a", username: "参与者 A", device_id: "device-a" });
      if (state.denied) return Response.json({ error: { code: "forbidden", message: "private diagnostic" } }, { status: 403 });
      if (url.pathname === "/v1/projects") return data({ projects: state.active ? [{ id: "project-a", title: "共享工作区", state: "active", role: state.role, session_count: 1 }] : [] });
      if (url.pathname === "/v1/projects/project-a") return data({ session_visibility_options: ["project", "private"] });
      if (url.pathname === "/v1/projects/project-a/sessions" || (url.pathname === "/v1/sessions/session-a" && init?.method === "PATCH")) {
        const s = { id: "session-a", project_id: "project-a", owner_user_id: state.owner, title: "设计讨论", mode: state.mode, state: "active", role: state.sessionRole };
        if (init?.method === "POST" || init?.method === "PATCH") { const body = JSON.parse(String(init.body)); writes.push(body); return data({ session: { ...s, title: body.title, mode: body.mode ?? s.mode } }); }
        return data({ sessions: [s] });
      }
      if (url.pathname.endsWith("/pause")) { writes.push({ pause: true }); return data({ request_event_id: "event-1", runtime_id: "runtime-a", status: "paused" }); }
      if (url.pathname.endsWith("/avatar-profiles")) return data({ profiles: [{ user_id: "member-b", avatar_id: "fox" }] });
      if (url.pathname.endsWith("/members")) { state.onMembers(); return data({ members: [{ user_id: "member-b", display_name: "参与者 B", role: "participant", runtime: null }] }); }
      if (url.pathname.endsWith("/context")) return data({ view: "summary", through_sequence: 2, content_revision: state.revision,
        items: [{ kind: "original", event_id: "event-1", sequence: 1, actor_user_id: "member-b", content: "大家统一采用蓝色按钮" }] });
      if (url.pathname.endsWith("/events")) {
        if (init?.method === "POST") { const body = JSON.parse(String(init.body)); writes.push(body); return data(event(2, { type: body.type, payload: body.payload })); }
        state.onRead();
        return data({ events: state.events.filter(e => e.sequence > Number(url.searchParams.get("after_sequence"))),
          cursor: state.events.length, has_more: false, content_revision: state.revision });
      }
      throw new Error(`Unexpected fixture route ${url.pathname}`);
    }) as typeof fetch,
  };
  async function scope() {
    const list = await dshWorkspaceAction({ action: "list" }, options) as { connectionId: string };
    return { connectionId: list.connectionId, projectId: "project-a", sessionId: "session-a" };
  }
  return { options, state, writes, calls, scope };
}
const rejectsCode = (code: string) => (error: unknown) => error instanceof DshWorkspaceError && error.code === code;

test("workspace shows canonical attribution and only allowlisted visible content", async () => {
  const f = fixture(); f.state.events.push(event(2, { type: "tool_result", payload: { content: "private-tool-content" } }));
  const listing = await dshWorkspaceAction({ action: "list" }, f.options) as any;
  assert.equal(listing.webUrl, "https://workspace.example/app/");
  assert.doesNotMatch(JSON.stringify(listing), /fixture-never-visible|device-a/);
  const result = await dshWorkspaceAction({ action: "read", ...await f.scope(), afterSequence: 0 }, f.options) as any;
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].author, "参与者 B");
  assert.equal(result.messages[0].content, "大家统一采用蓝色按钮");
  assert.equal(result.cursor, 2, "cursor covers filtered events too");
  assert.doesNotMatch(JSON.stringify(result), /fixture-never-visible|must-not-cross|private-tool-content/);
  assert.deepEqual(result.avatars, [{ user_id: "member-b", avatar_id: "fox" }]);
  assert.equal(result.members[0].userId, "member-b");
});

test("long message expansion is bounded, revision checked and never expands tools or erased content", async () => {
  const f = fixture(), scope = await f.scope();
  f.state.events = [event(1, { payload: { content: "中".repeat(40000), hidden_reasoning: "never-visible" } })];
  const input = { action: "message", ...scope, eventId: "event-1", sequence: 1, contentRevision: 0 };
  const preview = await dshWorkspaceAction({ action: "read", ...scope, afterSequence: 0 }, f.options) as any;
  assert.equal(preview.messages[0].content.length, 4000);
  const full = await dshWorkspaceAction(input, f.options) as any;
  assert.equal(full.message.content.length, 32000); assert.equal(full.message.truncated, true);
  assert.doesNotMatch(JSON.stringify(full), /never-visible/);
  await assert.rejects(dshWorkspaceAction({ ...input, eventId: "foreign-event" }, f.options), rejectsCode("workspace_request_unavailable"));
  f.state.revision = 1;
  await assert.rejects(dshWorkspaceAction(input, f.options), rejectsCode("workspace_conflict"));
  f.state.events = [event(1, { deleted: { deleted_at: "2026-10-30T13:00:00Z", reason: "author" } })];
  const erased = await dshWorkspaceAction({ ...input, contentRevision: 1 }, f.options) as any;
  assert.equal(erased.message.content, ""); assert.equal(erased.message.deleted, true);
  f.state.events = [event(1, { type: "tool_result", payload: { content: "never-expand" } })];
  await assert.rejects(dshWorkspaceAction({ ...input, contentRevision: 1 }, f.options), rejectsCode("workspace_request_unavailable"));
  f.state.active = false;
  await assert.rejects(dshWorkspaceAction(input, f.options), rejectsCode("workspace_access_denied"));
});

test("shared reply attribution comes from server proof, never payload claims", async () => {
  const f = fixture();
  f.state.events = [event(1, { type: "agent_response", payload: { content: "done", shared_agent: { executor_owner_user_id: "forged-owner" } } })];
  const result = await dshWorkspaceAction({ action: "read", ...await f.scope(), afterSequence: 0 }, f.options) as any;
  assert.equal(result.messages[0].ownerId, "member-b");
  assert.doesNotMatch(JSON.stringify(result), /forged-owner/);
  f.state.events = [event(1, { type: "agent_response", payload: { content: "done" }, shared_execution: {
    share_id: "share-a", share_revision: 1, job_id: "job-a", executor_owner_user_id: "member-a", executor_owner_display_name: "持有者 A",
    execution_profile: { harness: "codex", provider: "openai", model: "fixture" }
  } })];
  const shared = await dshWorkspaceAction({ action: "read", ...await f.scope(), afterSequence: 0 }, f.options) as any;
  assert.equal(shared.messages[0].ownerId, "member-a"); assert.equal(shared.messages[0].author, "持有者 A");
});

test("optional avatar compatibility never swallows revoked access", async () => {
  for (const status of [404, 403]) {
    const f = fixture(), original = f.options.fetch!;
    f.options.fetch = (async (input: any, init: any) => String(input).endsWith('/avatar-profiles')
      ? Response.json({ error: { code: 'forbidden', message: 'private' } }, { status }) : original(input, init)) as typeof fetch;
    const action = dshWorkspaceAction({ action: "read", ...await f.scope(), afterSequence: 0 }, f.options);
    if (status === 404) assert.deepEqual((await action as any).avatars, []);
    else await assert.rejects(action, (error: any) => error.status === 403);
  }
});
test("workspace chat and Agent intent remain explicit and exact-runtime scoped", async () => {
  const f = fixture(), scope = await f.scope();
  const input = { action: "send", ...scope, kind: "agent", content: "基于团队讨论提建议", runtimeId: "runtime-a", idempotencyKey: "retry-identity-1" };
  await dshWorkspaceAction(input, f.options);
  await dshWorkspaceAction(input, f.options);
  assert.deepEqual(f.writes[0], f.writes[1]);
  assert.equal(f.writes[0]!.type, "agent_request");
  assert.deepEqual(f.writes[0]!.payload.execution_profile, { harness: "deepseek-harness", provider: "deepseek", model: "fixture", runtime_id: "runtime-a" });
  await dshWorkspaceAction({ ...input, kind: "chat", idempotencyKey: "chat-identity-1" }, f.options);
  assert.equal(f.writes[2]!.type, "human_chat");
  assert.equal(f.writes[2]!.payload.execution_profile, undefined);
  await assert.rejects(dshWorkspaceAction({ ...input, runtimeId: "other-device" }, f.options), rejectsCode("workspace_agent_unavailable"));
});
for (const change of ["project-viewer", "session-viewer", "other-solo", "removed-project"] as const) {
  test(`workspace rechecks write permission: ${change}`, async () => {
    const f = fixture(), scope = await f.scope();
    if (change === "project-viewer") f.state.role = "viewer";
    if (change === "session-viewer") f.state.sessionRole = "viewer";
    if (change === "other-solo") { f.state.mode = "solo"; f.state.owner = "member-b"; }
    if (change === "removed-project") f.state.active = false;
    await assert.rejects(dshWorkspaceAction({ action: "send", ...scope, kind: "chat", content: "hi", idempotencyKey: "never-write" }, f.options),
      rejectsCode(change === "removed-project" ? "workspace_access_denied" : "workspace_read_only"));
    assert.equal(f.writes.length, 0);
  });
}
test("workspace refuses browser-supplied URLs, metadata and a stale connection", async () => {
  const f = fixture(), scope = await f.scope();
  for (const extra of [{ url: "https://other.example" }, { payload: { unsafe: true } }, { provider: "different" }]) {
    await assert.rejects(dshWorkspaceAction({ action: "send", ...scope, kind: "chat", content: "hi", idempotencyKey: "never-write", ...extra }, f.options), rejectsCode("workspace_invalid_input"));
  }
  await assert.rejects(dshWorkspaceAction({ action: "context", ...scope, connectionId: "stale-account" }, f.options), rejectsCode("workspace_connection_changed"));
  assert.equal(f.writes.length, 0);
});
test("disconnect during history fetch cannot return old account content", async () => {
  const f = fixture(), scope = await f.scope(); f.state.onRead = () => { f.state.current = false; };
  await assert.rejects(dshWorkspaceAction({ action: "read", ...scope, afterSequence: 0 }, f.options), rejectsCode("workspace_connection_changed"));
});
test("a deletion revision forces replay, and erased payload is never displayed", async () => {
  const f = fixture(), scope = await f.scope(); f.state.revision = 1;
  f.state.events = [event(1, { deleted: { deleted_at: "2026-10-29T13:00:00Z", reason: "author" } })];
  const result = await dshWorkspaceAction({ action: "read", ...scope, afterSequence: 1, contentRevision: 0 }, f.options) as any;
  assert.equal(result.reset, true); assert.equal(result.contentRevision, 1); assert.equal(result.messages[0].content, "");
  assert.ok(f.calls.some(url => url.includes("after_sequence=0")));
});
test("effective context retains actor attribution without raw transcript fallback", async () => {
  const f = fixture();
  const result = await dshWorkspaceAction({ action: "context", ...await f.scope() }, f.options) as any;
  assert.deepEqual(result.items[0], { id: "event-1", actorId: "member-b", type: "original", content: "大家统一采用蓝色按钮", truncated: false });
  assert.equal(result.totalItems, 1);
});
test("terminal failure/timeout is displayed while internal error details stay private", async () => {
  const f = fixture(); f.state.events = [event(1, { type: "agent_response", payload: { content: "Task timed out", status: "failed", outcome: "timeout", error: { stack: "private-stack" } } })];
  const result = await dshWorkspaceAction({ action: "read", ...await f.scope(), afterSequence: 0 }, f.options) as any;
  assert.equal(result.messages[0].status, "timeout"); assert.doesNotMatch(JSON.stringify(result), /private-stack/);
});
test("access failures have actionable fixed codes and no diagnostic text", async () => {
  const f = fixture(), scope = await f.scope(); f.state.denied = true;
  try { await dshWorkspaceAction({ action: "context", ...scope }, f.options); assert.fail(); }
  catch (error) { assert.equal(workspaceErrorCode(error), "workspace_access_denied"); }
  assert.equal(workspaceErrorCode(new Error("sensitive diagnosis")), "workspace_unavailable");
});

test("workspace session creation is idempotent and Solo is explicitly private; renaming respects ownership", async () => {
  const f = fixture(), scope = await f.scope();
  const { sessionId: _sessionId, ...project } = scope;
  const input = { action: "createSession", ...project, title: "私有笔记", mode: "solo", idempotencyKey: "same-create" };
  await dshWorkspaceAction(input, f.options); await dshWorkspaceAction(input, f.options);
  assert.deepEqual(f.writes[0], f.writes[1]); assert.equal(f.writes[0]!.visibility, "private");
  await assert.rejects(dshWorkspaceAction({ action: "renameSession", ...scope, title: "改名", idempotencyKey: "rename" }, f.options), rejectsCode("workspace_read_only"));
  f.state.sessionRole = "owner";
  await dshWorkspaceAction({ action: "renameSession", ...scope, title: "改名", idempotencyKey: "rename" }, f.options);
  assert.equal(f.writes[2]!.title, "改名");
  f.state.role = "viewer";
  await assert.rejects(dshWorkspaceAction(input, f.options), rejectsCode("workspace_read_only"));
});
test("workspace model selection is exact, quotes carry IDs, revisions reach the server", async () => {
  const f = fixture(), scope = await f.scope();
  f.options.profiles = () => [{ provider: "deepseek", model: "reasoner", reasoningEfforts: ["low", "high"] }];
  const input = { action: "send", ...scope, kind: "agent", content: "总结", runtimeId: "runtime-a", idempotencyKey: "chosen-model", contentRevision: 0,
    replyTo: "event-1", selection: { provider: "deepseek", model: "reasoner", reasoningEffort: "high" } };
  await dshWorkspaceAction(input, f.options);
  assert.deepEqual(f.writes[0]!.payload.execution_profile, { harness: "deepseek-harness", provider: "deepseek", model: "reasoner", reasoning_effort: "high", runtime_id: "runtime-a" });
  assert.equal(f.writes[0]!.reply_to_event_id, "event-1"); assert.equal(f.writes[0]!.content_revision, 0);
  for (const selection of [{ provider: "deepseek", model: "removed" }, { provider: "deepseek", model: "reasoner", reasoningEffort: "unsupported" }]) {
    await assert.rejects(dshWorkspaceAction({ ...input, selection }, f.options), rejectsCode("workspace_model_unavailable"));
  }
  assert.equal(f.writes.length, 1);
});
test("workspace pause/resume resolve the author-owned local canonical request and reject foreign/terminal/stale requests", async () => {
  const f = fixture(), scope = await f.scope();
  const request = event(1, { actor_user_id: "member-a", type: "agent_request", payload: { content: "原任务", execution_profile: { harness: "deepseek-harness", provider: "deepseek", model: "fixture", runtime_id: "runtime-a" } } });
  const paused = event(2, { type: "agent_progress", reply_to_event_id: "event-1", payload: { content: "Paused", status: "paused" } });
  f.state.events = [request, paused];
  const input = { ...scope, requestId: "event-1", requestSequence: 1, contentRevision: 0 };
  await dshWorkspaceAction({ action: "pause", ...input }, f.options);
  const resume = { action: "resume", ...input, idempotencyKey: "resume-once" };
  await dshWorkspaceAction(resume, f.options); await dshWorkspaceAction(resume, f.options);
  assert.equal(f.writes[1]!.payload.content, "原任务"); assert.deepEqual(f.writes[1], f.writes[2]);
  f.state.events.push(event(3, { type: "agent_response", reply_to_event_id: "event-1" }));
  await assert.rejects(dshWorkspaceAction(resume, f.options), rejectsCode("workspace_request_unavailable"));
  f.state.events = [request, paused]; f.state.revision = 1;
  await assert.rejects(dshWorkspaceAction(resume, f.options), rejectsCode("workspace_conflict"));
  f.state.revision = 0;
  for (const extra of [{ actor_user_id: "member-b" }, { deleted: { deleted_at: "2026-10-29T12:00:00Z", reason: "author" } }, { payload: { ...(request.payload as any), agent_team: {} } },
    { payload: { ...(request.payload as any), execution_profile: { ...(request.payload as any).execution_profile, runtime_id: "other-runtime" } } }]) {
    f.state.events = [{ ...request, ...extra }, paused];
    await assert.rejects(dshWorkspaceAction({ action: "pause", ...input }, f.options), rejectsCode("workspace_request_unavailable"));
  }
  assert.equal(f.writes.length, 3);
});

test("workspace local file access is exact project/session scoped and denied to read-only actors", async () => {
  const f = fixture(), scope = await f.scope(); let reads = 0;
  f.options.files = ((projectId: string, sessionId: string) => {
    assert.equal(projectId, 'project-a'); assert.equal(sessionId, 'session-a');
    return { nativeSessionId: 'native-a', files: { tree: async () => { reads++; return { kind: 'localTree', directory: '/project', entries: [], truncated: false, busy: false }; } } };
  }) as unknown as NonNullable<DshWorkspaceOptions['files']>;
  await dshWorkspaceAction({ action: 'files', ...scope, request: { operation: 'localTree' } }, f.options);
  assert.equal(reads, 1);
  f.state.sessionRole = 'viewer';
  await assert.rejects(dshWorkspaceAction({ action: 'files', ...scope, request: { operation: 'localTree' } }, f.options), rejectsCode('workspace_read_only'));
  assert.equal(reads, 1);
  await assert.rejects(dshWorkspaceAction({ action: 'files', ...scope, request: { operation: 'localRead', path: '../../private' } }, f.options), rejectsCode('workspace_invalid_input'));
});
test("workspace does not return local file data after account revocation", async () => {
  const f = fixture(), scope = await f.scope();
  f.options.files = (() => ({ nativeSessionId: 'native-a', files: { read: async () => {
    f.state.current = false; return { kind: 'text', path: 'a.txt', text: 'private-local-text' };
  } } })) as unknown as NonNullable<DshWorkspaceOptions['files']>;
  await assert.rejects(dshWorkspaceAction({ action: 'files', ...scope, request: { operation: 'localRead', path: 'a.txt' } }, f.options), rejectsCode('workspace_connection_changed'));
});
