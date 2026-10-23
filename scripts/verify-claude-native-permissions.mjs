#!/usr/bin/env node
// Opt-in native CLI acceptance. Loopback fake provider, no real model or account.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeCliExecutor } from "../packages/bridge/dist/src/claude-code-executor.js";

const command = process.argv[2];
if (!command || !path.isAbsolute(command)) throw new Error("Pass the absolute path of an installed Claude Code CLI");
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-native-permissions-")));
const model = "claude-sonnet-4-6", installCommand = "npm install --offline --ignore-scripts --no-audit --no-fund";
try {
  for (const allowed of [true, false]) {
    const directory = path.join(temporary, allowed ? "allow" : "deny"), config = path.join(directory, "config");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(path.join(directory, "fixture-dependency"));
    await writeFile(path.join(directory, "fixture-dependency/package.json"), JSON.stringify({ name: "gt-local-dependency", version: "1.0.0", main: "index.cjs" }));
    await writeFile(path.join(directory, "fixture-dependency/index.cjs"), "module.exports = 'installed locally';\n");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "gt-native-permission-fixture", version: "1.0.0", private: true, dependencies: { "gt-local-dependency": "file:./fixture-dependency" } }));
    await writeFile(path.join(directory, "hook.cjs"), "require('node:fs').appendFileSync('native-hook-proof.txt','hook ran\\n');\n");
    const settings = JSON.stringify({ permissions: { defaultMode: "default", [allowed ? "allow" : "deny"]: [`Bash(${installCommand})`] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node hook.cjs" }] }] } });
    await writeFile(path.join(config, "settings.json"), settings, { mode: 0o600 });
    let calls = 0;
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls++;
      if (calls > 4) { response.writeHead(429).end(); return; }
      const used = body.messages?.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result"));
      const content = used ? [{ type: "text", text: "Local permission fixture finished." }]
        : [{ type: "tool_use", id: "toolu_fixture_install", name: "Bash", input: { command: installCommand, description: "Install the offline fixture dependency" } }];
      const message = { id: `msg_fixture_${calls}`, type: "message", role: "assistant", model, content,
        stop_reason: used ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        send({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
        send({ type: "content_block_start", index: 0, content_block: used ? { type: "text", text: "" } : { ...content[0], input: {} } });
        send({ type: "content_block_delta", index: 0, delta: used ? { type: "text_delta", text: content[0].text } : { type: "input_json_delta", partial_json: JSON.stringify(content[0].input) } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
        send({ type: "message_stop" }); response.end();
      } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const env = { ...process.env, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: "synthetic-local-test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", npm_config_cache: path.join(directory, "npm-cache") };
    // Do not let an inherited real account or a developer's optional safe-mode
    // environment choose another provider/configuration for this private fixture.
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE"]) delete env[key];
    const executor = new ClaudeCodeCliExecutor({ command, workspacePath: directory, statePath: path.join(directory, "run.json"), model, env, timeoutMs: 60000 });
    try {
      const input = { request: { id: "request-native", sessionId: "session-native", sequence: 1, type: "agent_request", actorId: "user-native", timestamp: new Date().toISOString(),
        payload: { content: `Run exactly this offline fixture installation: ${installCommand}`, execution_profile: { harness: "claude-code", provider: "anthropic", model, runtime_id: "runtime-native" } } }, canonicalHistory: [],
        runtime: { id: "runtime-native", userId: "user-native", deviceId: "device-native", sessionId: "session-native", harness: "claude-code", provider: "anthropic", model, localSessionId: "fixture", captureFidelity: "harness_transcript" } };
      if (allowed) {
        const result = await executor.execute(input);
        assert.equal(result.events.at(-1).content, "Local permission fixture finished.");
        assert.match(await readFile(path.join(directory, "node_modules/gt-local-dependency/index.cjs"), "utf8"), /installed locally/);
        assert.ok(result.events.some(event => event.toolName === "Bash"));
      } else {
        await assert.rejects(executor.execute(input), error => error.failureCode === "claude_permission_required");
        await assert.rejects(readFile(path.join(directory, "node_modules/gt-local-dependency/index.cjs")), /ENOENT/);
      }
      assert.match(await readFile(path.join(directory, "native-hook-proof.txt"), "utf8"), /hook ran/);
      assert.equal(await readFile(path.join(config, "settings.json"), "utf8"), settings);
      assert.ok(calls > 0 && calls <= 4);
      console.log(`Native Claude ${allowed ? "ALLOW: offline npm dependency installed" : "DENY: no installation side effect"}; local Hooks loaded; settings unchanged; real provider calls: 0.`);
    } finally { await executor.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
