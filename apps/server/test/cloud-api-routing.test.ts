import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HostedAgentRequestInput } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { CloudApiStore } from "../src/cloud-api.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { ApiError } from "../src/errors.js";

const socketTest = process.platform === "win32" ? test.skip : test;
function fixture(runContainer: NonNullable<HostedAgentOptions["runContainer"]>, userDailyRuns = 1) {
  const root = mkdtempSync(join(tmpdir(), "gt-personal-route-"));
  let time = Date.now();
  const database = new CollaborationDatabase(join(root, "identity.db"), { authTokenPepper: "personal-routing-fixture-pepper", clock: () => new Date(time) });
  const service = new CollaborationService(database);
  const actor = database.bootstrapIdentity({ display_name: "Owner", device_name: "Browser" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Cloud", idempotency_key: "personal-route-session" }).session;
  const key = randomBytes(32).toString("base64"), store = new CloudApiStore(database, key);
  const saved = store.put(actor, randomUUID(), { expected_revision: null, provider_id: "anthropic", label: "My Claude",
    model: "claude-sonnet-fixture", enabled: true, api_key: ["synthetic", "personal", "provider", "secret"].join("-") });
  const repository = new CodeRepository(database, join(root, "code"));
  const agent = new HostedAgent(service, repository, {
    personalApiEncryptionKey: key, image: `fixture/cloud@sha256:${"c".repeat(64)}`, endpoints: [{ id: "free", profileId: "free",
      provider: "deepseek", label: "Existing service model", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1",
      apiToken: "synthetic-operator-provider-secret", quotaGroup: "operator", dailyRuns: 4, maxConcurrent: 1 }],
    userDailyRuns, globalDailyRuns: 4, maxConcurrent: 1, runContainer,
  });
  const input = { profile_id: saved.profile_id, api_config_revision: saved.revision, content: "Reply hello", include_code: false, idempotency_key: "personal-request" };
  return { root, database, service, actor, session, store, saved, agent, repository, input, key, advance() { time += 31_000; },
    close() { agent.close(); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

function reserve(f: ReturnType<typeof fixture>, input: HostedAgentRequestInput = f.input) {
  return f.database.reserveHostedAgentRequest(f.actor, f.session.id, input,
    [f.store.resolve(f.actor, f.saved.profile_id, f.saved.revision)],
    { userDailyRuns: 100, globalDailyRuns: 1000, maxConcurrent: 1, billingSource: "personal" });
}

for (const payer of ["service", "personal"] as const) {
 for (const pin of ["stale", "missing"] as const) {
  test(`an in-flight ${payer} retry with a ${pin} history pin cannot reserve or charge an old body after independent deletion`, () => {
    const f = fixture(async () => JSON.stringify({ answer: "No execution expected", files: [] }));
    const other = new CollaborationDatabase(join(f.root, "identity.db"), { authTokenPepper: "personal-routing-fixture-pepper" });
    try {
      const input = payer === "personal" ? f.input : { profile_id: "free", content: "Deleted question", include_code: false,
        idempotency_key: "service-old-request" };
      const endpoint = payer === "personal" ? f.store.resolve(f.actor, f.saved.profile_id, f.saved.revision) : {
        id: "free", profileId: "free", provider: "deepseek", model: "deepseek-chat", quotaGroup: "operator", dailyRuns: 4, maxConcurrent: 1 };
      const limits = { userDailyRuns: 100, globalDailyRuns: 1000, maxConcurrent: 1, billingSource: payer };
      const original = f.database.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits);
      f.database.finishHostedAgentRequest(original.event.id, { content: "Old answer" });
      assert.ok(f.agent.selection(f.actor, f.session.id, original.event.id));
      const capturedRevision = original.event.content_revision ?? 0;
      other.deleteMessage(f.actor, f.session.id, original.event.id, "delete-during-selection-wait");
      f.advance();
      const before = f.service.replay(f.actor, f.session.id, 0, 100).events.length;
      const oldActivity = f.database.sqlite.prepare("SELECT last_started_at FROM hosted_agent_user_activity WHERE user_id=?").get(f.actor.user_id)?.last_started_at;
      const retry = { ...input, ...(pin === "stale" ? { content_revision: capturedRevision } : {}),
        idempotency_key: "in-flight-old-body-retry" };
      assert.throws(() => f.database.reserveHostedAgentRequest(f.actor, f.session.id, retry, [endpoint], limits),
        e => e instanceof ApiError && e.code === "context_changed" && (pin === "stale" || /refresh/iu.test(e.message)));
      assert.equal(f.service.replay(f.actor, f.session.id, 0, 100).events.length, before);
      assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, payer).user_used_runs, 1);
      assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, payer === "service" ? "personal" : "service").user_used_runs, 0);
      assert.equal(f.database.hostedActiveRuns(), 0);
      assert.equal(f.database.sqlite.prepare("SELECT last_started_at FROM hosted_agent_user_activity WHERE user_id=?").get(f.actor.user_id)?.last_started_at, oldActivity);
      assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM events WHERE idempotency_key=?").get(retry.idempotency_key)?.n, 0);
      const current = { ...input, content: "New explicit question", content_revision: 1, idempotency_key: "explicit-current-revision" };
      const accepted = f.database.reserveHostedAgentRequest(f.actor, f.session.id, current, [endpoint], limits);
      assert.equal(accepted.event.content_revision, 1); f.database.finishHostedAgentRequest(accepted.event.id, {});
    } finally { other.close(); f.close(); }
  });
 }
}

