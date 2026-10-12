import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAgent, HOSTED_MODEL, hostedContainerMemoryMiB, runDocker } from "../apps/server/dist/src/hosted-agent.js";
import { createHostedDockerClient, runHostedDockerCommand, stopHostedContainer } from "../apps/server/dist/src/hosted-agent-recovery.js";
import { reportTrialFixtureFailure } from "./hosted-repository-fixture-diagnostics.mjs";
import { CollaborationDatabase } from "../apps/server/dist/src/database.js";
import { CollaborationService } from "../apps/server/dist/src/service.js";
import { CodeRepository } from "../apps/server/dist/src/code-repository.js";
import { HOSTED_CPUSET_ENTRYPOINT, parseHostedCpuSet } from "../apps/server/dist/src/hosted-container-cpu.js";
import { parseHostedMemoryPolicy } from "../apps/server/dist/src/hosted-container-memory.js";
import { hostedFailureCode } from "../apps/server/dist/src/hosted-agent-errors.js";

// Match the hardened Linux service before production creates any mounted files.
if (process.platform === "linux") process.umask(0o077);

const image = process.env.GATHERTHREAD_TEST_HOSTED_IMAGE;
assert.ok(image, "Set GATHERTHREAD_TEST_HOSTED_IMAGE to the locally built test image");
const inspected = runHostedDockerCommand(["image", "inspect", "--format", "{{.Id}}", image]);
assert.equal(inspected.status, 0, "The reviewed local daemon must have the smoke image");
const memoryMiB = hostedContainerMemoryMiB("trial", process.env.GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB === undefined
  ? undefined : Number(process.env.GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB));
const cpuSet = parseHostedCpuSet(process.env.GATHERTHREAD_HOSTED_AGENT_CPUSET);
const memoryPolicy = parseHostedMemoryPolicy(process.env.GATHERTHREAD_HOSTED_AGENT_MEMORY_POLICY);
const directory = mkdtempSync(join(tmpdir(), "gt-hosted-smoke-"));
let endpoint = { id: "smoke", profileId: "default", label: "Smoke model", provider: "cloudflare-workers-ai",
  model: HOSTED_MODEL, baseUrl: `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1`,
  apiToken: "test-only-provider-token", quotaGroup: "smoke", dailyRuns: 4, maxConcurrent: 1 };
const file = (path, content, executable = false) => ({ path,
  content_base64: Buffer.from(content).toString("base64"), executable });
const sourcePath = "src/deep/nested/value.cjs";
// Workspace tmpfs forbids direct execution. Preserve executable metadata, then use its interpreter.
const initialFiles = [file(sourcePath, "module.exports = 1;\n"),
  file("src/deep/nested/check.sh", "#!/bin/sh\nset -eu\nnode -e \"require('node:assert/strict').equal(require('./src/deep/nested/value.cjs'), 2)\"\nprintf '%s\\n' EXECUTABLE_OK\n", true),
  file("test.cjs", "require('node:assert/strict').equal(require('./src/deep/nested/value.cjs'), 2); require('node:assert/strict').equal(require('node:child_process').execFileSync('/bin/sh', ['./src/deep/nested/check.sh'], {encoding:'utf8'}), 'EXECUTABLE_OK\\n'); console.log('TEST_OK');\n")];
const checks = "const assert=require('node:assert/strict'),fs=require('node:fs');"
  + "assert.equal(process.getuid(),10001);"
  + "assert.equal(fs.readFileSync('/input/src/deep/nested/value.cjs','utf8'),'module.exports = 1;\\n');"
  + "assert.equal(fs.statSync('/input/src/deep/nested/check.sh').mode & 0o111,0o111);"
  + "assert.equal(fs.statSync('src/deep/nested/check.sh').mode & 0o100,0o100);"
  + "assert.throws(()=>fs.writeFileSync('/input/src/deep/nested/value.cjs','tampered'),e=>e.code==='EROFS');"
  + "assert.throws(()=>fs.writeFileSync('/run/gatherthread/prompt.txt','tampered'),e=>e.code==='EROFS');"
  + "assert.equal(fs.readFileSync('/run/gatherthread/opencode.json','utf8').includes('test-only-provider-token'),false);"
  + "assert.equal(fs.readFileSync('/run/gatherthread/opencode.json','utf8').includes('test-only-anthropic-token'),false);"
  + "assert.equal(Object.keys(process.env).some(k=>/^(GATHERTHREAD_|GITHUB_TOKEN$|GH_TOKEN$|AWS_|SILICONFLOW_API_KEY$|OPENAI_API_KEY$)/.test(k)),false);"
  + "fs.writeFileSync('src/deep/nested/value.cjs','module.exports = 2;\\n');console.log('READONLY_OK');console.log('SECRETS_ABSENT');";
