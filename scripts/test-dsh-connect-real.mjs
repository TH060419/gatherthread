#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startCollaborationServer } from "../apps/server/dist/src/server.js";
import {
  DSH_COMPATIBILITY,
  DSH_CONNECTION_MANIFEST,
  DSH_CONNECTION_PATCH,
  DSH_STATUS_PATH,
} from "../packages/dsh-host/dist/src/index.js";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, "packages/dsh-host");
const CONNECT_CLI = path.join(PACKAGE_ROOT, "dist/src/connect-cli.js");
const LOADER_CONTROL = path.join(PACKAGE_ROOT, "integration/loader-control/index.mjs");
const DSH_SOURCE_VALUE = process.env.GATHERTHREAD_DSH_SOURCE?.trim();
const TIMEOUT_MS = 90_000;
const OUTPUT_LIMIT = 1_000_000;
const PROJECT_ID = "dsh-connect-real-project";
const SESSION_ID = "dsh-connect-real-session";
const DEVICE_ID = "dsh-connect-real-device";
const PROJECT_NAME = "DSH Connect Gate";
const SESSION_NAME = "DSH UI Gate";
const PROVIDER = "deepseek-official";
const MODEL = "deepseek-v4-flash";

if (!DSH_SOURCE_VALUE || !path.isAbsolute(DSH_SOURCE_VALUE)) {
  throw new Error(
    "GATHERTHREAD_DSH_SOURCE must name an absolute, already-installed checkout of the pinned DeepSeek Harness commit",
  );
}

const DSH_SOURCE = await realpath(path.resolve(DSH_SOURCE_VALUE));

function withTimeout(promise, label, milliseconds = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      timer.unref?.();
    }),
  ]);
}

function appendBounded(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

function redact(text, secrets) {
  let result = text.replace(/([?&]token=)[^\s)]+/gu, "$1[DSH-LAUNCH-REDACTED]");
  for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

async function runProcess(command, args, options, secrets = []) {
  assert.equal(args.some((argument) => secrets.includes(argument)), false, "credential appeared as a process argument");
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  const result = await withTimeout(new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }), path.basename(command));
  return { ...result, stdout, stderr };
}

async function verifyPinnedDsh() {
  await Promise.all([
    access(path.join(DSH_SOURCE, "apps/cli/src/bin.ts")),
    access(path.join(DSH_SOURCE, "apps/web/dist/index.html")),
    access(path.join(DSH_SOURCE, "node_modules/tsx")),
    access(CONNECT_CLI),
    access(path.join(PACKAGE_ROOT, "dist/src/plugin.js")),
    access(path.join(PACKAGE_ROOT, "client/client.js")),
    access(LOADER_CONTROL),
  ]);
  const manifest = JSON.parse(await readFile(path.join(DSH_SOURCE, "apps/cli/package.json"), "utf8"));
  assert.equal(manifest.version, DSH_COMPATIBILITY.version, "DSH CLI version drifted");
  const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: DSH_SOURCE, env: process.env });
  assert.equal(head.code, 0, head.stderr);
  assert.equal(head.stdout.trim(), DSH_COMPATIBILITY.commit, "DSH checkout commit drifted");
  const tags = await runProcess("git", ["tag", "--points-at", "HEAD"], { cwd: DSH_SOURCE, env: process.env });
  assert.equal(tags.code, 0, tags.stderr);
  assert.ok(tags.stdout.split(/\r?\n/u).includes(DSH_COMPATIBILITY.tag), "pinned DSH tag is absent");
  const status = await runProcess(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: DSH_SOURCE, env: process.env },
  );
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stdout, "", "pinned DSH checkout has tracked modifications");
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
  assert.ok(response.ok, `${options.method ?? "GET"} ${pathname} failed with ${response.status}`);
  return payload?.data;
}

