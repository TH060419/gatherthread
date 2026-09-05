import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startCollaborationServer } from "../apps/server/dist/src/server.js";
import { HttpCollaborationClient } from "../packages/bridge/dist/src/index.js";
import {
  deriveDshSessionId,
  DSH_COMPATIBILITY,
} from "../packages/dsh-host/dist/src/index.js";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DSH_SOURCE = process.env.GATHERTHREAD_DSH_SOURCE?.trim();
const TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT = 1_000_000;
const PROJECT_ID = "dsh-real-loader-project";
const SESSION_ID = "dsh-real-loader-session";
const DEVICE_ID = "dsh-real-loader-device";
const MODEL = "deepseek-v4-flash";
const PROVIDER = "deepseek-official";

if (!DSH_SOURCE || !path.isAbsolute(DSH_SOURCE)) {
  throw new Error(
    "GATHERTHREAD_DSH_SOURCE must name an absolute, already-installed checkout of the pinned DeepSeek Harness commit",
  );
}

const source = path.resolve(DSH_SOURCE);
const sourceRequire = createRequire(path.join(source, "package.json"));
const tsxLoader = pathToFileURL(sourceRequire.resolve("tsx/esm")).href;
const dshBin = path.join(source, "apps/cli/src/bin.ts");
const sourcePatch = path.join(source, "apps/cli/src/sdk-source.cordis.patch.yml");
const enabledPatch = path.join(
  REPOSITORY_ROOT,
  "packages/dsh-host/bundle/enabled.example.cordis.patch.yml",
);
const witnessPlugin = path.join(
  REPOSITORY_ROOT,
  "packages/dsh-host/integration/loader-witness.mjs",
);
const packageRoot = path.join(REPOSITORY_ROOT, "packages/dsh-host");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function withTimeout(promise, label, milliseconds = TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

function sanitizedOutput(host, secrets) {
  let output = `${host.stdout}\n${host.stderr}`;
  for (const secret of secrets) output = output.replaceAll(secret, "[REDACTED]");
  return output.slice(-8_000);
}

async function waitUntil(label, check, hosts = [], secrets = []) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    for (const host of hosts) {
      if (host.child.exitCode !== null || host.child.signalCode !== null) {
        throw new Error(
          `DSH Host exited before ${label}: code=${host.child.exitCode} signal=${host.child.signalCode}\n${sanitizedOutput(host, secrets)}`,
        );
      }
    }
    await delay(100);
  }
  const diagnostics = hosts.map((host, index) =>
    `host[${index}] code=${host.child.exitCode} signal=${host.child.signalCode}\n${sanitizedOutput(host, secrets)}`,
  ).join("\n");
  throw new Error(`Timed out waiting for ${label}${diagnostics ? `\n${diagnostics}` : ""}`);
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  const result = await withTimeout(new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  }), path.basename(command));
  return { ...result, stdout, stderr };
}

async function verifyPinnedDsh() {
  await Promise.all([
    access(dshBin),
    access(sourcePatch),
    access(path.join(source, "node_modules/tsx")),
    access(path.join(packageRoot, "dist/src/plugin.js")),
    access(path.join(packageRoot, "bundle/project.example.cordis.patch.yml")),
    access(witnessPlugin),
  ]);
  const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: source, env: process.env });
  assert.equal(head.code, 0, head.stderr);
  assert.equal(head.stdout.trim(), DSH_COMPATIBILITY.commit, "DSH checkout commit drifted");
  const status = await runProcess("git", ["status", "--porcelain"], { cwd: source, env: process.env });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stdout, "", "DSH checkout must be clean for a reproducible compatibility gate");
  const manifest = JSON.parse(await readFile(path.join(source, "apps/cli/package.json"), "utf8"));
  assert.equal(manifest.version, DSH_COMPATIBILITY.version, "DSH CLI version drifted");
}

async function requestData(origin, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  assert.ok(response.ok, `${options.method ?? "GET"} ${pathname} failed with ${response.status}: ${JSON.stringify(payload?.error ?? {})}`);
  return payload?.data;
}

function isPublicationPath(url, method) {
  if (method !== "POST") return false;
  return /\/v1\/sessions\/[^/]+\/(?:agent-requests\/[^/]+\/(?:progress|complete)|events)$/.test(url);
}