const commandMarker = `GT_SMOKE_COMMAND_OK_${randomBytes(12).toString("hex")}`;
const command = `node -e ${JSON.stringify(checks)} && node test.cjs && printf '\\n%s\\n' ${commandMarker}`;

function toolOutputLines(messages) {
  const text = content => typeof content === "string" ? [content] : Array.isArray(content)
    ? content.flatMap(block => block.type === "text" ? [block.text] : block.type === "tool_result" ? text(block.content) : []) : [];
  return messages.filter((message) => message.role === "tool" || Array.isArray(message.content)
    && message.content.some(block => block.type === "tool_result")).flatMap(message => text(message.content))
    .flatMap((content) => content.split(/\r?\n/u));
}
let calls = 0;
let toolIssued = false;
let observedChecks = false;
let reportedFixtureFailure = false;
const fetcher = async (url, init) => {
    const native = endpoint.transport === "anthropic-messages";
    assert.equal(String(url), `${endpoint.baseUrl}/${native ? "messages" : "chat/completions"}`);
    assert.equal(new Headers(init.headers).get(native ? "x-api-key" : "authorization"), native ? endpoint.apiToken : `Bearer ${endpoint.apiToken}`);
    calls += 1;
    const body = JSON.parse(String(init?.body));
    let check = "prompt";
    try {
      assert.match(JSON.stringify(body.messages), /Update the nested source/, "Fixture user instruction missing from model request");
      if (body.messages.some((message) => message.role === "tool" || Array.isArray(message.content)
        && message.content.some(block => block.type === "tool_result"))) {
        check = "tool stdout";
        const lines = toolOutputLines(body.messages);
        for (const marker of ["TEST_OK", "READONLY_OK", "SECRETS_ABSENT", commandMarker]) {
          assert.ok(lines.includes(marker), `Missing fixture tool stdout marker: ${marker}`);
        }
        observedChecks = true;
      }
    } catch (error) {
      if (!reportedFixtureFailure) {
        reportedFixtureFailure = true;
        // Only fixed fixture tool text, never the full provider request or production output.
        process.stderr.write(`Trial fixture assertion (${check}, call ${calls}, tool issued ${toolIssued}): ${String(error.message).slice(0, 600)}\n`);
        process.stderr.write(`Fixture tool text: ${JSON.stringify(toolOutputLines(body.messages)).slice(0, 4000)}\n`);
      }
      throw error;
    }
    const bash = Array.isArray(body.tools) && body.tools.some((tool) => (native ? tool?.name : tool?.function?.name) === "bash");
    const useTool = bash && !toolIssued;
    if (useTool) toolIssued = true;
    if (native) {
      assert.equal(body.model, endpoint.model);
      assert.equal(new Headers(init.headers).get("anthropic-version"), "2023-06-01");
      const content = useTool ? { type: "tool_use", id: "tool_smoke", name: "bash", input: { command,
        description: "Verify read-only input and edit and test nested source" } } : { type: "text", text: "READY" };
      const message = { id: `msg_fixture_${calls}`, type: "message", role: "assistant", model: endpoint.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } };
      if (!body.stream) return Response.json({ ...message, content: [content], stop_reason: useTool ? "tool_use" : "end_turn",
        usage: { input_tokens: 30, output_tokens: 20 } });
      const frame = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
      const data = frame("message_start", { message }) + frame("content_block_start", { index: 0,
        content_block: useTool ? { ...content, input: {} } : { type: "text", text: "" } })
        + frame("content_block_delta", { index: 0, delta: useTool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
          : { type: "text_delta", text: "READY" } }) + frame("content_block_stop", { index: 0 })
        + frame("message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } })
        + frame("message_stop", {});
      return new Response(data, { headers: { "content-type": "text/event-stream" } });
    }
    const chunk = (delta, finish_reason = null) => JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: HOSTED_MODEL,
      choices: [{ index: 0, delta, finish_reason }],
    });
    if (body.stream) {
      const data = useTool
        ? `data: ${chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_test", type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command,
            description: "Verify read-only input and edit and test nested source" }) } }] })}\n\ndata: ${chunk({}, "tool_calls")}\n\ndata: [DONE]\n\n`
        : `data: ${chunk({ role: "assistant", content: "READY" })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`;
      return new Response(data, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion", created: 1, model: HOSTED_MODEL,
      choices: [{ index: 0, message: useTool ? { role: "assistant", content: null,
        tool_calls: [{ id: "call_test", type: "function", function: { name: "bash",
          arguments: JSON.stringify({ command,
            description: "Verify read-only input and edit and test nested source" }) } }] }
        : { role: "assistant", content: "READY" }, finish_reason: useTool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
    }), { headers: { "content-type": "application/json" } });
};