for (const payer of ["service", "personal"] as const) {
  socketTest(`${payer} selected summaries after erasure use a server-captured history pin and reject a later deletion`, async () => {
    let runs = 0;
    const f = fixture(async () => { runs++; return JSON.stringify({ answer: "Safe selected summary", files: [] }); }, 10);
    const other = new CollaborationDatabase(join(f.root, "identity.db"), { authTokenPepper: "personal-routing-fixture-pepper" });
    try {
      const chat = (content: string) => f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
        idempotency_key: randomUUID(), payload: { content } });
      const erased = chat("SUMMARY_ERASED_SOURCE"), survivor = chat("SUMMARY_SELECTED_SURVIVOR");
      f.service.deleteMessage(f.actor, f.session.id, erased.id, "summary-erase-first");
      const input = { profile_id: payer === "personal" ? f.saved.profile_id : "free",
        ...(payer === "personal" ? { api_config_revision: f.saved.revision } : {}),
        source_event_ids: [survivor.id], idempotency_key: "summary-after-erasure" };
      const accepted = await f.agent.startSummary(f.actor, f.session.id, input);
      for (let n = 0; f.database.hostedActiveRuns() && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.database.hostedActiveRuns(), 0); assert.equal(runs, 1);
      assert.equal(accepted.request_event.content_revision, 1);
      assert.match(JSON.stringify(accepted.request_event.payload), /SUMMARY_SELECTED_SURVIVOR/);
      assert.doesNotMatch(JSON.stringify(accepted.request_event.payload), /SUMMARY_ERASED_SOURCE/);
      if (payer === "personal") assert.equal(f.agent.selection(f.actor, f.session.id, accepted.request_event.id).api_config_revision, f.saved.revision);
      const incidental = chat("SUMMARY_RACE_OTHER_SOURCE"); f.advance();
      const reserve = f.service.reserveHostedAgentRequest.bind(f.service);
      f.service.reserveHostedAgentRequest = (...args) => {
        other.deleteMessage(f.actor, f.session.id, incidental.id, "summary-erase-before-acceptance");
        return reserve(...args);
      };
      const before = f.database.hostedAgentUsage(f.actor, 100, 1000, payer).user_used_runs;
      await assert.rejects(f.agent.startSummary(f.actor, f.session.id, { ...input, idempotency_key: "summary-in-flight-revision" }),
        e => e instanceof ApiError && e.code === "context_changed");
      assert.equal(runs, 1); assert.equal(f.database.hostedActiveRuns(), 0);
      assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, payer).user_used_runs, before);
      assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM events WHERE idempotency_key=?").get("summary-in-flight-revision")?.n, 0);
    } finally { other.close(); f.close(); }
  });
}

test("personal retry selection cannot revive a request whose shared history revision changed", () => {
  const f = fixture(async () => JSON.stringify({ answer: "Fixture", files: [] }));
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "personal-retry-history", payload: { content: "PERSONAL_RETRY_DELETED_SOURCE" } });
    const accepted = reserve(f);
    f.database.finishHostedAgentRequest(accepted.event.id, { content: "Fixture" });
    f.service.deleteMessage(f.actor, f.session.id, source.id, "personal-delete-retry-history");
    assert.throws(() => f.agent.selection(f.actor, f.session.id, accepted.event.id),
      e => e instanceof ApiError && e.code === "context_changed");
    assert.throws(() => reserve(f), e => e instanceof ApiError && e.code === "context_changed");
    assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, "personal").user_used_runs, 1);
    assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

