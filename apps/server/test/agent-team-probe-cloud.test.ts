import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentTeamPlan, HistoryContext } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { AgentTeams } from "../src/agent-teams.js";
import { AgentTeamLibrary } from "../src/agent-team-library.js";
import { redactJson } from "../src/redaction.js";

const options = (runContainer: NonNullable<HostedAgentOptions["runContainer"]>): HostedAgentOptions => ({
  image: `example/hosted@sha256:${"a".repeat(64)}`,
  endpoints: [{ id: "synthetic-probe-endpoint", profileId: "synthetic-probe-cloud", label: "Synthetic probe cloud", provider: "deepseek",
    model: "synthetic-probe-model", baseUrl: "https://api.deepseek.com/v1", apiToken: "synthetic-fixture-only-never-production",
    quotaGroup: "synthetic-probe-account", dailyRuns: 100, maxConcurrent: 1 }],
  userDailyRuns: 100, globalDailyRuns: 100, maxConcurrent: 1, userMinIntervalSeconds: 1, userMaxConcurrent: 1,
  fetch: async () => { throw new Error("Synthetic connectivity tests must never call a real model"); }, runContainer,
});

test("a redacted generated cloud prefix keeps final mention ranges exact through timeout and lost-receipt recovery", {
  skip: process.platform === "win32",
}, async () => {
  let now = Date.now(), launches = 0; const clock = () => new Date(now);
  const directory = mkdtempSync(join(tmpdir(), "gt-cr-")), database = new CollaborationDatabase(":memory:", { clock });
  const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Synthetic owner", device_name: "Synthetic cloud device" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Redacted cloud prefix", idempotency_key: "cloud-redacted-prefix-session" }).session;
  const hosted = new HostedAgent(service, new CodeRepository(database, directory), options(async () => {
    if (++launches === 1) throw new Error("container_timeout");
    return JSON.stringify({ answer: "Synthetic task complete.", files: [] });
  }));
  const teams = new AgentTeams(service, hosted, { clock, autoStart: false });
  const drive = async (id: string, status: string) => {
    for (let spin = 0; spin < 100; spin++) {
      await teams.pump(); if (teams.read(actor, session.id, id).run.status === status) return;
      now += 1000; await new Promise(resolve => setTimeout(resolve, 2));
    }
    const actual = teams.read(actor, session.id, id).run; assert.equal(actual.status, status, actual.error_code ?? "Unexpected run state");
  };
  try {
    const content = "😀 @Synthetic owner review", start = content.indexOf("@");
    const plan: AgentTeamPlan = { name: "Redacted prefix cloud Team", team_prompt: "", nodes: [{ id: "lead", label: "Cloud module",
      role: "Return a verification token:", x: 0, y: 0, target: { kind: "cloud", profile_id: "synthetic-probe-cloud",
        provider: "deepseek", model: "synthetic-probe-model", include_code: false } }], edges: [] };
    const input = { plan, entry_node_id: "lead", content, mentions: [{ user_id: actor.user_id, start, end: start + "@Synthetic owner".length }],
      content_revision: 0, max_calls: 2, max_duration_minutes: 30, idempotency_key: "cloud-redacted-prefix-start" };
    const run = teams.start(actor, session.id, input).run; await drive(run.id, "paused");
    const paused = teams.read(actor, session.id, run.id).run;
    assert.equal(paused.error_code, "agent_timeout"); assert.equal(paused.calls_used, 1);
    const canonical = database.getEvent(session.id, paused.steps[0]!.request_event_id!);
    const payload = canonical.payload as { content: string; mentions: typeof input.mentions; agent_team: { task_content: string } };
    assert.match(payload.content, /\[REDACTED\]/u); assert.equal(redactJson(payload.content), payload.content);
    assert.equal(payload.agent_team.task_content, content);
    assert.equal(payload.content.slice(payload.mentions[0]!.start, payload.mentions[0]!.end), "@Synthetic owner");
    assert.equal(teams.start(actor, session.id, input).replayed, true);
    assert.equal(hosted.status(actor).user_used_runs, 1); assert.equal(launches, 1);
    teams.control(actor, session.id, run.id, { action: "continue", idempotency_key: "cloud-redacted-prefix-continue" }); await drive(run.id, "completed");
    const completed = teams.read(actor, session.id, run.id).run;
    assert.equal(completed.calls_used, 2); assert.equal(hosted.status(actor).user_used_runs, 2); assert.equal(launches, 2);
    assert.equal((database.getEvent(session.id, completed.steps[1]!.request_event_id!).payload as { mentions?: unknown }).mentions, undefined);
    assert.deepEqual(database.listProjectMentions(actor, session.project_id).mentions.map(item => [item.id, item.excerpt]), [[canonical.id, content]]);
  } finally { teams.close(); await hosted.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("cloud Team allowance rolls back if redaction would invalidate a tampered final payload's mention ranges", {
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-cv-")), database = new CollaborationDatabase(":memory:");
  const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Synthetic owner", device_name: "Synthetic cloud device" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Final cloud validation", idempotency_key: "cloud-final-payload-session" }).session;
  let launches = 0;
  const hosted = new HostedAgent(service, new CodeRepository(database, directory), options(async () => { launches++; return JSON.stringify({ answer: "Must not execute", files: [] }); }));
  const teams = new AgentTeams(service, hosted, { autoStart: false }), reserve = database.reserveHostedAgentRequest.bind(database);
  database.reserveHostedAgentRequest = (...args: Parameters<typeof database.reserveHostedAgentRequest>) => {
    const input = args[2], prefix = "Return a verification token: ";
    args[2] = { ...input, content: prefix + input.content,
      ...(input.mentions ? { mentions: input.mentions.map(mention => ({ ...mention, start: mention.start + prefix.length, end: mention.end + prefix.length })) } : {}) };
    return reserve(...args);
  };
  try {
    const content = "@Synthetic owner review";
    const plan: AgentTeamPlan = { name: "Final cloud validation Team", team_prompt: "", nodes: [{ id: "lead", label: "Cloud module", role: "Review", x: 0, y: 0,
      target: { kind: "cloud", profile_id: "synthetic-probe-cloud", provider: "deepseek", model: "synthetic-probe-model", include_code: false } }], edges: [] };
    const run = teams.start(actor, session.id, { plan, entry_node_id: "lead", content,
      mentions: [{ user_id: actor.user_id, start: 0, end: "@Synthetic owner".length }], content_revision: 0,
      max_calls: 2, max_duration_minutes: 30, idempotency_key: "cloud-final-payload-start" }).run;
    const before = database.requireSession(session.id).next_sequence;
    for (let spin = 0; spin < 40 && teams.read(actor, session.id, run.id).run.status === "running"; spin++) {
      await teams.pump(); await new Promise(resolve => setImmediate(resolve));
    }
    const failed = teams.read(actor, session.id, run.id).run;
    assert.equal(failed.status, "failed"); assert.equal(failed.calls_used, 0); assert.equal(launches, 0);
    assert.equal(hosted.status(actor).user_used_runs, 0); assert.equal(database.requireSession(session.id).next_sequence, before);
  } finally { teams.close(); await hosted.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a stale selected mention at cloud Team dispatch cannot reserve provider allowance or launch an executor", {
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-rm-")), database = new CollaborationDatabase(":memory:");
  const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Cloud recipient", device_name: "Cloud reference device" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Cloud reference race", idempotency_key: "cloud-reference-race-session" }).session;
  let launches = 0;
  const hosted = new HostedAgent(service, new CodeRepository(database, directory), options(async () => { launches++; throw new Error("Must not execute"); }));
  const teams = new AgentTeams(service, hosted, { autoStart: false });
  try {
    const plan: AgentTeamPlan = { name: "Cloud reference Team", team_prompt: "", nodes: [{ id: "lead", label: "Cloud module", role: "", x: 0, y: 0,
      target: { kind: "cloud", profile_id: "synthetic-probe-cloud", provider: "deepseek", model: "synthetic-probe-model", include_code: false } }], edges: [] };
    const run = teams.start(actor, session.id, { plan, entry_node_id: "lead", content: "@Cloud recipient review",
      mentions: [{ user_id: actor.user_id, start: 0, end: "@Cloud recipient".length }], content_revision: 0,
      max_calls: 12, max_duration_minutes: 30, idempotency_key: "cloud-reference-race-start" }).run;
    const before = database.requireSession(session.id).next_sequence;
    database.sqlite.prepare("UPDATE users SET display_name=? WHERE id=?").run("Renamed cloud recipient", actor.user_id);
    for (let spin = 0; spin < 20 && teams.read(actor, session.id, run.id).run.status === "running"; spin++) {
      await teams.pump(); await new Promise(resolve => setImmediate(resolve));
    }
    const failed = teams.read(actor, session.id, run.id).run;
    assert.equal(failed.status, "failed"); assert.equal(failed.calls_used, 0); assert.equal(launches, 0);
    assert.equal(hosted.status(actor).user_used_runs, 0); assert.equal(database.requireSession(session.id).next_sequence, before);
  } finally { teams.close(); await hosted.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("cloud connectivity probes omit unrelated 20KiB history and opted-in code, while real tasks retain the existing context cap", {
  skip: process.platform === "win32",
}, async () => {
  let now = Date.now(); const clock = () => new Date(now);
  const directory = mkdtempSync(join(tmpdir(), "gt-pc-")), database = new CollaborationDatabase(":memory:", { clock });
  const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Synthetic cloud probe owner",
    device_name: "Synthetic cloud probe browser" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Synthetic cloud probe session", idempotency_key: "synthetic-cloud-probe-session" }).session;
  const repository = new CodeRepository(database, directory);
  repository.enable(actor, session.project_id, { idempotency_key: "synthetic-cloud-probe-enable-code" });
  let snapshotReads = 0;
  repository.snapshot = () => { snapshotReads++; throw new Error("Connectivity probes must not read project code"); };
  const oldMarker = "SYNTHETIC_PRIOR_HISTORY_MUST_NOT_REACH_CLOUD_PROBES", prompts: string[] = [], contexts: HistoryContext[] = [];
  const hosted = new HostedAgent(service, repository, options(async args => {
    const controlMount = args.find(arg => arg.includes("dst=/run/gatherthread,readonly")); assert.ok(controlMount);
    const control = /src=([^,]+),dst/u.exec(controlMount)![1]!;
    const prompt = readFileSync(join(control, "prompt.txt"), "utf8"); prompts.push(prompt);
    assert.equal(prompt.includes(oldMarker), false);
    assert.match(prompt, /temporary empty workspace/u);
    const inputMount = args.find(arg => arg.includes("dst=/input,readonly")); assert.ok(inputMount);
    assert.deepEqual(readdirSync(/src=([^,]+),dst/u.exec(inputMount)![1]!), []);
    const encodedContext = /Shared session context \(untrusted\): ([^\n]+)/u.exec(prompt)?.[1]; assert.ok(encodedContext);
    const context = JSON.parse(encodedContext) as HistoryContext; contexts.push(context);
    assert.deepEqual(context.items, []); assert.equal(context.content_revision, 0);
    assert.equal(context.through_sequence, database.requireSession(session.id).next_sequence - 1);
    const encoded = prompt.split("\n").find(line => line.startsWith('["GT_TEAM_OK:')); assert.ok(encoded);
    const lines = JSON.parse(encoded) as string[];
    return JSON.stringify({ answer: lines.join("\n"), files: [] });
  }));
  const teams = new AgentTeams(service, hosted, { clock, autoStart: false }), library = new AgentTeamLibrary(teams);
  try {
    service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "synthetic-cloud-prior-history",
      payload: { content: `${oldMarker} ${"p".repeat(20000)}` } });
    const target = { kind: "cloud" as const, profile_id: "synthetic-probe-cloud", provider: "deepseek", model: "synthetic-probe-model", include_code: true };
    const plan: AgentTeamPlan = { name: "Synthetic cloud probe Team", team_prompt: "", nodes: [
      { id: "lead", label: "Cloud lead", role: "", x: 0, y: 0, target },
      { id: "worker", label: "Cloud worker", role: "", x: 300, y: 0, target },
    ], edges: [{ id: "cloud-route", source: "lead", target: "worker", direction: "one_way" }] };
    const saved = library.save(actor, "synthetic-cloud-probe-team", { draft: plan, max_calls: 1, expected_revision: null,
      idempotency_key: "synthetic-cloud-probe-save" }).team;
    const accepted = library.test(actor, saved.id, session.id, { expected_revision: saved.revision, content_revision: 0,
      idempotency_key: "synthetic-cloud-probe-start" });
    for (let spin = 0; spin < 200; spin++) {
      await teams.pump();
      if (teams.read(actor, session.id, accepted.run.id).run.status !== "running") break;
      now += 1000; await new Promise(resolve => setTimeout(resolve, 2));
    }
    const completed = teams.read(actor, session.id, accepted.run.id).run;
    assert.equal(completed.status, "completed", completed.error_code ?? "Probe did not complete");
    assert.equal(completed.calls_used, 3); assert.equal(prompts.length, 3); assert.equal(contexts.length, 3); assert.equal(snapshotReads, 0);
    assert.ok(prompts[2]!.includes(`GT_TEAM_ROUTE:cloud-route:lead:worker:${completed.steps[0]!.id}`));
    assert.equal(hosted.status(actor).user_used_runs, 3, "Minimal probes still use provider allowances");
    for (const step of completed.steps) {
      const request = database.getEvent(session.id, step.request_event_id!);
      assert.equal((request.payload as { include_code: boolean }).include_code, false);
    }
    assert.equal(library.read(actor, saved.id).test_status, "passed");
    const enabled = library.control(actor, saved.id, session.id, { enabled: true, expected_revision: saved.revision,
      idempotency_key: "synthetic-cloud-probe-enable" }).team;
    const ordinary = library.start(actor, saved.id, session.id, { content: "A real Team task must still respect the public history cap",
      content_revision: 0, expected_revision: enabled.revision, idempotency_key: "synthetic-cloud-real-task" });
    for (let spin = 0; spin < 20; spin++) { await teams.pump(); await new Promise(resolve => setTimeout(resolve, 2)); }
    const failed = teams.read(actor, session.id, ordinary.run.id).run;
    assert.equal(failed.status, "failed"); assert.equal(failed.error_code, "hosted_context_too_large");
    assert.equal(failed.calls_used, 0); assert.equal(prompts.length, 3); assert.equal(snapshotReads, 0);
    assert.equal(hosted.status(actor).user_used_runs, 3);
  } finally { teams.close(); await hosted.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a saved cloud Team's explicit timeout continuation keeps its accepted snapshot after the definition is edited and deleted", {
  skip: process.platform === "win32",
}, async () => {
  let now = Date.now(); const clock = () => new Date(now);
  const directory = mkdtempSync(join(tmpdir(), "gt-pt-")), database = new CollaborationDatabase(":memory:", { clock });
  const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Synthetic timeout owner",
    device_name: "Synthetic timeout browser" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Synthetic saved cloud timeout", idempotency_key: "saved-cloud-timeout-session" }).session;
  const observedModels: string[] = []; let taskCalls = 0, probeCalls = 0;
  const hosted = new HostedAgent(service, new CodeRepository(database, directory), options(async args => {
    const controlMount = args.find(arg => arg.includes("dst=/run/gatherthread,readonly")); assert.ok(controlMount);
    const control = /src=([^,]+),dst/u.exec(controlMount)![1]!;
    const config = JSON.parse(readFileSync(join(control, "opencode.json"), "utf8")) as { model: string }; observedModels.push(config.model);
    const prompt = readFileSync(join(control, "prompt.txt"), "utf8"), encoded = prompt.split("\n").find(line => line.startsWith('["GT_TEAM_OK:'));
    if (encoded) { probeCalls++; return JSON.stringify({ answer: (JSON.parse(encoded) as string[]).join("\n"), files: [] }); }
    taskCalls++; assert.match(prompt, /immutable saved cloud task/u); assert.equal(prompt.includes("Replacement model must not execute"), false);
    if (taskCalls === 1) throw new Error("container_timeout");
    return JSON.stringify({ answer: "The original immutable task is complete.", files: [] });
  }));
  const teams = new AgentTeams(service, hosted, { clock, autoStart: false }), library = new AgentTeamLibrary(teams);
  const drive = async (id: string, expected: string) => {
    for (let spin = 0; spin < 100; spin++) {
      await teams.pump(); if (teams.read(actor, session.id, id).run.status === expected) return;
      now += 1000; await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(teams.read(actor, session.id, id).run.status, expected);
  };
  try {
    const plan: AgentTeamPlan = { name: "Saved timeout Team", team_prompt: "", nodes: [{ id: "lead", label: "Cloud module", role: "Original role", x: 0, y: 0,
      target: { kind: "cloud", profile_id: "synthetic-probe-cloud", provider: "deepseek", model: "synthetic-probe-model", include_code: false } }], edges: [] };
    const saved = library.save(actor, "saved-cloud-timeout-team", { draft: plan, max_calls: 2, max_duration_minutes: 30,
      expected_revision: null, idempotency_key: "saved-cloud-timeout-save" }).team;
    const probe = library.test(actor, saved.id, session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: "saved-cloud-timeout-test" }); await drive(probe.run.id, "completed");
    const enabled = library.control(actor, saved.id, session.id, { enabled: true, expected_revision: saved.revision,
      idempotency_key: "saved-cloud-timeout-enable" }).team;
    const quote = service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "saved-cloud-timeout-source",
      payload: { content: "Synthetic cloud quote" } });
    const content = `  😀 @${actor.display_name} Execute the immutable saved cloud task  \n`, start = content.indexOf("@");
    const input = { expected_revision: enabled.revision, content, reply_to_event_id: quote.id,
      mentions: [{ user_id: actor.user_id, start, end: start + `@${actor.display_name}`.length }], content_revision: 0,
      idempotency_key: "saved-cloud-timeout-start" };
    const accepted = library.start(actor, saved.id, session.id, input); await drive(accepted.run.id, "paused");
    const paused = teams.read(actor, session.id, accepted.run.id).run;
    assert.equal(paused.error_code, "agent_timeout"); assert.equal(paused.calls_used, 1); assert.equal(taskCalls, 1);
    assert.equal(paused.content, content);
    const first = database.getEvent(session.id, paused.steps[0]!.request_event_id!);
    const firstPayload = first.payload as { content: string; mentions: typeof input.mentions; agent_team: { task_content: string } };
    assert.equal(first.reply_to_event_id, quote.id); assert.equal(firstPayload.agent_team.task_content, content);
    assert.equal(firstPayload.content.slice(firstPayload.mentions[0]!.start, firstPayload.mentions[0]!.end), `@${actor.display_name}`);
    for (const changed of [{ ...input, reply_to_event_id: null }, { ...input, mentions: [] }]) {
      assert.throws(() => library.start(actor, saved.id, session.id, changed), { code: "idempotency_conflict" });
    }
    for (let spin = 0; spin < 3; spin++) await teams.pump(); assert.equal(taskCalls, 1, "No implicit retry follows a timeout");
    const replacement = structuredClone(plan); replacement.nodes[0]!.role = "Replacement model must not execute";
    replacement.nodes[0]!.target = { kind: "cloud", profile_id: "synthetic-probe-cloud", provider: "deepseek", model: "unadvertised-replacement-model", include_code: false };
    const edited = library.save(actor, saved.id, { draft: replacement, max_calls: 1, max_duration_minutes: 1,
      expected_revision: enabled.revision, idempotency_key: "saved-cloud-timeout-edit" }).team;
    assert.equal(edited.enabled, false); assert.equal(edited.tested_revision, null);
    library.delete(actor, "team", saved.id, "saved-cloud-timeout-delete");
    assert.equal(library.start(actor, saved.id, session.id, input).run.id, accepted.run.id, "A lost start receipt remains readable after definition deletion");
    assert.equal(library.start(actor, saved.id, session.id, input).replayed, true);
    const continuation = { action: "continue" as const, idempotency_key: "saved-cloud-timeout-continue" };
    teams.control(actor, session.id, paused.id, continuation); teams.control(actor, session.id, paused.id, continuation);
    await drive(paused.id, "completed");
    const completed = teams.read(actor, session.id, paused.id).run;
    assert.equal(completed.calls_used, 2); assert.equal(completed.max_calls, 2); assert.equal(completed.max_duration_minutes, 30);
    assert.equal(completed.deadline_at, accepted.run.deadline_at); assert.deepEqual(completed.plan, plan);
    assert.equal(probeCalls, 1); assert.equal(taskCalls, 2); assert.equal(hosted.status(actor).user_used_runs, 3);
    assert.deepEqual(observedModels, Array(3).fill("hosted/synthetic-probe-model"));
    assert.notEqual(completed.steps[0]!.request_event_id, completed.steps[1]!.request_event_id);
    const continued = database.getEvent(session.id, completed.steps[1]!.request_event_id!);
    assert.equal(continued.reply_to_event_id, null); assert.equal((continued.payload as { mentions?: unknown }).mentions, undefined);
    assert.deepEqual(database.listProjectMentions(actor, session.project_id).mentions.map(item => [item.id, item.excerpt]), [[first.id, content]]);
  } finally { teams.close(); await hosted.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
