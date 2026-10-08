import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAgent, HOSTED_MODEL, hostedContainerMemoryMiB, runDocker } from "../apps/server/dist/src/hosted-agent.js";
import { runHostedDockerCommand, stopHostedContainer } from "../apps/server/dist/src/hosted-agent-recovery.js";
import { CollaborationDatabase } from "../apps/server/dist/src/database.js";
import { CollaborationService } from "../apps/server/dist/src/service.js";
import { CodeRepository } from "../apps/server/dist/src/code-repository.js";

// Match the hardened Linux service before production creates any mounted files.
if (process.platform === "linux") process.umask(0o077);

const image = process.env.GATHERTHREAD_TEST_HOSTED_IMAGE;
assert.ok(image, "Set GATHERTHREAD_TEST_HOSTED_IMAGE to the locally built test image");
const inspected = runHostedDockerCommand(["image", "inspect", "--format", "{{.Id}}", image]);
assert.equal(inspected.status, 0, "The reviewed local daemon must have the smoke image");
const memoryMiB = hostedContainerMemoryMiB("trial", process.env.GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB === undefined
  ? undefined : Number(process.env.GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB));
const directory = mkdtempSync(join(tmpdir(), "gt-hosted-smoke-"));
const endpoint = { id: "smoke", profileId: "default", label: "Smoke model", provider: "cloudflare-workers-ai",
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
  + "assert.equal(Object.keys(process.env).some(k=>/^(GATHERTHREAD_|GITHUB_TOKEN$|GH_TOKEN$|AWS_|SILICONFLOW_API_KEY$|OPENAI_API_KEY$)/.test(k)),false);"
  + "fs.writeFileSync('src/deep/nested/value.cjs','module.exports = 2;\\n');console.log('READONLY_OK');console.log('SECRETS_ABSENT');";
const commandMarker = `GT_SMOKE_COMMAND_OK_${randomBytes(12).toString("hex")}`;
const command = `node -e ${JSON.stringify(checks)} && node test.cjs && printf '\\n%s\\n' ${commandMarker}`;

function toolOutputLines(messages) {
  return messages.filter((message) => message.role === "tool").flatMap((message) =>
    typeof message.content === "string" ? [message.content]
      : Array.isArray(message.content) ? message.content.filter((block) =>
        block.type === "text" && typeof block.text === "string").map((block) => block.text) : [])
    .flatMap((content) => content.split(/\r?\n/u));
}
let calls = 0;
let toolIssued = false;
let observedChecks = false;
let reportedFixtureFailure = false;
const fetcher = async (url, init) => {
    assert.equal(String(url), `${endpoint.baseUrl}/chat/completions`);
    calls += 1;
    const body = JSON.parse(String(init?.body));
    let check = "prompt";
    try {
      assert.match(JSON.stringify(body.messages), /Update the nested source/, "Fixture user instruction missing from model request");
      if (body.messages.some((message) => message.role === "tool")) {
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
    const bash = Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === "bash");
    const useTool = bash && !toolIssued;
    if (useTool) toolIssued = true;
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
  assert.equal(args[args.indexOf("--user") + 1], "10001:10001");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "128");
  assert.equal(args[args.indexOf("--cpus") + 1], "1");
  assert.equal(args[args.indexOf("--memory") + 1], `${memoryMiB}m`);
  assert.equal(args[args.indexOf("--memory-swap") + 1], `${memoryMiB}m`);
  assert.ok(args.includes("--read-only") && args.includes("no-new-privileges"));
  assert.ok(args.some((argument) => argument.endsWith("dst=/input,readonly")));
  assert.equal(args.at(-1), inspected.stdout.trim());
  assert.equal(args.includes(endpoint.apiToken), false);
  const controlMount = args.find((argument) => argument.endsWith("dst=/run/gatherthread,readonly"));
  assert.ok(controlMount);
  const control = controlMount.split("src=")[1].split(",dst=")[0];
  assert.equal(readFileSync(join(control, "opencode.json"), "utf8").includes(endpoint.apiToken), false);
  try {
    return await runDocker([...args.slice(0, -1), "-e", "GT_HOSTED_SMOKE_DEBUG=1", args.at(-1)], 90_000);
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
    memoryMiB, userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, fetch: fetcher, runContainer: runFixtureDocker });
  const result = await agent.request(actor, session.id, { profile_id: endpoint.profileId, include_code: true,
    content: "Update the nested source to export two, run its test, then reply READY.", idempotency_key: "smoke-run" });
  assert.ok(result.response_event, "the production trial must produce a terminal response");
  assert.match(result.response_event.payload.content, /READY/);
  assert.ok(toolIssued, "OpenCode must advertise and invoke its bash tool");
  assert.ok(observedChecks && calls >= 2, "the harness must verify its actual tool results through the socket");
  const status = repository.status(actor, session.project_id);
  const snapshot = repository.snapshot(actor, session.project_id, status.own_branch_id).snapshot;
  assert.deepEqual(snapshot.files, initialFiles.map((entry) => entry.path === sourcePath
    ? file(sourcePath, "module.exports = 2;\n") : entry).sort((a, b) => a.path.localeCompare(b.path)));
  process.stdout.write(`Hosted OpenCode production-path smoke passed at ${memoryMiB}m under strict Linux umask: nested source edited and tested, read-only input and credential isolation verified; ${calls} fake model call(s).\n`);
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