test("a deleted personal request cannot be selected or replayed as executable work", () => {
  const f = fixture(async () => JSON.stringify({ answer: "Fixture", files: [] }));
  try {
    const accepted = reserve(f);
    f.database.finishHostedAgentRequest(accepted.event.id, { content: "Fixture" });
    f.service.deleteMessage(f.actor, f.session.id, accepted.event.id, "personal-delete-request");
    assert.throws(() => f.agent.selection(f.actor, f.session.id, accepted.event.id),
      e => e instanceof ApiError && e.code === "context_changed");
    assert.throws(() => reserve(f), e => e instanceof ApiError && e.code === "context_changed");
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

test("a current personal API pin cannot quote a deleted source or reserve another charged run", () => {
  const f = fixture(async () => JSON.stringify({ answer: "Fixture", files: [] }));
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "personal-quote-history", payload: { content: "PERSONAL_QUOTE_DELETED_SOURCE" } });
    f.service.deleteMessage(f.actor, f.session.id, source.id, "personal-delete-quote-history");
    assert.throws(() => reserve(f, { ...f.input, reply_to_event_id: source.id, content_revision: 1 }),
      e => e instanceof ApiError && e.code === "message_deleted");
    assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, "personal").user_used_runs, 0);
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

socketTest("history erasure and personal API pins both fence active work and the next actual prompt", { timeout: 6000 }, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const prompts: string[] = [];
  const f = fixture(async (args, _timeout, cancellation) => {
    const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
    prompts.push(readFileSync(join(control, "prompt.txt"), "utf8"));
    if (prompts.length === 1) { signal = cancellation; entered.resolve(); return release.promise; }
    return JSON.stringify({ answer: "Fresh personal answer", files: [] });
  });
  const other = new CollaborationDatabase(join(f.root, "identity.db"), { authTokenPepper: "personal-routing-fixture-pepper" });
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "personal-live-history", payload: { content: "PERSONAL_CONTEXT_ERASE_UNIQUE" } });
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "personal-surviving-history", payload: { content: "PERSONAL_CONTEXT_SURVIVING" } });
    const accepted = await f.agent.start(f.actor, f.session.id, f.input); await entered.promise;
    assert.match(prompts[0]!, /PERSONAL_CONTEXT_ERASE_UNIQUE/);
    other.deleteMessage(f.actor, f.session.id, source.id, "personal-other-db-erasure");
    for (let n = 0; !signal?.aborted && n < 250; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(signal?.aborted, true);
    assert.equal(f.database.hostedActiveRuns(), 1, "history deletion must not release a still-running personal executor");
    assert.equal(f.store.resolve(f.actor, f.saved.profile_id, f.saved.revision).personal?.configRevision, f.saved.revision);
    assert.equal(f.database.sqlite.prepare("SELECT config_revision FROM cloud_api_run_bindings WHERE request_event_id=?")
      .get(accepted.request_event.id)?.config_revision, f.saved.revision);
    assert.equal(f.service.appendHostedAgentProgress(accepted.request_event.id, { id: randomUUID(), content: "PERSONAL_CONTEXT_ERASE_UNIQUE",
      phase: "stream", streamId: randomUUID(), streamKind: "answer", streamRevision: 1, streamMode: "snapshot", streamState: "running" }), false);
    release.resolve(JSON.stringify({ answer: "PERSONAL_CONTEXT_ERASE_UNIQUE", files: [] }));
    for (let n = 0; f.database.hostedActiveRuns() && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.database.hostedActiveRuns(), 0);
    assert.doesNotMatch(JSON.stringify(f.service.replay(f.actor, f.session.id, 0, 100)), /PERSONAL_CONTEXT_ERASE_UNIQUE/);
    f.advance();
    const fresh = await f.agent.request(f.actor, f.session.id, { ...f.input, content_revision: 1, idempotency_key: "personal-current-history" });
    assert.equal(fresh.request_event.content_revision, 1);
    assert.equal(fresh.response_event?.runtime_provenance?.provider, "anthropic");
    assert.doesNotMatch(prompts[1]!, /PERSONAL_CONTEXT_ERASE_UNIQUE/); assert.match(prompts[1]!, /PERSONAL_CONTEXT_SURVIVING/);
    assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, "personal").user_used_runs, 2);
    assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
  } finally {
    release.resolve(JSON.stringify({ answer: "Late", files: [] }));
    for (let n = 0; f.database.hostedActiveRuns() && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    other.close(); f.close();
  }
});