async function startForwardProxy(upstreamOrigin) {
  const registrations = [];
  const errors = [];
  let pendingBlock;
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (pendingBlock && !pendingBlock.claimed && isPublicationPath(request.url ?? "", request.method ?? "")) {
        pendingBlock.claimed = true;
        pendingBlock.arrived.resolve(request.url);
        response.once("close", () => {
          pendingBlock?.aborted.resolve();
          pendingBlock = undefined;
        });
        return;
      }

      const headers = new Headers();
      for (const [name, raw] of Object.entries(request.headers)) {
        if (["connection", "content-length", "host", "transfer-encoding"].includes(name)) continue;
        for (const value of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) headers.append(name, value);
      }
      const upstream = await fetch(`${upstreamOrigin}${request.url}`, {
        method: request.method,
        headers,
        ...(body.length === 0 ? {} : { body }),
      });
      const resultBody = Buffer.from(await upstream.arrayBuffer());
      if (request.method === "POST" && request.url === "/v1/runtimes" && upstream.ok) {
        const parsed = JSON.parse(resultBody.toString("utf8"));
        registrations.push(parsed.data.runtime.id);
      }
      const responseHeaders = {};
      upstream.headers.forEach((value, name) => {
        if (!["connection", "content-length", "transfer-encoding"].includes(name)) responseHeaders[name] = value;
      });
      response.writeHead(upstream.status, responseHeaders);
      response.end(resultBody);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error("Proxy forwarding failed"));
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "test_proxy_failure", message: "fixture proxy failure" } }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    registrations,
    errors,
    blockNextPublication() {
      assert.equal(pendingBlock, undefined, "Only one publication block may be armed");
      const arrived = deferred();
      const aborted = deferred();
      pendingBlock = { arrived, aborted, claimed: false };
      return { arrived: arrived.promise, aborted: aborted.promise };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

function newestCanonicalPrompt(messages) {
  return messages
    .filter((message) => message?.role === "user")
    .map((message) => messageText(message.content))
    .findLast((text) => text.includes("GatherThread canonical context follows"));
}

function openSse(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "" }, finish_reason: null }] })}\n\n`);
}

function writeSse(response, payload) {
  response.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function finishSse(response, reasoning, text) {
  openSse(response);
  writeSse(response, { choices: [{ index: 0, delta: { content: null, reasoning_content: reasoning }, finish_reason: null }] });
  writeSse(response, { choices: [{ index: 0, delta: { content: text, reasoning_content: null }, finish_reason: null }] });
  writeSse(response, {
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
  writeSse(response, "[DONE]");
  response.end();
}

async function startMockLlm(apiKey, toolSecret) {
  const records = [];
  const requestThreeStarted = deferred();
  const sockets = new Set();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        assert.ok(request.url?.endsWith("/chat/completions"));
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const encoded = JSON.stringify(messages);
        const userTexts = messages.filter((message) => message?.role === "user").map((message) => messageText(message.content));
        const canonicalPrompt = newestCanonicalPrompt(messages);
        let kind;
        if (userTexts.some((text) => text.includes("Continue the interrupted GatherThread request"))) kind = "recovery";
        else if (canonicalPrompt?.includes("gate-one-request-three")) kind = "request-three";
        else if (canonicalPrompt?.includes("gate-one-request-two")) kind = "request-two";
        else if (encoded.includes('"tool_call_id":"gatherthread-fixture-call"')) kind = "tool-followup";
        else if (canonicalPrompt?.includes("gate-one-request-one")) kind = "tool-call";
        else kind = "unexpected";
        records.push({ kind, canonicalPrompt });

        if (kind === "tool-call") {
          const argumentsJson = JSON.stringify({ public_value: "tool-public-result", token: toolSecret });
          const midpoint = Math.floor(argumentsJson.length / 2);
          openSse(response);
          writeSse(response, {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "gatherthread-fixture-call",
                  type: "function",
                  function: { name: "gatherthread_redaction_fixture", arguments: argumentsJson.slice(0, midpoint) },
                }],
              },
              finish_reason: null,
            }],
          });
          writeSse(response, {
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(midpoint) } }] },
              finish_reason: null,
            }],
          });
          writeSse(response, {
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          });
          writeSse(response, "[DONE]");
          response.end();
          return;
        }
        if (kind === "tool-followup") {
          finishSse(response, "PRIVATE_REASONING_ONE", "gate-one-final-one");
          return;
        }
        if (kind === "request-two") {
          finishSse(response, "PRIVATE_REASONING_TWO", "gate-one-final-two");
          return;
        }
        if (kind === "request-three") {
          openSse(response);
          writeSse(response, { choices: [{ index: 0, delta: { reasoning_content: "PRIVATE_REASONING_THREE" }, finish_reason: null }] });
          writeSse(response, { choices: [{ index: 0, delta: { content: "partial-before-sigkill" }, finish_reason: null }] });
          requestThreeStarted.resolve();
          return;
        }
        if (kind === "recovery") {
          finishSse(response, "PRIVATE_REASONING_RECOVERY", "gate-one-final-three");
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected mock request", code: "unexpected_request" } }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock fixture assertion failed", code: "fixture_assertion" } }));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    requestThreeStarted: requestThreeStarted.promise,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function initializeProfile(home, runtimeTemp) {
  const result = await runProcess(process.execPath, [
    "--import", tsxLoader, dshBin,
    "--profile", DSH_COMPATIBILITY.profile,
    "--dump-default-config",
  ], {
    cwd: source,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: runtimeTemp,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: "1",
      TSX_TSCONFIG_PATH: path.join(source, "tsconfig.json"),
      NO_COLOR: "1",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const packageScope = path.join(home, "profiles", DSH_COMPATIBILITY.profile, "node_modules", "@gatherthread");
  await mkdir(packageScope, { recursive: true, mode: 0o700 });
  await symlink(packageRoot, path.join(packageScope, "dsh-host"), "dir");
}

function startHost({ home, runtimeTemp, workspace, statePath, auditPath, proxyOrigin, llmOrigin, ownerToken, mockKey, toolSecret, phase, witnessPatch }) {
  const child = spawn(process.execPath, [
    "--import", tsxLoader, dshBin,
    "--profile", DSH_COMPATIBILITY.profile,
    "--patch", sourcePatch,
    "--patch", witnessPatch,
    "--patch", enabledPatch,
  ], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: runtimeTemp,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: "read-only",
      DSH_TELEMETRY_MODE: "DISABLED",
      DSH_TELEMETRY_DISABLED: "1",
      DEEPSEEK_API_KEY: mockKey,
      DEEPSEEK_BASE_URL: llmOrigin,
      TSX_TSCONFIG_PATH: path.join(source, "tsconfig.json"),
      GATHERTHREAD_API_URL: `${proxyOrigin}/v1`,
      GATHERTHREAD_DSH_TOKEN: ownerToken,
      GATHERTHREAD_PROJECT_ID: PROJECT_ID,
      GATHERTHREAD_SESSION_ID: SESSION_ID,
      GATHERTHREAD_DEVICE_ID: DEVICE_ID,
      GATHERTHREAD_DSH_WORKSPACE: workspace,
      GATHERTHREAD_DSH_STATE_PATH: statePath,
      GATHERTHREAD_DSH_PROVIDER: PROVIDER,
      GATHERTHREAD_DSH_MODEL: MODEL,
      GATHERTHREAD_DSH_SHARE_TOOL_EVENTS: "1",
      GATHERTHREAD_DSH_TEST_AUDIT_PATH: auditPath,
      GATHERTHREAD_DSH_TEST_TOOL_SECRET: toolSecret,
      GATHERTHREAD_DSH_TEST_PHASE: phase,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const host = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { host.stdout = appendBounded(host.stdout, chunk); });
  child.stderr.on("data", (chunk) => { host.stderr = appendBounded(host.stderr, chunk); });
  host.exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return host;
}

async function stopHost(host) {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGTERM");
  return withTimeout(host.exit, "graceful DSH Host shutdown", 20_000);
}

async function killHost(host) {
  assert.equal(host.child.kill("SIGKILL"), true);
  const result = await withTimeout(host.exit, "SIGKILL DSH Host shutdown", 20_000);
  assert.equal(result.signal, "SIGKILL");
  return result;
}

async function readAllEvents(api) {
  const events = [];
  let cursor = 0;
  while (true) {
    const page = await api.readEvents(SESSION_ID, cursor, 500);
    events.push(...page.events);
    if (!page.hasMore) return events;
    assert.ok(page.nextSequence > cursor);
    cursor = page.nextSequence;
  }
}

async function waitForFinal(api, requestId, expectedText, hosts, secrets) {
  return waitUntil(`final response ${expectedText}`, async () => {
    const events = await readAllEvents(api);
    const request = events.find((event) => event.id === requestId && event.type === "agent_request");
    const final = request === undefined ? undefined : events.find((event) =>
      event.sequence > request.sequence
        && event.type === "agent_response"
        && event.payload?.text === expectedText,
    );
    return final?.payload?.text === expectedText ? { final, events } : undefined;
  }, hosts, secrets);
}

async function gateDiagnostics(mock, auditPath, statePath) {
  const audit = parseAudit(await readFile(auditPath, "utf8").catch(() => ""));
  const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}"));
  return JSON.stringify({
    mockKinds: mock.records.map((record) => record.kind),
    auditTail: audit.slice(-30).map((record) => ({
      phase: record.phase,
      kind: record.kind,
      type: record.type,
      seq: record.seq,
      settlement: record.settlement,
      publicKind: record.publicProjection?.kind,
      status: record.status,
    })),
    state: {
      serverCursor: state.serverCursor,
      publishedDshSequence: state.publishedDshSequence,
      activeRequest: state.activeRequest,
      outboxKinds: Array.isArray(state.outbox) ? state.outbox.map((operation) => operation.kind) : undefined,
    },
  });
}

function requestOutputs(events, request, nextRequestSequence = Number.POSITIVE_INFINITY) {
  const finalRuntime = events.find((event) =>
    event.sequence > request.sequence
      && event.sequence < nextRequestSequence
      && event.type === "agent_response",
  )?.runtime?.runtimeId;
  assert.ok(finalRuntime, `request ${request.id} has no runtime-labelled final`);
  return events.filter((event) =>
    event.sequence > request.sequence
      && event.sequence < nextRequestSequence
      && event.runtime?.runtimeId === finalRuntime
      && ["agent_progress", "tool_call", "tool_result", "agent_response"].includes(event.type),
  );
}

function assertRequestOutputs(events, request, nextRequestSequence, expectedTypes, expectedText) {
  const outputs = requestOutputs(events, request, nextRequestSequence);
  assert.deepEqual(outputs.map((event) => event.type), expectedTypes);
  assert.equal(new Set(outputs.map((event) => event.id)).size, outputs.length);
  assert.equal(outputs.at(-1)?.payload?.text, expectedText);
  assert.equal(events.filter((event) => event.type === "agent_response" && event.payload?.text === expectedText).length, 1);
  return outputs;
}

function parseAudit(raw) {
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertAbsent(label, text, forbidden) {
  for (const value of forbidden) {
    assert.equal(text.includes(value), false, `${label} leaked forbidden fixture value ${value.slice(0, 24)}`);
  }
}

async function main() {
  await verifyPinnedDsh();
  const createdRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-real-loader-"));
  const root = await realpath(createdRoot);
  await chmod(root, 0o700);
  const home = path.join(root, "dsh-home");
  const workspace = path.join(root, "workspace");
  const stateDirectory = path.join(root, "connector-state");
  const runtimeTemp = path.join(root, "runtime-tmp");
  const statePath = path.join(stateDirectory, "connector.json");
  const auditPath = path.join(root, "public-session-events.jsonl");
  const witnessPatch = path.join(root, "witness.cordis.patch.yml");
  await Promise.all([home, workspace, stateDirectory, runtimeTemp].map(async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }));
  await writeFile(
    witnessPatch,
    [
      "- id: session-title-llm",
      "  disabled: true",
      "",
      "- insert:",
      "    - id: gatherthread-dsh-integration-witness",
      `      name: ${JSON.stringify(pathToFileURL(witnessPlugin).href)}`,
      "      inject: [tools]",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const mockKey = `mock-key-${randomBytes(18).toString("base64url")}`;
  const toolSecret = `fixture-secret-${randomBytes(18).toString("base64url")}`;
  const privateMarkers = [
    "PRIVATE_REASONING_ONE",
    "PRIVATE_REASONING_TWO",
    "PRIVATE_REASONING_THREE",
    "PRIVATE_REASONING_RECOVERY",
  ];
  let running;
  let proxy;
  let mock;
  const hosts = [];
  try {
    await initializeProfile(home, runtimeTemp);
    running = await startCollaborationServer({
      databasePath: path.join(root, "gatherthread.sqlite"),
      authTokenPepper: `test-pepper-${randomBytes(18).toString("base64url")}`,
      allowHttpBootstrap: true,
    }, 0);
    const owner = await requestData(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: {
        user_id: "dsh-real-loader-owner",
        display_name: "DSH Owner",
        device_id: DEVICE_ID,
        device_name: "Ephemeral DSH device",
      },
    });
    await requestData(running.origin, "/v1/projects", {
      method: "POST",
      token: owner.token,
      body: { project_id: PROJECT_ID, idempotency_key: "create-dsh-real-project", title: "DSH real loader" },
    });
    await requestData(running.origin, `/v1/projects/${PROJECT_ID}/sessions`, {
      method: "POST",
      token: owner.token,
      body: { session_id: SESSION_ID, idempotency_key: "create-dsh-real-session", mode: "multi", title: "DSH gate" },
    });
    const invitation = await requestData(running.origin, `/v1/projects/${PROJECT_ID}/invitations`, {
      method: "POST",
      token: owner.token,
      body: { role: "participant", ttl: "1h" },
    });
    const collaborator = await requestData(running.origin, "/v1/invitations/claim", {
      method: "POST",
      body: {
        invite_token: invitation.invite_token,
        user_id: "dsh-real-loader-collaborator",
        display_name: "DSH Collaborator",
        device_id: "dsh-real-loader-collaborator-device",
        device_name: "Ephemeral collaborator device",
      },
    });

    proxy = await startForwardProxy(running.origin);
    mock = await startMockLlm(mockKey, toolSecret);
    const ownerApi = new HttpCollaborationClient({ baseUrl: `${running.origin}/v1`, bearerToken: owner.token });
    const collaboratorApi = new HttpCollaborationClient({ baseUrl: `${running.origin}/v1`, bearerToken: collaborator.token });
    const secrets = [owner.token, collaborator.token, mockKey, toolSecret];

    await collaboratorApi.appendEvent(SESSION_ID, {
      type: "human_chat",
      idempotencyKey: "collaborator-update-one",
      payload: { content: "collaborator-update-one" },
    });
    const requestOne = await ownerApi.appendEvent(SESSION_ID, {
      type: "agent_request",
      idempotencyKey: "gate-one-request-one",
      payload: {
        content: "gate-one-request-one",
        execution_profile: { harness: "deepseek-harness", model: MODEL },
      },
    });

    const firstHost = startHost({
      home, runtimeTemp, workspace, statePath, auditPath, proxyOrigin: proxy.origin,
      llmOrigin: mock.origin, ownerToken: owner.token, mockKey, toolSecret,
      phase: "initial", witnessPatch,
    });
    hosts.push(firstHost);
    await waitUntil("initial runtime registration", () => proxy.registrations.length >= 1 ? proxy.registrations[0] : undefined, [firstHost], secrets);
    let firstResult;
    try {
      firstResult = await waitForFinal(ownerApi, requestOne.id, "gate-one-final-one", [firstHost], secrets);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : "initial final failed"}\n${await gateDiagnostics(mock, auditPath, statePath)}`);
    }

    await collaboratorApi.appendEvent(SESSION_ID, {
      type: "human_chat",
      idempotencyKey: "collaborator-update-two",
      payload: { content: "collaborator-update-two" },
    });
    const blocker = proxy.blockNextPublication();
    const requestTwo = await ownerApi.appendEvent(SESSION_ID, {
      type: "agent_request",
      idempotencyKey: "gate-one-request-two",
      payload: {
        content: "gate-one-request-two",
        execution_profile: { harness: "deepseek-harness", model: MODEL },
      },
    });
    await withTimeout(blocker.arrived, "blocked request-two outbox publication");
    firstHost.child.kill("SIGTERM");
    await withTimeout(blocker.aborted, "outbox HTTP abort during Cordis unload", 20_000);
    const firstExit = await withTimeout(firstHost.exit, "first Host unload", 20_000);
    assert.equal(firstExit.code, 0);
    const stateAfterUnloadRaw = await readFile(statePath, "utf8");
    const stateAfterUnload = JSON.parse(stateAfterUnloadRaw);
    assert.equal(stateAfterUnload.activeRequest.requestId, requestTwo.id);
    assert.ok(Number.isSafeInteger(stateAfterUnload.activeRequest.dshToSequence));
    assert.ok(stateAfterUnload.outbox.length > 0);
    const eventCountAtUnload = (await readAllEvents(ownerApi)).length;
    await delay(300);
    assert.equal((await readAllEvents(ownerApi)).length, eventCountAtUnload, "unloaded Host published a late event");

    const outboxHost = startHost({
      home, runtimeTemp, workspace, statePath, auditPath, proxyOrigin: proxy.origin,
      llmOrigin: mock.origin, ownerToken: owner.token, mockKey, toolSecret,
      phase: "outbox-reload", witnessPatch,
    });
    hosts.push(outboxHost);
    await waitUntil("second runtime registration", () => proxy.registrations.length >= 2 ? proxy.registrations[1] : undefined, [outboxHost], secrets);
    let secondResult;
    try {
      secondResult = await waitForFinal(ownerApi, requestTwo.id, "gate-one-final-two", [outboxHost], secrets);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : "outbox reload final failed"}\n${await gateDiagnostics(mock, auditPath, statePath)}`);
    }
    assert.equal(proxy.registrations[1], proxy.registrations[0], "runtime identity changed after outbox reload");
    const stateAfterOutbox = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(stateAfterOutbox.activeRequest, undefined);
    assert.deepEqual(stateAfterOutbox.outbox, []);
    assert.ok(stateAfterOutbox.serverCursor >= requestTwo.sequence);

    await collaboratorApi.appendEvent(SESSION_ID, {
      type: "human_chat",
      idempotencyKey: "collaborator-update-three",
      payload: { content: "collaborator-update-three" },
    });
    const requestThree = await ownerApi.appendEvent(SESSION_ID, {
      type: "agent_request",
      idempotencyKey: "gate-one-request-three",
      payload: {
        content: "gate-one-request-three",
        execution_profile: { harness: "deepseek-harness", model: MODEL },
      },
    });
    await withTimeout(mock.requestThreeStarted, "third request private stream");
    const killed = await killHost(outboxHost);
    const stateAfterCrashRaw = await readFile(statePath, "utf8");
    const stateAfterCrash = JSON.parse(stateAfterCrashRaw);
    assert.equal(stateAfterCrash.activeRequest.requestId, requestThree.id);
    assert.equal(stateAfterCrash.activeRequest.dshToSequence, undefined);
    assert.deepEqual(stateAfterCrash.outbox, []);

    const recoveryHost = startHost({
      home, runtimeTemp, workspace, statePath, auditPath, proxyOrigin: proxy.origin,
      llmOrigin: mock.origin, ownerToken: owner.token, mockKey, toolSecret,
      phase: "crash-reload", witnessPatch,
    });
    hosts.push(recoveryHost);
    await waitUntil("third runtime registration", () => proxy.registrations.length >= 3 ? proxy.registrations[2] : undefined, [recoveryHost], secrets);
    const thirdResult = await waitForFinal(ownerApi, requestThree.id, "gate-one-final-three", [recoveryHost], secrets);
    assert.deepEqual(proxy.registrations, [proxy.registrations[0], proxy.registrations[0], proxy.registrations[0]]);
    const recoveryExit = await stopHost(recoveryHost);
    assert.equal(recoveryExit.code, 0);

    const events = thirdResult.events;
    assertRequestOutputs(
      events,
      requestOne,
      requestTwo.sequence,
      ["agent_progress", "agent_progress", "tool_call", "tool_result", "agent_response"],
      "gate-one-final-one",
    );
    assertRequestOutputs(
      events,
      requestTwo,
      requestThree.sequence,
      ["agent_progress", "agent_progress", "agent_response"],
      "gate-one-final-two",
    );
    assertRequestOutputs(
      events,
      requestThree,
      Number.POSITIVE_INFINITY,
      ["agent_progress", "agent_progress", "agent_response"],
      "gate-one-final-three",
    );
    assert.deepEqual(mock.records.map((record) => record.kind), [
      "tool-call",
      "tool-followup",
      "request-two",
      "request-three",
      "recovery",
    ]);
    const firstPrompt = mock.records.find((record) => record.kind === "tool-call")?.canonicalPrompt ?? "";
    const secondPrompt = mock.records.find((record) => record.kind === "request-two")?.canonicalPrompt ?? "";
    const thirdPrompt = mock.records.find((record) => record.kind === "request-three")?.canonicalPrompt ?? "";
    assert.match(firstPrompt, /collaborator-update-one/);
    assert.match(secondPrompt, /collaborator-update-two/);
    assert.doesNotMatch(secondPrompt, /gate-one-final-one|DeepSeek Harness started processing|gatherthread_redaction_fixture/);
    assert.match(thirdPrompt, /collaborator-update-three/);
    assert.doesNotMatch(thirdPrompt, /gate-one-final-two|DeepSeek Harness started processing/);

    const auditRaw = await readFile(auditPath, "utf8");
    const audit = parseAudit(auditRaw);
    const eventAudit = audit.filter((record) => record.kind === "session-event");
    const eventKeys = eventAudit.map((record) => `${record.sessionId}:${record.type}:${record.seq}`);
    assert.equal(new Set(eventKeys).size, eventKeys.length, "DSH emitted a duplicate durable SessionEvent notification");
    const liveRepairSettlements = eventAudit.filter((record) =>
      record.type === "turn/end" && record.settlement === "interrupted",
    ).length;
    assert.equal(
      mock.records.filter((record) => record.kind === "recovery").length,
      1,
      "connector must observe the durable interrupted repair and issue exactly one continuation",
    );
    assert.ok(eventAudit.some((record) => record.type === "request/header" && record.publicProjection === undefined));
    assert.ok(eventAudit.some((record) => record.type === "tool/call" && record.publicProjection?.kind === "tool_call"));
    assert.ok(eventAudit.some((record) => record.type === "tool/result" && record.publicProjection?.kind === "tool_result"));
    assert.equal(audit.filter((record) => record.kind === "disposed" && record.phase === "initial").length, 1);
    assert.equal(audit.filter((record) => record.kind === "disposed" && record.phase === "crash-reload").length, 1);

    const finalStateRaw = await readFile(statePath, "utf8");
    const finalState = JSON.parse(finalStateRaw);
    assert.equal(finalState.activeRequest, undefined);
    assert.deepEqual(finalState.outbox, []);
    assert.ok(finalState.serverCursor >= requestThree.sequence);
    assert.equal(finalState.binding.dshSessionId, deriveDshSessionId(PROJECT_ID, SESSION_ID, workspace));
    if (process.platform !== "win32") {
      assert.equal((await lstat(stateDirectory)).mode & 0o777, 0o700);
      assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
    }

    const publicArtifacts = JSON.stringify({ events, audit });
    const processLogs = hosts.map((host) => `${host.stdout}\n${host.stderr}`).join("\n");
    const connectorStates = [stateAfterUnloadRaw, stateAfterCrashRaw, finalStateRaw].join("\n");
    const forbidden = [...secrets, ...privateMarkers, "partial-before-sigkill"];
    assertAbsent("canonical/public SessionEvent projection", publicArtifacts, forbidden);
    assertAbsent("connector state", connectorStates, forbidden);
    assertAbsent("DSH Host logs", processLogs, forbidden);
    assert.match(publicArtifacts, /\[REDACTED\]/);
    assert.equal(proxy.errors.length, 0, proxy.errors[0]?.message);

    console.log(JSON.stringify({
      passed: true,
      dsh: DSH_COMPATIBILITY,
      hostPhases: ["initial", "outbox-reload", "crash-reload"],
      runtimeIdentityStable: true,
      requestOutputTypes: {
        one: requestOutputs(events, requestOne, requestTwo.sequence).map((event) => event.type),
        two: requestOutputs(events, requestTwo, requestThree.sequence).map((event) => event.type),
        three: requestOutputs(events, requestThree).map((event) => event.type),
      },
      officialRepair: {
        durableContinuationCount: mock.records.filter((record) => record.kind === "recovery").length,
        liveRepairRebroadcastCount: liveRepairSettlements,
      },
      killed,
      credentialMode: "ephemeral fixture values in process environment only",
      privatePersistenceRead: false,
    }, null, 2));
  } finally {
    for (const host of hosts) {
      if (host.child.exitCode === null && host.child.signalCode === null) {
        host.child.kill("SIGKILL");
        await withTimeout(host.exit.catch(() => undefined), "cleanup Host exit", 5_000).catch(() => undefined);
      }
    }
    await mock?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    await running?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