const database = new CollaborationDatabase(join(directory, "db.sqlite"), { authTokenPepper: "hosted-smoke-only-pepper" });
async function runFixtureDocker(args) {
  const name = args[args.indexOf("--name") + 1];
  assert.ok(typeof name === "string" && /^gt-hosted-[a-f0-9]{16}$/u.exec(name)?.[0] === name);
  assert.equal(args.filter(argument => argument === "--rm").length, 1);
  assert.equal(args[args.indexOf("--user") + 1], "10001:10001");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "128");
  if (cpuSet === undefined) assert.equal(args[args.indexOf("--cpus") + 1], "1");
  else {
    assert.ok(!args.includes("--cpus"));
    assert.equal(args[args.indexOf("--cpuset-cpus") + 1], cpuSet);
    assert.equal(args[args.indexOf("--entrypoint") + 1], HOSTED_CPUSET_ENTRYPOINT);
    const memoryMarker = memoryPolicy === "shared-host" ? "GT_HOSTED_MEMORY_POLICY=shared-host"
      : `GT_HOSTED_MEMORY_BYTES=${memoryMiB * 1024 * 1024}`;
    assert.ok(args.includes(`GT_HOSTED_CPUSET=${cpuSet}`) && args.includes(memoryMarker)
      && args.includes("GT_HOSTED_PIDS=128"));
  }
  if (memoryPolicy === "shared-host") {
    assert.ok(!args.includes("--memory") && !args.includes("--memory-swap"));
  } else {
    assert.equal(args[args.indexOf("--memory") + 1], `${memoryMiB}m`);
    assert.equal(args[args.indexOf("--memory-swap") + 1], `${memoryMiB}m`);
  }
  assert.ok(args.includes("--read-only") && args.includes("no-new-privileges"));
  assert.ok(args.some((argument) => argument.endsWith("dst=/input,readonly")));
  assert.equal(args.at(-1), inspected.stdout.trim());
  assert.equal(args.includes(endpoint.apiToken), false);
  const controlMount = args.find((argument) => argument.endsWith("dst=/run/gatherthread,readonly"));
  assert.ok(controlMount);
  const control = controlMount.split("src=")[1].split(",dst=")[0];
  assert.equal(readFileSync(join(control, "opencode.json"), "utf8").includes(endpoint.apiToken), false);
  const config = JSON.parse(readFileSync(join(control, "opencode.json"), "utf8"));
  assert.equal(config.provider.hosted.npm, endpoint.transport === "anthropic-messages" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible");
  const fixtureArgs = args.filter(argument => argument !== "--rm");
  try {
    return await runDocker([...fixtureArgs.slice(0, -1), "-e", "GT_HOSTED_SMOKE_DEBUG=1", fixtureArgs.at(-1)], 90_000);
  } catch (error) {
    // Fixture-only allowlisted categories/booleans, never raw stderr, request,
    // tools, headers or exception text. Keep the failure meaningful in CI.
    process.stderr.write(`Hosted smoke runner failure: ${JSON.stringify({ code: hostedFailureCode(error),
      provider_attempts: calls, tool_issued: toolIssued, observed_checks: observedChecks })}\n`);
    reportTrialFixtureFailure(name, { createClient: createHostedDockerClient });
    throw error;
  } finally { stopHostedContainer(name); }
}