for (const changed of ["history", "personal-api"] as const) {
  socketTest(`a personal checkpoint transaction refuses an independently changed ${changed} revision`, async () => {
    const f = fixture(async () => JSON.stringify({ answer: "PERSONAL_CHECKPOINT_OLD", save_error: null,
      files: [{ path: "late.txt", executable: false, content_base64: Buffer.from("PERSONAL_CHECKPOINT_OLD").toString("base64") }] }));
    const other = new CollaborationDatabase(join(f.root, "identity.db"), { authTokenPepper: "personal-routing-fixture-pepper" });
    try {
      const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
        idempotency_key: "personal-checkpoint-history", payload: { content: "PERSONAL_CHECKPOINT_OLD" } });
      const enabled = f.repository.enable(f.actor, f.session.project_id, { idempotency_key: "personal-enable-code" });
      const checkpoint = f.repository.checkpoint.bind(f.repository);
      f.repository.checkpoint = (...args) => {
        if (changed === "history") other.deleteMessage(f.actor, f.session.id, source.id, "personal-checkpoint-delete");
        else new CloudApiStore(other, f.key).put(f.actor, f.saved.id,
          { expected_revision: f.saved.revision, provider_id: "anthropic", label: "Rotated at checkpoint", model: f.saved.model, enabled: true });
        return checkpoint(...args);
      };
      const result = await f.agent.request(f.actor, f.session.id, { ...f.input, include_code: true });
      assert.doesNotMatch(JSON.stringify(result.response_event ?? null), /PERSONAL_CHECKPOINT_OLD/);
      assert.equal(f.database.hostedActiveRuns(), 0);
      const status = f.repository.status(f.actor, f.session.project_id);
      assert.equal(status.own_branch_id, null); assert.equal(status.repository.main_commit, enabled.commit);
      assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM code_mutations WHERE operation='checkpoint'").get()?.n, 0);
      assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, "personal").user_used_runs, 1);
      assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
    } finally { other.close(); f.close(); }
  });
}

socketTest("personal selection freezes private run credentials and leaves free allowance untouched", async () => {
  let executions = 0;
  const f = fixture(async args => {
    executions++;
    const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
    const configText = readFileSync(join(control, "opencode.json"), "utf8"), config = JSON.parse(configText);
    assert.equal(config.provider.hosted.npm, "@ai-sdk/anthropic");
    assert.doesNotMatch(configText + args.join(" "), /synthetic-personal-provider|synthetic-operator-provider|api.anthropic.com/);
    return JSON.stringify({ answer: "Hello from the chosen model.", files: [] });
  });
  try {
    const status = f.agent.status(f.actor);
    assert.ok(status.profiles.some(p => p.id === f.saved.profile_id && p.source === "personal"));
    const result = await f.agent.request(f.actor, f.session.id, f.input);
    assert.equal(result.response_event?.runtime_provenance?.provider, "anthropic");
    assert.equal(executions, 1);
    assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
    const binding = f.database.sqlite.prepare("SELECT * FROM cloud_api_run_bindings WHERE request_event_id=?").get(result.request_event.id)!;
    assert.equal(binding.config_id, f.saved.id); assert.equal(binding.config_revision, f.saved.revision);
    assert.equal((await f.agent.request(f.actor, f.session.id, f.input)).replayed, true);
    assert.equal(executions, 1);
    assert.doesNotMatch(JSON.stringify(f.service.replay(f.actor, f.session.id, 0, 100)), /synthetic-personal-provider|key_ciphertext/);
  } finally { f.close(); }
});

