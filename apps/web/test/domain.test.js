import test from "node:test";
import assert from "node:assert/strict";

import {
  canAppend,
  canRetryFailedAgentRequest,
  createSelectionGuard,
  eventContent,
  eventLabel,
  failedRequestFor,
  invitationStatus,
  invitationStatusLabel,
  invitationRolePolicy,
  hasOnlineSnapshotConnector,
  isExecutionRuntime,
  isFailedAgentResponse,
  isTimelineEventVisible,
  normalizeConnectorState,
  normalizeInvitation,
  normalizeReplayPage,
  normalizeSnapshotRequest,
  pendingAgentRequests,
  projectCodexConnectionCommands,
  provenanceSummary,
  retryAgentRequestInput,
  runtimeLabel,
  sessionMetadataFromEvent,
  sessionDeliveryMode,
  snapshotStatusView,
} from "../src/domain.js";

test("project Codex commands are cross-platform, quoted, and credential-free", () => {
  const commands = projectCodexConnectionCommands({
    baseUrl: "https://gatherthread.example/v1",
    projectId: "project-alpha_1",
  });
  assert.equal(
    commands.posix,
    "npx --yes @gatherthread/codex-connect@0.1.0-alpha.5 --url 'https://gatherthread.example/v1' --project 'project-alpha_1' --create-workspace --plugin-hooks --visible-history-sync first-connect",
  );
  assert.equal(
    commands.powershell,
    "npx.cmd --yes @gatherthread/codex-connect@0.1.0-alpha.5 --url 'https://gatherthread.example/v1' --project 'project-alpha_1' --create-workspace --plugin-hooks --visible-history-sync first-connect",
  );
  for (const command of Object.values(commands)) {
    assert.match(command, /--url 'https:\/\/gatherthread\.example\/v1'/);
    assert.match(command, /--project 'project-alpha_1'/);
    assert.match(command, /--create-workspace/);
    assert.match(command, /--plugin-hooks/);
    assert.doesNotMatch(command, /--model|--context-window-tokens|--install-hooks/);
    assert.doesNotMatch(command, /access[-_ ]?token|Bearer|cookie|password/i);
  }

  for (const visibleHistorySync of ["first-connect", "never"]) {
    const selected = projectCodexConnectionCommands({
      baseUrl: "https://gatherthread.example",
      projectId: "project-alpha",
      visibleHistorySync,
    });
    assert.match(selected.posix, new RegExp(`--visible-history-sync ${visibleHistorySync}`));
    assert.match(selected.powershell, new RegExp(`--visible-history-sync ${visibleHistorySync}`));
  }
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "https://gatherthread.example",
    projectId: "project-alpha",
    visibleHistorySync: "sometimes",
  }), /visible history sync mode is not safe/);
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "https://user:secret@gatherthread.example",
    projectId: "project-alpha",
  }), /not safe/);
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "https://gatherthread.example",
    projectId: "project-alpha'; Remove-Item -Recurse ~; '",
  }), /project ID is not safe/);
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "http://gatherthread.example",
    projectId: "project-alpha",
  }), /URL is not safe/);
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "https://gatherthread.example?device_token=secret",
    projectId: "project-alpha",
  }), /URL is not safe/);
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "https://gatherthread.example/untrusted-path",
    projectId: "project-alpha",
  }), /URL is not safe/);

  const quoted = projectCodexConnectionCommands({
    baseUrl: "http://localhost:4317/",
    projectId: "project-alpha",
    model: "gpt-'preview",
    contextWindowTokens: 257_000,
  });
  assert.match(quoted.posix, /--model 'gpt-'"'"'preview'/);
  assert.match(quoted.powershell, /--model 'gpt-''preview'/);
  assert.match(quoted.posix, /--context-window-tokens 257000/);
  assert.match(quoted.powershell, /--context-window-tokens 257000/);
  assert.throws(() => projectCodexConnectionCommands({
    baseUrl: "https://gatherthread.example",
    projectId: "project-alpha",
    contextWindowTokens: 3,
  }), /context window is not safe/);
  for (const model of ["   ", "--dangerous-model-option"]) {
    assert.throws(() => projectCodexConnectionCommands({
      baseUrl: "https://gatherthread.example",
      projectId: "project-alpha",
      model,
    }), /model is not safe/);
  }
});

const currentUser = { id: "u1", username: "User One" };
const onlineRuntime = { status: "online", harness: "Codex", provider: "OpenAI", model: "gpt-5" };

function session({ mode = "multi", role = "participant", runtime = onlineRuntime } = {}) {
  return { mode, members: [{ userId: "u1", role, runtime }] };
}