async function startMockLlm() {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "fixture_no_model_calls", message: "No model call expected" } }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function cleanEnvironment(root, dshHome, values = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)));
  return {
    ...environment,
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: path.join(root, "runtime-tmp"),
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: path.join(root, "agents-home"),
    DSH_PERMISSION_MODE: "read-only",
    DSH_TELEMETRY_MODE: "DISABLED",
    DSH_TELEMETRY_DISABLED: "1",
    NODE_NO_WARNINGS: "1",
    NO_COLOR: "1",
    ...values,
  };
}

async function runConnect(args, environment, secrets) {
  const result = await runProcess(process.execPath, [CONNECT_CLI, ...args], {
    cwd: REPOSITORY_ROOT,
    env: environment,
  }, secrets);
  if (result.code !== 0) {
    throw new Error(`GatherThread DSH CLI failed (${String(result.code)}):\n${redact(`${result.stdout}\n${result.stderr}`, secrets)}`);
  }
  return result;
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function startWebHost(args, environment, secrets) {
  assert.equal(args.some((argument) => secrets.includes(argument)), false, "credential appeared as a process argument");
  const child = spawn(process.execPath, [CONNECT_CLI, ...args], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const host = { child, stdout: "", stderr: "", launchUrl: undefined };
  let readyResolve;
  let readyReject;
  host.ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const append = (target, chunk) => {
    host[target] = appendBounded(host[target], chunk);
    const output = `${host.stdout}\n${host.stderr}`;
    const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output);
    if (host.launchUrl === undefined && match?.[1] !== undefined) {
      host.launchUrl = match[1];
      readyResolve(match[1]);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  host.exit = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      readyReject(error);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (host.launchUrl === undefined) {
        readyReject(new Error(`DSH exited before readiness (${String(code)}, ${String(signal)})`));
      }
      resolve({ code, signal });
    });
  });
  return host;
}

async function stopWebHost(host) {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGTERM");
  return withTimeout(host.exit, "DSH web shutdown", 20_000);
}

function rawHttp({ port, pathname, method = "GET", host, cookie, origin, secFetchSite }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host,
        ...(cookie === undefined ? {} : { cookie }),
        ...(origin === undefined ? {} : { origin }),
        ...(secFetchSite === undefined ? {} : { "sec-fetch-site": secFetchSite }),
        ...(method === "POST" ? { "content-length": "0" } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function loadPlaywright() {
  const sourceRequire = createRequire(path.join(DSH_SOURCE, "apps/web/package.json"));
  const modulePath = sourceRequire.resolve("playwright");
  const imported = await import(pathToFileURL(modulePath).href);
  return imported.default ?? imported;
}

async function dismissEphemeralOnboarding(page) {
  const labels = ["继续", "Continue", "稍后配置", "Configure later"];
  // Both onboarding steps resolve through Host-backed settings joins after the
  // document load event, so allow that public UI state to settle first.
  await page.waitForTimeout(1_000);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let clicked = false;
    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.count() > 0 && await button.first().isVisible()) {
        await button.first().click();
        clicked = true;
        break;
      }
    }
    if (!clicked) return;
    await page.waitForTimeout(500);
  }
  assert.equal(
    await page.getByRole("button", { name: /^(继续|Continue|稍后配置|Configure later)$/u }).count(),
    0,
    "temporary DSH onboarding did not settle",
  );
}

async function waitForStatus(port, host, cookie, origin, expected = 200) {
  const deadline = Date.now() + 30_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await rawHttp({ port, pathname: DSH_STATUS_PATH, host, cookie, origin, secFetchSite: "same-origin" });
    if (latest.status === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`status route never reached ${String(expected)}; last status ${String(latest?.status)}`);
}

async function collectManagedText(root) {
  const parts = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("managed DSH fixture unexpectedly contains a symbolic link");
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && (await lstat(target)).size <= OUTPUT_LIMIT) parts.push(await readFile(target, "utf8"));
    }
  }
  await visit(root);
  return parts.join("\n");
}

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value), expected, `${label} field allowlist drifted`);
}

function assertAbsent(label, text, values) {
  for (const value of values) assert.equal(text.includes(value), false, `${label} leaked a fixture credential or private value`);
}