try {
  const actor = database.bootstrapIdentity({ display_name: "Smoke", device_name: "Fixture" }).actor;
  const service = new CollaborationService(database);
  const session = service.createSession(actor, { session_id: "smoke-session", idempotency_key: "smoke-session",
    mode: "solo", title: "Hosted fixture" }).session;
  const repository = new CodeRepository(database, join(directory, "code"));
  repository.enable(actor, session.project_id, { idempotency_key: "smoke-enable" });
  repository.checkpoint(actor, session.project_id, { base_commit: null, files: initialFiles,
    message: "Fixture source", idempotency_key: "smoke-initial-code" });
  const agent = new HostedAgent(service, repository, { endpoints: [endpoint], image: inspected.stdout.trim(),
    memoryMiB, memoryPolicy, ...(cpuSet === undefined ? {} : { cpuSet }), userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, fetch: fetcher, runContainer: runFixtureDocker });
  const result = await agent.request(actor, session.id, { profile_id: endpoint.profileId, include_code: true,
    content: "Update the nested source to export two, run its test, then reply READY.", idempotency_key: "smoke-run" });
  assert.ok(result.response_event, "the production trial must produce a terminal response");
  if (result.response_event.payload.status === "failed") process.stderr.write(`Hosted smoke terminal failure: ${JSON.stringify({
    code: hostedFailureCode(new Error(result.response_event.payload.error?.code)),
    provider_attempts: calls, tool_issued: toolIssued, observed_checks: observedChecks })}\n`);
  assert.match(result.response_event.payload.content, /READY/);
  assert.ok(toolIssued, "OpenCode must advertise and invoke its bash tool");
  assert.ok(observedChecks && calls >= 2, "the harness must verify its actual tool results through the socket");
  const status = repository.status(actor, session.project_id);
  const snapshot = repository.snapshot(actor, session.project_id, status.own_branch_id).snapshot;
  assert.deepEqual(snapshot.files, initialFiles.map((entry) => entry.path === sourcePath
    ? file(sourcePath, "module.exports = 2;\n") : entry).sort((a, b) => a.path.localeCompare(b.path)));
  const memoryDescription = memoryPolicy === "shared-host" ? "shared-host RAM/swap" : `${memoryMiB}m`;
  process.stdout.write(`Hosted OpenCode production-path smoke passed at ${memoryDescription}${cpuSet === undefined ? "" : ` with guarded CPU ${cpuSet}`} under strict Linux umask: nested source edited and tested, read-only input and credential isolation verified; ${calls} fake model call(s).\n`);
  // Exercise the bundled native Anthropic SDK against the same immutable,
  // network-disabled executor and its real bash/tool-result loop. No provider
  // account/key or extra SDK download is involved in this fixture.
  const nativeActor = database.createIdentity({ display_name: "Native smoke", device_name: "Fixture", can_create_projects: true }).actor;
  const nativeSession = service.createSession(nativeActor, { session_id: "native-smoke-session", idempotency_key: "native-smoke-session",
    mode: "solo", title: "Native Messages fixture" }).session;
  repository.enable(nativeActor, nativeSession.project_id, { idempotency_key: "native-smoke-enable" });
  repository.checkpoint(nativeActor, nativeSession.project_id, { base_commit: null, files: initialFiles,
    message: "Fixture source", idempotency_key: "native-smoke-initial" });
  const nativeAgent = new HostedAgent(service, repository, { endpoints: [endpoint], image: inspected.stdout.trim(),
    personalApiEncryptionKey: randomBytes(32).toString("base64"), memoryMiB, memoryPolicy, ...(cpuSet === undefined ? {} : { cpuSet }),
    userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, fetch: fetcher, runContainer: runFixtureDocker });
  const saved = nativeAgent.putPersonalApi(nativeActor, randomUUID(), { expected_revision: null, provider_id: "anthropic",
    label: "Native fixture", model: "claude-fixture", enabled: true, api_key: ["test", "only", "anthropic", "token"].join("-") });
  endpoint = nativeAgent.personalApi.resolve(nativeActor, saved.profile_id, saved.revision);
  calls = 0; toolIssued = false; observedChecks = false; reportedFixtureFailure = false;
  const nativeResult = await nativeAgent.request(nativeActor, nativeSession.id, { profile_id: saved.profile_id, api_config_revision: saved.revision,
    include_code: true, content: "Update the nested source to export two, run its test, then reply READY.", idempotency_key: "native-smoke-run" });
  if (nativeResult.response_event?.payload.status === "failed") process.stderr.write(`Native smoke terminal failure: ${JSON.stringify({
    code: hostedFailureCode(new Error(nativeResult.response_event.payload.error?.code)),
    provider_attempts: calls, tool_issued: toolIssued, observed_checks: observedChecks })}\n`);
  assert.match(nativeResult.response_event?.payload?.content ?? "", /READY/);
  assert.ok(toolIssued && observedChecks && calls >= 2, "native SDK must stream a bash call and its actual result before the answer");
  const nativeStatus = repository.status(nativeActor, nativeSession.project_id);
  assert.deepEqual(repository.snapshot(nativeActor, nativeSession.project_id, nativeStatus.own_branch_id).snapshot.files, snapshot.files);
  assert.equal(database.hostedAgentUsage(nativeActor, 4, 4).user_used_runs, 0);
  process.stdout.write(`Hosted bundled Anthropic Messages smoke passed at ${memoryDescription}: native streamed tools, tool results, final answer and private checkpoint; ${calls} synthetic call(s).\n`);
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