test("permissions distinguish chat from runtime-backed agent requests", () => {
  assert.equal(
    canAppend({ session: session({ runtime: null }), currentUser, connectionPhase: "live", kind: "human_chat" }).allowed,
    true,
  );
  const agent = canAppend({
    session: session({ runtime: null }),
    currentUser,
    connectionPhase: "live",
    kind: "agent_request",
  });
  assert.equal(agent.allowed, false);
  assert.match(agent.reason, /runtime/i);
});

test("selection generations reject a slower project response after a newer choice", async () => {
  const guard = createSelectionGuard();
  const commits = [];
  let resolveA;
  const slowA = new Promise((resolve) => { resolveA = resolve; });
  const selectionA = guard.begin("project-a");
  const pendingA = slowA.then(() => {
    if (guard.isCurrent(selectionA)) commits.push("project-a");
  });
  const selectionB = guard.begin("project-b");
  if (guard.isCurrent(selectionB)) commits.push("project-b");
  resolveA();
  await pendingA;
  assert.deepEqual(commits, ["project-b"]);
});

test("only execution runtimes can back agent requests", () => {
  const snapshotRuntime = { ...onlineRuntime, purpose: "snapshot_connector" };
  const agent = canAppend({
    session: session({ runtime: snapshotRuntime }),
    currentUser,
    connectionPhase: "live",
    kind: "agent_request",
  });
  assert.equal(agent.allowed, false);
  assert.equal(isExecutionRuntime(snapshotRuntime), false);
  assert.equal(isExecutionRuntime({ ...onlineRuntime, purpose: "execution" }), true);
  assert.equal(isExecutionRuntime(onlineRuntime), true);
  assert.equal(hasOnlineSnapshotConnector([{ runtime: snapshotRuntime }]), true);
});

test("session delivery mode keeps owners and multi participants live", () => {
  assert.equal(sessionDeliveryMode({ role: "owner", mode: "solo" }), "live");
  assert.equal(sessionDeliveryMode({
    role: "participant", mode: "solo", ownerUserId: "participant-1", currentUserId: "participant-1",
  }), "live");
  assert.equal(sessionDeliveryMode({
    role: "owner", mode: "solo", ownerUserId: "participant-1", currentUserId: "project-owner",
  }), "snapshot");
  assert.equal(sessionDeliveryMode({ role: "participant", mode: "multi" }), "live");
  assert.equal(sessionDeliveryMode({ role: "participant", mode: "solo" }), "snapshot");
  assert.equal(sessionDeliveryMode({ role: "viewer", mode: "multi" }), "snapshot");
  assert.equal(sessionDeliveryMode({ role: "viewer", mode: "solo" }), "snapshot");
});

test("snapshot requests normalize the frozen wire record and extended progress", () => {
  const queued = normalizeSnapshotRequest({ snapshot_request: {
    id: "snap-1",
    session_id: "s1",
    through_sequence: 42,
    status: "pending",
    created_at: "2026-08-25T10:00:00.000Z",
    result: null,
    failure: null,
  } });
  assert.deepEqual(
    { id: queued.id, sessionId: queued.sessionId, throughSequence: queued.throughSequence, status: queued.status },
    { id: "snap-1", sessionId: "s1", throughSequence: 42, status: "queued" },
  );
  const completed = normalizeSnapshotRequest({ request: {
    id: "snap-2",
    sessionId: "s1",
    throughSequence: 51,
    status: "completed",
    result: { thread_name: "GatherThread · Research notes", thread_id: "thread-1" },
  } });
  assert.equal(completed.localTaskName, "GatherThread · Research notes");
  assert.equal(normalizeSnapshotRequest({ id: "snap-3", status: "importing" }).status, "importing");
});

test("snapshot and connector status views use explicit non-bidirectional language", () => {
  assert.equal(snapshotStatusView({ status: "queued" }).detail, "Waiting for a local Codex connector.");
  assert.equal(snapshotStatusView({ status: "claimed" }).label, "Claimed");
  assert.equal(snapshotStatusView({ status: "importing" }).label, "Importing");
  assert.equal(snapshotStatusView({ status: "compacting" }).label, "Compacting");
  assert.equal(snapshotStatusView({ status: "completed", localTaskName: "Local task" }).detail, "Local task");
  assert.equal(snapshotStatusView({ status: "failed", failureMessage: "No workspace" }).retryable, true);

  assert.equal(normalizeConnectorState({ status: "synced" }).label, "Synced");
  assert.equal(normalizeConnectorState({ status: "offline", pending_count: 3 }).label, "Offline · 3 pending");
  assert.equal(normalizeConnectorState({ status: "reconciling" }).label, "Reconciling");
  assert.equal(normalizeConnectorState({ status: "rebuilding" }).label, "Rebuilding");
  assert.equal(normalizeConnectorState({ status: "local_fork" }).label, "Local fork");
  assert.equal(normalizeConnectorState(null, { phase: "recovering" }).status, "reconciling");
});