test("personal daily allowance spans configurations and never uses the unlimited free-model exception", () => {
  const f = fixture(async () => JSON.stringify({ answer: "Fixture", files: [] }));
  try {
    const second = f.store.put(f.actor, randomUUID(), { expected_revision: null, provider_id: "siliconflow-cn", label: "Free model with own key",
      model: "Qwen/Qwen3.5-4B", enabled: true, api_key: ["second", "personal", "fixture"].join("-") });
    const endpoints = [f.store.resolve(f.actor, f.saved.profile_id, f.saved.revision), f.store.resolve(f.actor, second.profile_id, second.revision)];
    assert.equal(endpoints[0]!.quotaGroup, endpoints[1]!.quotaGroup); assert.equal(endpoints[1]!.dailyRuns, 100);
    f.database.setHostedAgentUserLimit(f.actor.user_id, 0);
    const limits = { userDailyRuns: 100, globalDailyRuns: 1000, maxConcurrent: 1, billingSource: "personal" as const };
    for (let n = 0; n < 100; n++) {
      const endpoint = endpoints[n % 2]!;
      const row = f.database.reserveHostedAgentRequest(f.actor, f.session.id, { ...f.input, profile_id: endpoint.profileId,
        api_config_revision: endpoint.personal!.configRevision, idempotency_key: `personal-cap-${n}` }, [endpoint], limits);
      f.database.finishHostedAgentRequest(row.event.id, {}); f.advance();
    }
    assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
    assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, "personal").user_used_runs, 100);
    assert.throws(() => f.database.reserveHostedAgentRequest(f.actor, f.session.id, { ...f.input, idempotency_key: "personal-cap-over" },
      [endpoints[0]!], limits), e => e instanceof ApiError && e.code === "hosted_user_quota");
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

socketTest("personal requests and summaries keep exact pins; reused request keys cannot follow a rotated key", async () => {
  const f = fixture(async () => JSON.stringify({ answer: "Summary fixture", files: [] }));
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "own-api-summary-source",
      payload: { content: "Selected history fixture" } });
    const summarized = await f.agent.startSummary(f.actor, f.session.id, { profile_id: f.saved.profile_id, api_config_revision: f.saved.revision,
      source_event_ids: [source.id], idempotency_key: "own-api-summary" });
    for (let tries = 0; f.database.hostedActiveRuns() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.agent.selection(f.actor, f.session.id, summarized.request_event.id), { profile_id: f.saved.profile_id, api_config_revision: f.saved.revision });
    f.advance();
    const original = await f.agent.request(f.actor, f.session.id, f.input);
    const changed = f.agent.putPersonalApi(f.actor, f.saved.id, { expected_revision: f.saved.revision, provider_id: "anthropic",
      label: f.saved.label, model: f.saved.model, enabled: true, api_key: ["rotated", "fixture", "personal", "key"].join("-") });
    await assert.rejects(f.agent.request(f.actor, f.session.id, { ...f.input, api_config_revision: changed.revision }),
      e => e instanceof ApiError && e.code === "cloud_api_changed");
    assert.throws(() => f.agent.selection(f.actor, f.session.id, original.request_event.id), e => e instanceof ApiError && e.code === "cloud_api_changed");
  } finally { f.close(); }
});

socketTest("unknown, foreign, disabled or stale personal selection never falls back or reserves work", async () => {
  let executions = 0;
  const f = fixture(async () => { executions++; return JSON.stringify({ answer: "Should not execute", files: [] }); });
  try {
    const other = f.database.createIdentity({ display_name: "Other", device_name: "Browser" }).actor;
    f.service.setMembership(f.actor, f.session.id, other.user_id, "participant", "personal-other");
    for (const [actor, input] of [[f.actor, { ...f.input, api_config_revision: randomUUID() }], [other, f.input],
      [f.actor, { ...f.input, profile_id: `api-${randomUUID()}` }]] as const) {
      await assert.rejects(f.agent.request(actor, f.session.id, input));
    }
    assert.equal(executions, 0); assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

socketTest("configuration replacement aborts active work, fences progress and suppresses late answer", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (_args, _timeout, cancellation) => { signal = cancellation; entered.resolve(); return release.promise; });
  try {
    const receipt = await f.agent.start(f.actor, f.session.id, f.input); await entered.promise;
    f.agent.putPersonalApi(f.actor, f.saved.id, { expected_revision: f.saved.revision, provider_id: "anthropic", label: "Changed",
      model: "claude-sonnet-fixture", enabled: true });
    assert.equal(signal?.aborted, true);
    assert.equal(f.service.appendHostedAgentProgress(receipt.request_event.id, { id: randomUUID(),
      content: "Late work", phase: "stream", streamId: randomUUID(), streamKind: "answer", streamRevision: 1,
      streamMode: "snapshot", streamState: "running" }), false);
    assert.equal(f.database.hostedActiveRuns(), 1, "capacity stays held until the executor exits");
    release.resolve(JSON.stringify({ answer: "Late answer must be refused", files: [] }));
    for (let tries = 0; f.database.hostedActiveRuns() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    const result = f.service.replay(f.actor, f.session.id, 0, 100).events.find(event => event.type === "agent_response");
    assert.equal((result?.payload as { status: string }).status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /Late answer/);
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { release.resolve(JSON.stringify({ answer: "Late", files: [] })); f.close(); }
});