async function main() {
  await verifyPinnedDsh();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-connect-real-")));
  await chmod(root, 0o700);
  const dshHome = path.join(root, "dsh-home");
  const workspace = path.join(root, "workspace");
  for (const directory of [workspace, path.join(root, "runtime-tmp"), path.join(root, "agents-home")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const ownerPepper = `fixture-pepper-${randomBytes(18).toString("base64url")}`;
  const mockKey = `fixture-model-key-${randomBytes(18).toString("base64url")}`;
  let collaboration;
  let mockLlm;
  let host;
  let browser;
  try {
    collaboration = await startCollaborationServer({
      databasePath: path.join(root, "gatherthread.sqlite"),
      authTokenPepper: ownerPepper,
      allowHttpBootstrap: true,
    }, 0);
    const owner = await requestData(collaboration.origin, "/v1/bootstrap", {
      method: "POST",
      body: {
        user_id: "dsh-connect-real-owner",
        display_name: "DSH Connect Owner",
        device_id: DEVICE_ID,
        device_name: "Ephemeral DSH connect device",
      },
    });
    await requestData(collaboration.origin, "/v1/projects", {
      method: "POST",
      token: owner.token,
      body: { project_id: PROJECT_ID, idempotency_key: "create-dsh-connect-project", title: PROJECT_NAME },
    });
    await requestData(collaboration.origin, `/v1/projects/${PROJECT_ID}/sessions`, {
      method: "POST",
      token: owner.token,
      body: { session_id: SESSION_ID, idempotency_key: "create-dsh-connect-session", mode: "multi", title: SESSION_NAME },
    });
    mockLlm = await startMockLlm();
    const secrets = [owner.token, ownerPepper, mockKey];
    const baseEnvironment = cleanEnvironment(root, dshHome, {
      GATHERTHREAD_TOKEN: owner.token,
      DEEPSEEK_API_KEY: mockKey,
      DEEPSEEK_BASE_URL: mockLlm.origin,
    });
    const common = [
      "--dsh-source", DSH_SOURCE,
      "--dsh-home", dshHome,
      "--url", `${collaboration.origin}/v1`,
      "--project", PROJECT_ID,
      "--workspace", workspace,
      "--provider", PROVIDER,
      "--model", MODEL,
    ];

    const plan = await runConnect([
      "plan",
      "--dsh-source", DSH_SOURCE,
      "--dsh-home", dshHome,
      "--url", `${collaboration.origin}/v1`,
      "--project", PROJECT_ID,
      "--project-name", PROJECT_NAME,
      "--device", DEVICE_ID,
      "--workspace", workspace,
      "--provider", PROVIDER,
      "--model", MODEL,
    ], cleanEnvironment(root, dshHome), secrets);
    assert.match(plan.stdout, new RegExp(DSH_COMPATIBILITY.commit));
    assert.match(plan.stdout, /will be initialized by the official CLI/);
    assertAbsent("plan output", `${plan.stdout}\n${plan.stderr}`, secrets);

    const installed = await runConnect(["install", ...common], baseEnvironment, secrets);
    const idMatch = /connection ([a-f0-9]{24}): installed/u.exec(installed.stdout);
    assert.ok(idMatch?.[1], `install output omitted the connection identity: ${installed.stdout}`);
    const connectionId = idMatch[1];
    const profileDirectory = path.join(dshHome, "profiles", "web");
    for (const file of ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
      await access(path.join(profileDirectory, file));
    }
    const connectionDirectory = path.join(dshHome, "gatherthread", "connections", connectionId);
    const manifestPath = path.join(connectionDirectory, DSH_CONNECTION_MANIFEST);
    const patchPath = path.join(connectionDirectory, DSH_CONNECTION_PATCH);
    if (process.platform !== "win32") {
      assert.equal((await lstat(connectionDirectory)).mode & 0o777, 0o700);
      assert.equal((await lstat(manifestPath)).mode & 0o777, 0o600);
      assert.equal((await lstat(patchPath)).mode & 0o777, 0o600);
    }
    const managedAtInstall = await collectManagedText(path.join(dshHome, "gatherthread"));
    assertAbsent("installed connection artifact", managedAtInstall, secrets);
    assert.doesNotMatch(managedAtInstall, /authorization|bearer /iu);

    const status = await runConnect(
      ["status", "--dsh-home", dshHome, "--connection", connectionId],
      cleanEnvironment(root, dshHome),
      secrets,
    );
    assert.match(status.stdout, /: installed/);
    assert.match(status.stdout, /Credential persisted: no/);
    assertAbsent("status output", `${status.stdout}\n${status.stderr}`, secrets);

    const profilePatchPath = path.join(profileDirectory, "cordis.patch.yml");
    await writeFile(profilePatchPath, [
      "# Test-only real Loader unload witness; never installed by GatherThread.",
      "- insert:",
      "    - id: gatherthread-dsh-loader-control-fixture",
      `      name: ${JSON.stringify(pathToFileURL(LOADER_CONTROL).href)}`,
      "      inject: [loader, connection, clientModules]",
      "      config:",
      `        targetId: ${JSON.stringify(`gatherthread-dsh-${connectionId}`)}`,
      "",
    ].join("\n"), "utf8");
    const profilePatchWithControl = await readFile(profilePatchPath, "utf8");

    const port = await freePort();
    host = startWebHost([
      "start",
      "--dsh-source", DSH_SOURCE,
      "--dsh-home", dshHome,
      "--connection", connectionId,
      "--port", String(port),
    ], baseEnvironment, secrets);
    let launchUrl;
    try {
      launchUrl = await withTimeout(host.ready, "pinned DSH web readiness");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${redact(`${host.stdout}\n${host.stderr}`, secrets)}`,
      );
    }
    const parsedLaunchUrl = new URL(launchUrl);
    assert.equal(parsedLaunchUrl.origin, `http://127.0.0.1:${String(port)}`);
    assert.match(parsedLaunchUrl.searchParams.get("token") ?? "", /^[A-Za-z0-9_-]{43}$/u);

    const unauthenticated = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      host: parsedLaunchUrl.host,
    });
    assert.equal(unauthenticated.status, 401, "real DSH /api carrier must reject a missing browser Cookie");
    assert.equal(unauthenticated.body, "unauthorized");

    const exchange = await fetch(launchUrl, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get("location"), "/");
    const setCookie = exchange.headers.get("set-cookie");
    assert.ok(setCookie?.includes("HttpOnly"));
    assert.ok(setCookie?.includes("SameSite=Strict"));
    const cookie = setCookie.split(";", 1)[0];

    const wrongOrigin = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      host: parsedLaunchUrl.host,
      cookie,
      origin: "http://evil.example",
      secFetchSite: "cross-site",
    });
    assert.equal(wrongOrigin.status, 403, "real DSH /api carrier must reject a foreign Origin");
    assert.equal(wrongOrigin.body, "forbidden");

    const wrongHost = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      host: `evil.example:${String(port)}`,
      cookie,
      origin: `http://evil.example:${String(port)}`,
      secFetchSite: "same-origin",
    });
    assert.equal(wrongHost.status, 403, "real DSH /api carrier must reject a foreign Host");

    const publicStatusResponse = await waitForStatus(
      port,
      parsedLaunchUrl.host,
      cookie,
      parsedLaunchUrl.origin,
    );
    assert.equal(publicStatusResponse.headers["cache-control"], "no-store");
    assert.equal(publicStatusResponse.headers["content-security-policy"], "default-src 'none'");
    const publicStatus = JSON.parse(publicStatusResponse.body);
    exactKeys(publicStatus, [
      "schemaVersion", "integration", "connection", "bindingMode", "projectName",
      "activeSessionCount", "sessions", "updatedAt",
    ], "public status");
    assert.equal(publicStatus.integration, "gatherthread");
    assert.equal(publicStatus.bindingMode, "project");
    assert.equal(publicStatus.projectName, PROJECT_NAME);
    assert.equal(publicStatus.sessions.length, 1);
    exactKeys(publicStatus.sessions[0], ["sessionId", "title", "state", "lastSyncedAt"], "public Session status");
    assert.deepEqual(
      { sessionId: publicStatus.sessions[0].sessionId, title: publicStatus.sessions[0].title },
      { sessionId: SESSION_ID, title: SESSION_NAME },
    );
    assert.ok(publicStatusResponse.body.length < 64 * 1024);
    assertAbsent("public status", publicStatusResponse.body, [...secrets, DSH_SOURCE, dshHome, workspace]);
    assert.doesNotMatch(publicStatusResponse.body, /authorization|headers|stack|stateRoot|workspacePath/iu);

    const head = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      method: "HEAD",
      host: parsedLaunchUrl.host,
      cookie,
      origin: parsedLaunchUrl.origin,
      secFetchSite: "same-origin",
    });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const mutatingStatus = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      method: "POST",
      host: parsedLaunchUrl.host,
      cookie,
      origin: parsedLaunchUrl.origin,
      secFetchSite: "same-origin",
    });
    assert.equal(mutatingStatus.status >= 400, true, "status endpoint must reject mutating methods");

    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
    const statusRequests = [];
    const pluginRequests = [];
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.pathname === DSH_STATUS_PATH) {
        statusRequests.push({
          url: request.url(),
          headers: request.headers(),
          method: request.method(),
          observedAt: Date.now(),
        });
      }
      if (requestUrl.pathname.startsWith("/plugins/") && request.url().includes("@gatherthread/dsh-host")) {
        pluginRequests.push(request.url());
      }
    });
    await page.goto(launchUrl, { waitUntil: "load" });
    assert.equal(new URL(page.url()).searchParams.has("token"), false, "browser must leave the DSH launch-token URL");
    await dismissEphemeralOnboarding(page);
    const settings = page.getByRole("button", { name: "设置", exact: true });
    await settings.waitFor({ timeout: 30_000 });
    await settings.click();
    const section = page.getByRole("button", { name: "GatherThread / 共序", exact: true });
    await section.waitFor({ timeout: 30_000 });
    await section.click();
    const panel = page.locator("[data-gatherthread-status]");
    await panel.waitFor({ timeout: 30_000 });
    await page.getByText(PROJECT_NAME, { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByText(SESSION_NAME, { exact: true }).waitFor({ timeout: 30_000 });
    const panelText = await panel.textContent() ?? "";
    assertAbsent("Client Slot DOM", panelText, [...secrets, DSH_SOURCE, dshHome, workspace]);
    assert.ok(statusRequests.length >= 1, "real Client bundle did not read the Host status contract");
    assert.equal(statusRequests.every((request) => (
      request.method === "GET"
        && new URL(request.url).origin === parsedLaunchUrl.origin
        && request.headers.authorization === undefined
    )), true, "Client status reads must be same-origin and carry no Authorization header");

    // Client lifecycle is independent from the Host Loader entry. Exercise
    // the fixed DSH public clientModules -> SSE HMR -> Client fiber refresh
    // chain and prove the old React surface is disposed before one replacement
    // registers. No package bytes or upstream files are changed.
    const oldPanel = await panel.elementHandle();
    assert.ok(oldPanel, "initial GatherThread Client panel has no DOM handle");
    const clientRequestsBeforeHmr = pluginRequests.length;
    const clientReload = await withTimeout(rawHttp({
      port,
      pathname: "/api/gatherthread.test-client-reload",
      method: "POST",
      host: parsedLaunchUrl.host,
      cookie,
      origin: parsedLaunchUrl.origin,
      secFetchSite: "same-origin",
    }), "real Client HMR", 20_000);
    assert.equal(clientReload.status, 200, clientReload.body);
    assert.equal(JSON.parse(clientReload.body).ok, true);
    await page.waitForFunction((element) => !element.isConnected, oldPanel, { timeout: 30_000 });
    await panel.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(SESSION_NAME, { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await section.count(), 1, "Client HMR registered more than one GatherThread Slot");
    assert.ok(pluginRequests.length > clientRequestsBeforeHmr, "Client HMR did not load a revised bundle");
    await page.waitForTimeout(250);
    const cadenceStart = Date.now();
    await page.waitForTimeout(4_500);
    const hmrPolls = statusRequests.filter((request) => request.observedAt >= cadenceStart);
    assert.ok(hmrPolls.length >= 2 && hmrPolls.length <= 3, "Client HMR leaked a duplicate polling loop");
    for (let index = 1; index < hmrPolls.length; index += 1) {
      assert.ok(
        hmrPolls[index].observedAt - hmrPolls[index - 1].observedAt >= 1_500,
        "Client HMR retained overlapping status timers",
      );
    }

    // Host lifecycle: removing the Loader entry must revoke the route. The
    // already-booted Client graph is deliberately not conflated with it.
    const unload = await withTimeout(rawHttp({
      port,
      pathname: "/api/gatherthread.test-unload",
      method: "POST",
      host: parsedLaunchUrl.host,
      cookie,
      origin: parsedLaunchUrl.origin,
      secFetchSite: "same-origin",
    }), "real Loader unload", 20_000);
    assert.equal(unload.status, 200, unload.body);
    const unloadEvidence = JSON.parse(unload.body);
    assert.equal(unloadEvidence.ok, true);
    assert.equal(unloadEvidence.active, 0, `Loader entry remained active after disable: ${unload.body}`);
    let afterUnload;
    try {
      afterUnload = await waitForStatus(
        port,
        parsedLaunchUrl.host,
        cookie,
        parsedLaunchUrl.origin,
        404,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; unload=${unload.body}\n${redact(`${host.stdout}\n${host.stderr}`, secrets)}`,
      );
    }
    assert.equal(afterUnload.body, "not found");
    await page.getByRole("status").filter({ hasText: "状态暂不可用" }).waitFor({ timeout: 10_000 });
    const unavailablePanelText = await panel.textContent() ?? "";
    assert.doesNotMatch(unavailablePanelText, new RegExp(`${PROJECT_NAME}|${SESSION_NAME}`, "u"));
    assertAbsent("unavailable Client panel", unavailablePanelText, [...secrets, DSH_SOURCE, dshHome, workspace]);
    const readsAfterPermanentFailure = statusRequests.length;
    await page.waitForTimeout(2_500);
    assert.equal(
      statusRequests.length,
      readsAfterPermanentFailure,
      "Client kept polling after the Host route returned a permanent 404",
    );

    // A fresh page consumes the Host's recomposed graph, where the removed
    // package no longer exists. This is the pinned DSH graph startup boundary.
    await page.reload({ waitUntil: "load" });
    await dismissEphemeralOnboarding(page);
    await page.getByRole("button", { name: "设置", exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole("button", { name: "GatherThread / 共序", exact: true }).count(), 0);

    const reload = await withTimeout(rawHttp({
      port,
      pathname: "/api/gatherthread.test-reload",
      method: "POST",
      host: parsedLaunchUrl.host,
      cookie,
      origin: parsedLaunchUrl.origin,
      secFetchSite: "same-origin",
    }), "real Loader reload", 20_000);
    assert.equal(reload.status, 200, reload.body);
    assert.deepEqual(JSON.parse(reload.body), { ok: true, active: 1 });
    await waitForStatus(port, parsedLaunchUrl.host, cookie, parsedLaunchUrl.origin, 200);
    const unauthenticatedAfterReload = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      host: parsedLaunchUrl.host,
    });
    assert.equal(unauthenticatedAfterReload.status, 401);
    const wrongOriginAfterReload = await rawHttp({
      port,
      pathname: DSH_STATUS_PATH,
      host: parsedLaunchUrl.host,
      cookie,
      origin: "http://evil.example",
      secFetchSite: "cross-site",
    });
    assert.equal(wrongOriginAfterReload.status, 403);

    await page.reload({ waitUntil: "load" });
    await dismissEphemeralOnboarding(page);
    const reloadedSettings = page.getByRole("button", { name: "设置", exact: true });
    await reloadedSettings.waitFor({ timeout: 30_000 });
    await reloadedSettings.click();
    const reloadedSection = page.getByRole("button", { name: "GatherThread / 共序", exact: true });
    await reloadedSection.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await reloadedSection.count(), 1, "reloaded Client Slot registered more than once");
    await reloadedSection.click();
    const reloadedPanel = page.locator("[data-gatherthread-status]");
    await reloadedPanel.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(SESSION_NAME, { exact: true }).waitFor({ timeout: 30_000 });
    const readsBeforeReloadedPanel = statusRequests.length;
    await page.waitForTimeout(2_500);
    assert.ok(statusRequests.length > readsBeforeReloadedPanel, "reloaded Client Slot did not resume status reads");

    const finalHostLogs = `${host.stdout}\n${host.stderr}`;
    const hostExit = await stopWebHost(host);
    assert.equal(hostExit.code, 0, redact(finalHostLogs, secrets));
    host = undefined;
    await browser.close();
    browser = undefined;

    const safeEnvironment = cleanEnvironment(root, dshHome);
    const removed = await runConnect(
      ["remove", "--dsh-home", dshHome, "--connection", connectionId],
      safeEnvironment,
      secrets,
    );
    assert.match(removed.stdout, /: removed/);
    const removedStatus = await runConnect(
      ["status", "--dsh-home", dshHome, "--connection", connectionId],
      safeEnvironment,
      secrets,
    );
    assert.match(removedStatus.stdout, /: removed/);
    const restored = await runConnect(
      ["restore", "--dsh-home", dshHome, "--connection", connectionId],
      safeEnvironment,
      secrets,
    );
    assert.match(restored.stdout, /: restored/);

    const installedAgain = await runConnect(["install", ...common], baseEnvironment, secrets);
    assert.match(installedAgain.stdout, /: already installed/);
    assert.equal(await readFile(profilePatchPath, "utf8"), profilePatchWithControl, "idempotent install changed another profile plugin");
    assert.equal(mockLlm.requests.length, 0, "status-only real integration unexpectedly called the model");

    const allCliOutput = [plan, installed, status, removed, removedStatus, restored, installedAgain]
      .map((result) => `${result.stdout}\n${result.stderr}`)
      .join("\n");
    assertAbsent("CLI output", allCliOutput, secrets);
    const finalManaged = await collectManagedText(path.join(dshHome, "gatherthread"));
    assertAbsent("final managed state", finalManaged, [...secrets, "reasoning_content", "PRIVATE_REASONING"]);
    assertAbsent("DSH Host logs", finalHostLogs, secrets);

    process.stdout.write(`${JSON.stringify({
      passed: true,
      dsh: { ...DSH_COMPATIBILITY, profile: "web" },
      profileInitialization: "official --dump-default-config created the web profile",
      lifecycle: ["plan", "install", "load", "status", "client-hmr", "unload", "reload", "remove", "restore", "idempotent-install"],
      browserBoundary: {
        unauthenticated: 401,
        wrongOrigin: 403,
        wrongHost: 403,
        authenticated: 200,
        afterUnload: 404,
      },
      clientSlotDiscovered: true,
      clientHmrDisposedAndReloadedExactlyOnce: true,
      clientPermanentFailureRetryStopped: true,
      credentialMode: "ephemeral GatherThread device token in process environment only",
      realModelCalls: 0,
    }, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (host !== undefined && host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill("SIGKILL");
      await withTimeout(host.exit.catch(() => undefined), "forced DSH cleanup", 5_000).catch(() => undefined);
    }
    await mockLlm?.close().catch(() => undefined);
    await collaboration?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