test("viewer and incomplete-history states are read only", () => {
  const viewer = canAppend({
    session: session({ role: "viewer" }),
    currentUser,
    connectionPhase: "live",
    kind: "human_chat",
  });
  assert.equal(viewer.allowed, false);
  assert.match(viewer.reason, /read only/i);

  const recovering = canAppend({
    session: session(),
    currentUser,
    connectionPhase: "recovering",
    kind: "human_chat",
  });
  assert.equal(recovering.allowed, false);
  assert.match(recovering.reason, /synced/i);
});

test("project invitations expose participant and viewer roles", () => {
  assert.deepEqual(invitationRolePolicy(), {
    allowedRoles: ["participant", "viewer"],
    defaultRole: "participant",
    locked: false,
    help: "Participants edit multi sessions and read solo sessions. Viewers are read only everywhere.",
  });
});

test("empty control events stay in canonical history but not in the conversation timeline", () => {
  assert.equal(isTimelineEventVisible({ type: "session_state_change", payload: { state: "active" } }), false);
  assert.equal(isTimelineEventVisible({ type: "membership_change", payload: { role: "viewer" } }), false);
  assert.equal(isTimelineEventVisible({ type: "session_state_change", payload: { content: "Session archived" } }), true);
  assert.equal(isTimelineEventVisible({ type: "human_chat", payload: { content: "Hello" } }), true);
});

test("session settings control events expose only validated metadata patches", () => {
  assert.deepEqual(sessionMetadataFromEvent({
    sessionId: "s1",
    type: "session_state_change",
    payload: { action: "renamed", title: "After 🚀" },
  }), { sessionId: "s1", name: "After 🚀" });
  assert.deepEqual(sessionMetadataFromEvent({
    sessionId: "s1",
    type: "session_state_change",
    payload: { action: "updated", mode: "solo" },
  }), { sessionId: "s1", mode: "solo" });
  assert.equal(sessionMetadataFromEvent({
    sessionId: "s1",
    type: "session_state_change",
    payload: { action: "renamed", title: "   " },
  }), null);
  assert.equal(sessionMetadataFromEvent({
    sessionId: "s1",
    type: "human_chat",
    payload: { action: "renamed", title: "Ignore" },
  }), null);
});

test("visible event content supports canonical messages and imported harness replies", () => {
  assert.equal(eventContent({ payload: { content: "Shared chat" } }), "Shared chat");
  assert.equal(eventContent({ payload: { text: "Codex reply" } }), "Codex reply");
  assert.equal(eventContent({ payload: {} }), "");
});

test("pending agent requests are derived from canonical request-response links", () => {
  const events = [
    { id: "request-1", type: "agent_request" },
    { id: "request-2", type: "agent_request" },
    { id: "response-1", type: "agent_response", replyTo: "request-1" },
    { id: "chat-1", type: "human_chat" },
  ];
  assert.deepEqual(pendingAgentRequests(events).map((event) => event.id), ["request-2"]);
  assert.deepEqual(pendingAgentRequests([
    { id: "request-wire", type: "agent_request" },
    { id: "response-wire", type: "agent_response", reply_to_event_id: "request-wire" },
  ]), []);
});

test("progress is labelled but does not complete its agent request", () => {
  const events = [
    { id: "request-1", type: "agent_request" },
    { id: "progress-1", type: "agent_progress", replyTo: "request-1" },
  ];
  assert.equal(eventLabel("agent_progress"), "Working");
  assert.deepEqual(pendingAgentRequests(events).map((event) => event.id), ["request-1"]);
});

test("replay pages normalize wire keys and sort by sequence", () => {
  const page = normalizeReplayPage({
    events: [{ sequence: 3 }, { sequence: 2 }],
    head_sequence: 4,
    next_after_sequence: 3,
    has_more: true,
  });
  assert.deepEqual(page.events.map((event) => event.sequence), [2, 3]);
  assert.equal(page.headSequence, 4);
  assert.equal(page.nextAfterSequence, 3);
  assert.equal(page.hasMore, true);
});

