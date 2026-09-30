import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedModelProxy, HOSTED_MODEL } from "../apps/server/dist/src/hosted-agent.js";

const image = process.env.GATHERTHREAD_TEST_HOSTED_IMAGE;
assert.ok(image, "Set GATHERTHREAD_TEST_HOSTED_IMAGE to the locally built test image");
const directory = mkdtempSync(join(tmpdir(), "gt-hosted-smoke-"));
const input = join(directory, "input");
const control = join(directory, "control");
const socket = join(directory, "model.sock");
mkdirSync(input, { mode: 0o755 });
mkdirSync(control, { mode: 0o755 });
chmodSync(input, 0o755);
chmodSync(control, 0o755);
writeFileSync(join(control, "opencode.json"), JSON.stringify({
  model: `hosted/${HOSTED_MODEL}`,
  small_model: `hosted/${HOSTED_MODEL}`,
  share: "disabled",
  provider: { hosted: { npm: "@ai-sdk/openai-compatible", name: "Test model",
    options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "local" },
    models: { [HOSTED_MODEL]: { name: "Qwen3 test", limit: { context: 32_000, output: 1024 } } } } },
  permission: { read: "allow", edit: "allow", bash: "allow", task: "deny",
    external_directory: "allow", webfetch: "deny", websearch: "deny" },
}), { mode: 0o644 });
writeFileSync(join(control, "prompt.txt"),
  "Use the terminal to create hello.txt containing READY. Then reply READY.", { mode: 0o644 });

let calls = 0;
let toolIssued = false;
const proxy = new HostedModelProxy({
  endpoint: { id: "smoke", profileId: "default", label: "Smoke model", provider: "cloudflare-workers-ai",
    model: HOSTED_MODEL, baseUrl: `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1`,
    apiToken: "test-only-provider-token", quotaGroup: "smoke", dailyRuns: 4, maxConcurrent: 1 },
  fetch: async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    assert.match(JSON.stringify(body.messages), /create hello\.txt containing READY/);
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
          function: { name: "bash", arguments: JSON.stringify({ command: "printf READY > hello.txt",
            description: "Write a marker file in the project" }) } }] })}\n\ndata: ${chunk({}, "tool_calls")}\n\ndata: [DONE]\n\n`
        : `data: ${chunk({ role: "assistant", content: "READY" })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`;
      return new Response(data, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion", created: 1, model: HOSTED_MODEL,
      choices: [{ index: 0, message: useTool ? { role: "assistant", content: null,
        tool_calls: [{ id: "call_test", type: "function", function: { name: "bash",
          arguments: JSON.stringify({ command: "printf READY > hello.txt",
            description: "Write a marker file in the project" }) } }] }
        : { role: "assistant", content: "READY" }, finish_reason: useTool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
    }), { headers: { "content-type": "application/json" } });
  },
});

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("smoke timeout")); }, 90_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`container exited ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

try {
  await proxy.listen(socket);
  const answer = await runDocker([
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "768m", "--cpus", "1",
    "--user", "10001:10001", "--workdir", "/workspace",
    "--mount", `type=bind,src=${input},dst=/input,readonly`,
    "--mount", `type=bind,src=${control},dst=/run/gatherthread,readonly`,
    "--mount", `type=bind,src=${socket},dst=/run/model.sock`,
    "--tmpfs", "/workspace:rw,nosuid,size=32m,mode=1777",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--tmpfs", "/home/agent:rw,nosuid,size=64m",
    "-e", "HOME=/home/agent", "-e", "OPENCODE_CONFIG=/run/gatherthread/opencode.json",
    "-e", "NO_COLOR=1", "-e", "CI=1", "-e", "GT_HOSTED_SMOKE_DEBUG=1", image,
  ]);
  const result = JSON.parse(answer);
  assert.match(result.answer, /READY/);
  assert.ok(toolIssued, "OpenCode must advertise and invoke its bash tool");
  assert.deepEqual(result.files, [{ path: "hello.txt",
    content_base64: Buffer.from("READY").toString("base64"), executable: false }]);
  assert.ok(calls > 0, "the harness must reach the model through the socket");
  process.stdout.write(`Hosted OpenCode container smoke passed with ${calls} fake model call(s).\n`);
} finally {
  await proxy.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