test("runtime labels preserve harness, provider, and model", () => {
  assert.equal(runtimeLabel(onlineRuntime), "Codex · OpenAI · gpt-5");
});

test("timeline provenance is a concise runtime summary", () => {
  const provenance = {
    username: "Yuhan He",
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    fidelity: "harness_transcript",
  };
  assert.equal(
    provenanceSummary(provenance),
    "Yuhan He · Codex · gpt-5.6-luna · low",
  );
  assert.equal(
    provenanceSummary(provenance, (effort) => effort === "low" ? "低" : effort),
    "Yuhan He · Codex · gpt-5.6-luna · 低",
  );
});

test("invitation records normalize wire keys and derive fail-closed status", () => {
  const now = new Date("2026-08-25T12:00:00.000Z").getTime();
  const pending = {
    id: "i1",
    project_id: "p1",
    inviter_user_id: "u1",
    role: "participant",
    created_at: "2026-08-25T10:00:00.000Z",
    expires_at: "2099-08-26T10:00:00.000Z",
    revoked_at: null,
    expired_at: null,
    claimed_at: null,
    claimed_by_user_id: null,
  };
  assert.equal(invitationStatus(pending, now), "pending");
  assert.equal(invitationStatus({ ...pending, expires_at: "2026-08-25T11:00:00.000Z" }, now), "expired");
  assert.equal(invitationStatus({ ...pending, claimed_at: "2026-08-25T11:00:00.000Z" }, now), "claimed");
  assert.equal(invitationStatus({ ...pending, revoked_at: "2026-08-25T11:00:00.000Z" }, now), "revoked");

  const normalized = normalizeInvitation(pending);
  assert.deepEqual(
    { projectId: normalized.projectId, role: normalized.role, status: normalized.status },
    { projectId: "p1", role: "participant", status: "pending" },
  );
  assert.equal(invitationStatusLabel("claimed"), "Accepted");
});

function agentRequestEvent(overrides = {}) {
  return {
    id: "request-1",
    type: "agent_request",
    sequence: 4,
    replyTo: null,
    payload: {
      content: "summarise the migration",
      execution_profile: {
        harness: "codex",
        provider: "openai",
        model: "gpt-5",
        reasoning_effort: "high",
        runtime_id: "runtime-7",
      },
    },
    ...overrides,
  };
}

function failedResponseEvent(overrides = {}) {
  return {
    id: "response-1",
    type: "agent_response",
    sequence: 5,
    replyTo: "request-1",
    payload: { status: "failed", text: "This Agent request was interrupted and could not be recovered." },
    ...overrides,
  };
}

test("only a response that reports a failed execution is treated as a failure", () => {
  assert.equal(isFailedAgentResponse(failedResponseEvent()), true);
  assert.equal(isFailedAgentResponse({ ...failedResponseEvent(), payload: { text: "all good" } }), false);
  assert.equal(isFailedAgentResponse({ ...failedResponseEvent(), payload: { status: "completed" } }), false);
  assert.equal(isFailedAgentResponse(agentRequestEvent()), false);
  assert.equal(isFailedAgentResponse(undefined), false);
});

test("a failed response resolves to the request it belongs to", () => {
  const events = [agentRequestEvent(), failedResponseEvent()];
  assert.equal(failedRequestFor(events, failedResponseEvent())?.id, "request-1");
  assert.equal(failedRequestFor(events, failedResponseEvent({ replyTo: "missing" })), undefined);
  assert.equal(failedRequestFor(events, { type: "agent_response", payload: {} }), undefined);
});

test("retrying a failed request reuses its exact original target", () => {
  const request = agentRequestEvent();
  const input = retryAgentRequestInput(request, "agent_request:retry-key");
  assert.equal(input.content, "summarise the migration");
  assert.equal(input.idempotencyKey, "agent_request:retry-key");
  assert.deepEqual(input.executionProfile, {
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    reasoningEffort: "high",
    runtimeId: "runtime-7",
  });
  // A request with no recorded target must not be retried onto a different one.
  const untargeted = agentRequestEvent({ payload: { content: "no profile" } });
  assert.deepEqual(retryAgentRequestInput(untargeted, "agent_request:retry-key").executionProfile, undefined);
});

test("only the original requester can retry a failed Agent request", () => {
  const request = agentRequestEvent({ actor: { id: "user-1", username: "Requester" } });
  assert.equal(canRetryFailedAgentRequest(request, { id: "user-1" }), true);
  assert.equal(canRetryFailedAgentRequest(request, { id: "user-2" }), false);
  assert.equal(canRetryFailedAgentRequest(request, undefined), false);
});
