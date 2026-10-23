#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startCollaborationServer } from "../apps/server/dist/src/server.js";
import { browserSessionFixture, identityFixture } from "../apps/server/dist/test/auth-fixtures.js";
import { DSH_COMPATIBILITY_TARGETS, DSH_NPM_COMPATIBILITY } from "../packages/dsh-host/dist/src/index.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_ROOT = path.join(ROOT, "packages/dsh-host");
const TIMEOUT_MS = 90_000;
const OUTPUT_LIMIT = 1_000_000;
const CHROME_PATH = process.env.GATHERTHREAD_CHROME_PATH
  ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);

function boundedOutput(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

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

function cleanEnvironment(root, dshHome) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)));
  return {
    ...environment,
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_store_dir: path.join(root, "pnpm-store"),
    PNPM_CONFIG_OFFLINE: "true",
  };
}

function runProcess(command, args, options) {
  const child = spawn(command, args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = boundedOutput(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = boundedOutput(stderr, chunk); });
  return withTimeout(new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  }), path.basename(command));
}

/**
 * Run the npm CLI without assuming a POSIX launcher.
 *
 * `spawn("npm", ...)` fails with ENOENT on Windows, where npm is only reachable
 * as `npm.cmd`, and Node no longer resolves `.cmd`/`.bat` shims for a
 * `shell: false` spawn. Resolve an argument-preserving CLI entry instead: the
 * path npm exports to its own lifecycle scripts, then the one shipped beside the
 * running Node. If neither exists the gate refuses rather than falling back to a
 * shell that would reparse the arguments.
 */
async function runNpm(args, options = { cwd: ROOT, env: process.env }) {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return runProcess(process.execPath, [npmCli, ...args], options);
  if (process.platform === "win32") {
    // Prefer the CLI entry the Windows Node installer ships beside the running
    // binary. Launching it through `process.execPath` keeps every argument
    // intact, where a `cmd /c` string would be re-parsed by the shell.
    const bundled = path.join(
      path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js",
    );
    try {
      await access(bundled);
      return await runProcess(process.execPath, [bundled, ...args], options);
    } catch {
      // Fall through to the shell shim.
    }
    // Refuse rather than shell-reparse. A `cmd /c` command line would
    // reinterpret any argument carrying spaces or metacharacters, and silently
    // running something other than what this gate asked for is worse than
    // stopping with something the operator can act on.
    throw new Error(
      "Unable to locate the npm CLI without a shell on Windows. "
      + "Run this gate through an npm script (which sets npm_execpath), or install "
      + "Node with its bundled npm.",
    );
  }
  return await runProcess("npm", args, options);
}

async function npmCacheRoot() {
  const result = await runNpm(["config", "get", "cache"]);
  if (result.code !== 0 || !path.isAbsolute(result.stdout.trim())) {
    throw new Error("Unable to resolve the local npm cache without network access");
  }
  return realpath(result.stdout.trim());
}

async function locatePinnedDsh() {
  const explicit = process.env.GATHERTHREAD_DSH_NPM_ROOT?.trim();
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  const cache = await npmCacheRoot();
  const npxRoot = path.join(cache, "_npx");
  for (const entry of await readdir(npxRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) candidates.push(path.join(npxRoot, entry.name, "node_modules/@deepseek-ai/dsh"));
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
      if (manifest.name === DSH_NPM_COMPATIBILITY.package
        && manifest.version === DSH_NPM_COMPATIBILITY.version
        && manifest.bin?.dsh === "lib/bin.js") {
        return realpath(candidate);
      }
    } catch {
      // Continue through local installations; this gate never downloads one.
    }
  }
  throw new Error(
    `Pinned ${DSH_NPM_COMPATIBILITY.package}@${DSH_NPM_COMPATIBILITY.version} is not present in the local npx cache`,
  );
}

async function loadPlaywright(dshRoot) {
  const candidates = [
    process.env.GATHERTHREAD_DSH_PLAYWRIGHT_SOURCE?.trim(),
    process.env.GATHERTHREAD_DSH_SOURCE?.trim(),
    dshRoot,
    ROOT,
  ].filter(Boolean);
  const cache = await npmCacheRoot();
  const npxRoot = path.join(cache, "_npx");
  for (const entry of await readdir(npxRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) candidates.push(path.join(npxRoot, entry.name));
  }
  for (const candidate of candidates) {
    for (const manifest of ["apps/web/package.json", "package.json"]) {
      try {
        const require = createRequire(path.join(candidate, manifest));
        const modulePath = require.resolve("playwright");
        const imported = await import(pathToFileURL(modulePath).href);
        return imported.default ?? imported;
      } catch {
        // The application install intentionally does not depend on a browser driver.
      }
    }
  }
  throw new Error(
    "Real browser verification needs an already-installed Playwright module; set GATHERTHREAD_DSH_PLAYWRIGHT_SOURCE to a local development checkout",
  );
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

export function dshExitDiagnosis(host, result) {
  // Child output may contain a one-use launch token, model credentials, cookies
  // or private paths. Return only allowlisted diagnostic categories, never logs.
  const reason = /user patch-layer watching requires the Cordis HMR service/u.test(host.stderr)
    ? "upstream profile hot-reload service is incompatible; the explicit isolated startup fixture may be used for separate plugin verification"
    : "isolated runtime terminated";
  return new Error(`DSH ${reason} (code ${result.code ?? "none"}, signal ${result.signal ?? "none"})`);
}

export async function configureStartupFixture(root, dshHome, enabled) {
  if (!enabled) return;
  const canonicalRoot = await realpath(root);
  const canonicalHome = await realpath(dshHome);
  assert.equal(canonicalHome, path.join(canonicalRoot, "dsh-home"), "startup fixture must stay in the script-created temporary home");
  const manifestPath = path.join(canonicalHome, "profiles/web/package.json");
  assert.equal(await realpath(manifestPath), manifestPath, "startup fixture manifest must not redirect outside its profile");
  const stat = await lstat(manifestPath);
  assert.ok(stat.isFile() && stat.nlink === 1, "startup fixture requires a single-link regular manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(manifest.dsh?.profile, "official installation must create its profile first");
  manifest.dsh.profile.patchReload = "startup";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
}

export function startDsh(bin, port, environment, workspace) {
  const child = spawn(process.execPath, [bin, "web", "--no-open", "--port", String(port)], {
    cwd: workspace,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const host = { child, stdout: "", stderr: "", launchUrl: undefined, exitResult: undefined };
  let readyResolve;
  let readyReject;
  const launch = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const append = (target, chunk) => {
    host[target] = boundedOutput(host[target], chunk);
    const match = /http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+/u.exec(`${host.stdout}\n${host.stderr}`);
    if (host.launchUrl === undefined && match?.[0]) {
      host.launchUrl = match[0];
      readyResolve(match[0]);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  host.exit = new Promise((resolve) => {
    child.once("error", () => {
      const result = { code: null, signal: null };
      host.exitResult = result;
      readyReject(dshExitDiagnosis(host, result));
      resolve(result);
    });
    child.once("exit", (code, signal) => {
      const result = { code, signal };
      host.exitResult = result;
      if (host.launchUrl === undefined) readyReject(dshExitDiagnosis(host, result));
      resolve(result);
    });
  });
  host.ready = Promise.race([
    launch.then(async (launchUrl) => {
      // Printing the launch URL is not readiness: an upstream boot failure can
      // follow immediately. Require the plugin route to refuse authentication
      // repeatedly while the child stays alive before returning its private URL.
      let consecutive = 0;
      while (true) {
        if (host.exitResult) throw dshExitDiagnosis(host, host.exitResult);
        try {
          const response = await rawHttp({ port, pathname: "/gatherthread/status/get", host: `127.0.0.1:${port}`, timeoutMs: 2_000 });
          consecutive = response.status === 401 ? consecutive + 1 : 0;
          if (consecutive >= 4) return launchUrl;
        } catch {
          consecutive = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
    }),
    host.exit.then((result) => { throw dshExitDiagnosis(host, result); }),
  ]);
  return host;
}

async function startMockLlm(apiKey) {
  const requests = [];
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body = boundedOutput(body, chunk); });
    request.on("end", () => {
      try {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const parsed = JSON.parse(body);
        if (pathname.endsWith("/messages")) {
          // DSH 0.1.7 switched @deepseek-ai/dsh-llm-deepseek to the Anthropic
          // Messages protocol: POST `/v1/messages`, `x-api-key` credential and
          // `message_start`/`content_block_*`/`message_delta`/`message_stop`
          // SSE events. `translate()` in the pinned adapter accepts exactly this
          // sequence, and reasoning arrives as a signed `thinking` block so the
          // private fixture text stays on the reasoning channel.
          assert.equal(request.headers["x-api-key"], apiKey);
          requests.push({ model: parsed.model, messages: parsed.messages });
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
          send({ type: "message_start", message: {
            id: `msg_${randomUUID()}`,
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 8, output_tokens: 0 },
          } });
          send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
          send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "EXPOSED_NATIVE_THINKING" } });
          send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } });
          send({ type: "content_block_stop", index: 0 });
          send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
          send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "WEB_DSH_FINAL" } });
          send({ type: "content_block_stop", index: 1 });
          send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
          send({ type: "message_stop" });
          response.end();
          return;
        }
        // Legacy OpenAI chat-completions transport, kept for any non-0.1.7 pin.
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        assert.equal(pathname.endsWith("/chat/completions"), true);
        requests.push({ model: parsed.model, messages: parsed.messages });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        for (const payload of [
          { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "EXPOSED_NATIVE_THINKING" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: "WEB_DSH_FINAL" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
        ]) response.write(`data: ${JSON.stringify(payload)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      } catch {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "fixture_failure", message: "mock LLM fixture rejected the request" } }));
      }
    });
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
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitUntil(label, operation, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function stopDsh(host) {
  if (host?.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGTERM");
  return host ? withTimeout(host.exit, "DSH shutdown", 20_000) : undefined;
}

function rawHttp({ port, pathname, method = "GET", host, cookie, origin, body, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host,
        ...(cookie === undefined ? {} : { cookie }),
        ...(origin === undefined ? {} : { origin, "sec-fetch-site": "same-origin" }),
        ...(encoded === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(encoded.byteLength),
        }),
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
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Isolated DSH HTTP request timed out")));
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}

async function requestData(origin, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  assert.ok(response.ok, `${options.method ?? "GET"} ${pathname} failed with ${response.status}`);
  return { data: payload?.data, headers: response.headers };
}

async function readSessionEvents(origin, sessionId, token) {
  const result = await requestData(
    origin,
    `/v1/sessions/${encodeURIComponent(sessionId)}/events?after_sequence=0&limit=500`,
    { token },
  );
  return result.data.events;
}

/**
 * Read the open acknowledgement to its end so its control enables itself.
 *
 * DSH 0.1.7 gates the first-run notice behind reading it: the button ships
 * `disabled` and only enables once the body has been scrolled to the bottom.
 * Scroll the real scrollable regions inside the dialog and let the control
 * decide; a forced click on a disabled control would be a lie about what the
 * operator or the product actually did.
 *
 * @returns whether the dialog was found and scrolled.
 */
async function readNoticeToEnd(page) {
  const dialog = page.locator('div[role="dialog"][aria-modal="true"]').last();
  if (await dialog.count() === 0) return false;
  await dialog.evaluate((node) => {
    for (const element of [node, ...node.querySelectorAll("*")]) {
      if (element.scrollHeight > element.clientHeight + 1) element.scrollTop = element.scrollHeight;
    }
  }).catch(() => undefined);
  await page.waitForTimeout(200);
  return true;
}

async function dismissOnboarding(page) {
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const button = page.getByRole("button", { name: /^(继续|Continue|稍后配置|Configure later)$/u }).first();
    if (await button.count() === 0 || !await button.isVisible()) break;
    if (await button.isDisabled()) {
      await readNoticeToEnd(page);
      // Still disabled means this dialog is not one this fixture can
      // acknowledge; fall through to the Escape path instead of forcing it.
      if (!await button.isEnabled().catch(() => false)) break;
    }
    await button.click();
    await page.waitForTimeout(400);
  }
  const modalMask = page.locator('div[role="presentation"] > div[aria-hidden="true"]').last();
  try {
    await modalMask.waitFor({ state: "hidden", timeout: 5_000 });
  } catch {
    await page.keyboard.press("Escape");
    await modalMask.waitFor({ state: "hidden", timeout: 5_000 });
  }
}

function assertAbsent(text, values, label) {
  for (const value of values) assert.equal(text.includes(value), false, `${label} leaked fixture material`);
}

async function main() {
  const fixtureOption = process.env.GATHERTHREAD_DSH_PATCH_RELOAD_STARTUP_FIXTURE;
  assert.ok(fixtureOption === undefined || fixtureOption === "0" || fixtureOption === "1", "GATHERTHREAD_DSH_PATCH_RELOAD_STARTUP_FIXTURE must be 0 or 1");
  const startupFixture = fixtureOption === "1";
  const dshRoot = await locatePinnedDsh();
  const dshManifest = JSON.parse(await readFile(path.join(dshRoot, "package.json"), "utf8"));
  const dshBin = path.join(dshRoot, dshManifest.bin.dsh);
  const version = await runProcess(process.execPath, [dshBin, "--version"], { cwd: ROOT, env: process.env });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), DSH_NPM_COMPATIBILITY.version);
  const pluginManifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.equal(pluginManifest.private, undefined, "the official profile package must remain publishable");
  assert.equal(pluginManifest.publishConfig?.access, "public");
  assert.equal(pluginManifest.publishConfig?.tag, "beta");
  assert.equal(pluginManifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  const playwright = await loadPlaywright(dshRoot);
  if (CHROME_PATH) await access(CHROME_PATH);

  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-npm-real-")));
  await chmod(root, 0o700);
  const dshHome = path.join(root, "dsh-home");
  const artifacts = path.join(root, "artifacts");
  const workspace = path.join(root, "workspace");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o500 });
  const environment = cleanEnvironment(root, dshHome);
  const pepper = `fixture-pepper-${randomBytes(18).toString("base64url")}`;
  const modelKey = `fixture-model-key-${randomBytes(18).toString("base64url")}`;
  let collaboration;
  let mockLlm;
  let host;
  let browser;
  let grantSecret = "";
  try {
    const packed = await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], {
      cwd: PACKAGE_ROOT,
      env: environment,
    });
    assert.equal(packed.code, 0, packed.stderr);
    const packResult = JSON.parse(packed.stdout);
    const packedFiles = new Set(packResult[0].files.map((file) => file.path));
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "cordis.patch.yml",
      "bundle/manifest.json",
      "client/client.js",
      "dist/bundle/native-plugin.js",
      "types/native-plugin.d.ts",
    ]) assert.equal(packedFiles.has(required), true, `published plugin is missing ${required}`);
    assert.equal(packedFiles.has("dist/src/native-plugin.d.ts"), false, "published types must not expose workspace-only imports");
    const tarball = path.join(artifacts, packResult[0].filename);
    await access(tarball);

    const added = await runProcess(process.execPath, [
      dshBin, "plugin", "--profile", "web", "add", "--offline", tarball,
    ], { cwd: ROOT, env: environment });
    assert.equal(added.code, 0, `${added.stdout}\n${added.stderr}`);
    const profileManifestPath = path.join(dshHome, "profiles/web/package.json");
    const profileManifest = JSON.parse(await readFile(profileManifestPath, "utf8"));
    assert.equal(profileManifest.dependencies?.["@gatherthread/dsh-host"].startsWith("file:"), true);
    assert.equal(profileManifest.dsh?.profile?.bundles.filter((name) => name === "@gatherthread/dsh-host").length, 1);
    const addedAgain = await runProcess(process.execPath, [
      dshBin, "plugin", "--profile", "web", "add", "--offline", tarball,
    ], { cwd: ROOT, env: environment });
    assert.equal(addedAgain.code, 0, `${addedAgain.stdout}\n${addedAgain.stderr}`);
    const profileAfterRepeat = JSON.parse(await readFile(profileManifestPath, "utf8"));
    assert.equal(
      profileAfterRepeat.dsh?.profile?.bundles.filter((name) => name === "@gatherthread/dsh-host").length,
      1,
      "repeated official installation must keep exactly one owned profile layer",
    );
    await configureStartupFixture(root, dshHome, startupFixture);
    if (startupFixture) process.stderr.write("DSH gate: explicit temporary startup-only fixture enabled; default upstream live reload is not verified\n");

    const dump = await runProcess(process.execPath, [dshBin, "web", "--dump-config"], {
      cwd: ROOT,
      env: environment,
    });
    assert.equal(dump.code, 0, dump.stderr);
    assert.match(dump.stdout, /gatherthread-dsh-native/u);
    assert.match(dump.stdout, /name: '@gatherthread\/dsh-host'/u);
    assert.doesNotMatch(dump.stdout, /@gatherthread\/dsh-host\/native-plugin/u);

    mockLlm = await startMockLlm(modelKey);
    environment.DEEPSEEK_API_KEY = modelKey;
    environment.DEEPSEEK_BASE_URL = mockLlm.origin;
    const longPublicHistory = `NATIVE_HISTORY_BEGIN\n${"canonical context ".repeat(4_500)}\nNATIVE_HISTORY_TAIL`;
    assert.ok(Buffer.byteLength(longPublicHistory, "utf8") > 64 * 1_024);

    const collaborationPort = await freePort();
    const collaborationOrigin = `http://127.0.0.1:${String(collaborationPort)}`;
    const staticDirectory = path.join(ROOT, "apps/web/dist");
    await access(path.join(staticDirectory, "index.html"));
    collaboration = await startCollaborationServer({
      databasePath: path.join(root, "gatherthread.sqlite"),
      authTokenPepper: pepper,
      allowHttpBootstrap: true,
      allowedOrigins: [collaborationOrigin],
      publicBaseUrl: collaborationOrigin,
      staticDirectory,
    }, collaborationPort);
    assert.equal(collaboration.origin, collaborationOrigin);
    // Reuse the account-aware authorization fixtures. The retired public token
    // bootstrap/session endpoints must not be restored for integration tests.
    const owner = identityFixture(collaboration, { body: {
        user_id: "dsh-npm-real-owner",
        display_name: "DSH npm real owner",
        device_id: "dsh-npm-real-browser",
        device_name: "Ephemeral browser",
      } }).body.data;
    await requestData(collaboration.origin, "/v1/projects", {
      method: "POST",
      token: owner.token,
      body: { project_id: "dsh-npm-real-project", idempotency_key: "dsh-npm-real-project-create", title: "DSH npm real project" },
    });
    await requestData(collaboration.origin, "/v1/projects/dsh-npm-real-project/sessions", {
      method: "POST",
      token: owner.token,
      body: {
        session_id: "dsh-npm-real-session",
        idempotency_key: "dsh-npm-real-session-create",
        title: "DSH npm real session",
        mode: "multi",
      },
    });
    await requestData(collaboration.origin, "/v1/sessions/dsh-npm-real-session/events", {
      method: "POST",
      token: owner.token,
      body: {
        idempotency_key: "dsh-npm-real-session-seed",
        type: "human_chat",
        payload: { text: `First Project seed\n${longPublicHistory}` },
      },
    });
    await requestData(collaboration.origin, "/v1/projects", {
      method: "POST",
      token: owner.token,
      body: {
        project_id: "dsh-npm-real-project-2",
        idempotency_key: "dsh-npm-real-project-2-create",
        title: "DSH npm second project",
      },
    });
    await requestData(collaboration.origin, "/v1/projects/dsh-npm-real-project-2/sessions", {
      method: "POST",
      token: owner.token,
      body: {
        session_id: "dsh-npm-real-session-2",
        idempotency_key: "dsh-npm-real-session-2-create",
        title: "DSH npm second session",
        mode: "multi",
      },
    });
    await requestData(collaboration.origin, "/v1/sessions/dsh-npm-real-session-2/events", {
      method: "POST",
      token: owner.token,
      body: {
        idempotency_key: "dsh-npm-real-session-2-seed",
        type: "human_chat",
        payload: { text: `Second Project seed\n${longPublicHistory}` },
      },
    });
    const browserSession = browserSessionFixture(collaboration, {
      token: owner.token,
      body: { remember_device: false },
    });
    const gatherthreadCookie = browserSession.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(gatherthreadCookie);

    const port = await freePort();
    process.stderr.write("DSH gate: starting isolated Web runtime\n");
    host = startDsh(dshBin, port, environment, workspace);
    const launchUrl = await withTimeout(host.ready, "published DSH Web readiness");
    process.stderr.write("DSH gate: checking authentication and RPC\n");
    const parsedLaunch = new URL(launchUrl);
    assert.equal(parsedLaunch.origin, `http://127.0.0.1:${String(port)}`);
    assert.match(parsedLaunch.searchParams.get("token") ?? "", /^[A-Za-z0-9_-]{43}$/u);
    const unauthenticated = await rawHttp({ port, pathname: "/gatherthread/status/get", host: parsedLaunch.host });
    assert.equal(unauthenticated.status, 401);
    process.stderr.write("DSH gate: unauthenticated RPC refused\n");
    const exchange = await fetch(launchUrl, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    process.stderr.write("DSH gate: local browser credential exchanged\n");
    const dshCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(dshCookie);
    const rpcId = randomUUID();
    const statusRpc = await rawHttp({
      port,
      pathname: "/gatherthread/status/get",
      method: "POST",
      host: parsedLaunch.host,
      cookie: dshCookie,
      origin: parsedLaunch.origin,
      body: { type: "client-request", rpcId, method: "status/get", payload: {} },
    });
    assert.equal(statusRpc.status, 200, statusRpc.body);
    const rpcPayload = JSON.parse(statusRpc.body);
    assert.equal(rpcPayload.rpcId, rpcId);
    assert.equal(rpcPayload.result?.ok, true);
    assert.equal(rpcPayload.result?.value?.authorization, "unpaired");
    assert.deepEqual(rpcPayload.result?.value?.compatibility, {
      package: "@deepseek-ai/dsh",
      version: DSH_NPM_COMPATIBILITY.version,
      profile: "web",
      targets: DSH_COMPATIBILITY_TARGETS,
    });
    process.stderr.write("DSH gate: authenticated RPC verified; starting browser\n");

    browser = await playwright.chromium.launch({
      headless: true,
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    });
    process.stderr.write("DSH gate: checking browser pairing and model selection\n");
    const browserContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
    const page = await browserContext.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(launchUrl, { waitUntil: "load" });
    await dismissOnboarding(page);
    await page.getByRole("button", { name: /^(设置|Settings)$/u }).click();
    const section = page.getByRole("button", { name: "GatherThread / 共序", exact: true });
    await section.waitFor({ timeout: 30_000 });
    assert.equal(await section.count(), 1);
    await section.click();
    const panel = page.locator("[data-gatherthread-status]");
    await panel.waitFor({ timeout: 30_000 });
    await panel.getByText("连接共序", { exact: true }).waitFor({ timeout: 30_000 });
    await panel.getByLabel("GatherThread 服务器地址").fill(collaboration.origin);
    await panel.getByLabel("DSH 设备名称").fill("Ephemeral DSH npm device");
    await panel.getByRole("button", { name: "登录并配对", exact: true }).click();
    const verificationLink = panel.getByRole("link", { name: "打开 GatherThread 确认", exact: true });
    await verificationLink.waitFor({ timeout: 30_000 });
    const userCode = (await panel.locator("code").textContent())?.trim();
    assert.match(userCode ?? "", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    const verificationUrl = await verificationLink.getAttribute("href");
    assert.ok(verificationUrl?.startsWith(`${collaboration.origin}/#dsh-pair=`));
    const cookieSeparator = gatherthreadCookie.indexOf("=");
    assert.ok(cookieSeparator > 0);
    await page.context().addCookies([{
      name: gatherthreadCookie.slice(0, cookieSeparator),
      value: gatherthreadCookie.slice(cookieSeparator + 1),
      url: collaboration.origin,
      httpOnly: true,
      sameSite: "Strict",
    }]);
    const gatherthreadPage = await page.context().newPage();
    gatherthreadPage.on("dialog", (dialog) => void dialog.accept());
    await gatherthreadPage.goto(verificationUrl, { waitUntil: "load" });
    await gatherthreadPage.locator("#workspace:not([hidden])").waitFor({ timeout: 30_000 });
    await gatherthreadPage.locator("#approve-dsh-pairing-dialog[open]").waitFor({ timeout: 30_000 });
    assert.equal((await gatherthreadPage.locator("#approve-dsh-pairing-code").textContent())?.trim(), userCode);
    await gatherthreadPage.locator("#confirm-dsh-pairing-button").click();
    await gatherthreadPage.locator("#approve-dsh-pairing-dialog").waitFor({ state: "hidden", timeout: 30_000 });
    await gatherthreadPage.locator("#connect-dsh-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await gatherthreadPage.locator("#done-connect-dsh-button").click();

    await panel.getByRole("button", { name: "选择 DSH 模型", exact: true }).waitFor({ timeout: 30_000 });
    await panel.getByRole("button", { name: "选择 DSH 模型", exact: true }).click();
    await panel.getByLabel("DSH Provider").selectOption("deepseek-official");
    await panel.getByLabel("DSH Model").selectOption("deepseek-flash");
    await panel.getByRole("button", { name: "连接全部可访问项目", exact: true }).click();
    await panel.getByText("2 个可访问项目", { exact: true }).waitFor({ timeout: 30_000 });
    await panel.getByText(
      "DSH npm real project · DSH npm second project",
      { exact: true },
    ).waitFor({ timeout: 30_000 });

    /**
     * Report which stage a failed registration reached, without echoing the run.
     *
     * Everything here is a contract value the product already publishes: the
     * server's own runtime listing for this Session, the panel's fixed connection
     * attribute, and which of the panel's fixed notices is on screen. Child output
     * is deliberately not reproduced, because it carries the one-use launch token
     * and private paths; a stage is what an operator needs, not a transcript.
     */
    const reportDshStage = async () => {
      const runs = await requestData(
        collaboration.origin,
        "/v1/sessions/dsh-npm-real-session/runtimes",
        { token: owner.token },
      ).catch(() => undefined);
      const registered = (runs?.data?.runtimes ?? []).map((runtime) =>
        `${runtime.harness}:${runtime.provider}/${runtime.model}/${runtime.status}`);
      const panelState = await panel.getAttribute("data-gatherthread-status").catch(() => null) ?? "none";
      const panelText = await panel.innerText().catch(() => "");
      const notices = ["状态暂不可用", "DSH 当前已不再提供", "操作未完成", "选择 DSH 模型", "连接全部可访问项目"]
        .filter((notice) => panelText.includes(notice));
      const sessionEvents = await readSessionEvents(collaboration.origin, "dsh-npm-real-session", owner.token).catch(() => []);
      const kinds = [...new Set(sessionEvents.map((event) => event.type))].join("|");
      process.stderr.write(`DSH stage: panel=${panelState} registered=[${registered.join(", ")}] modelRequests=${String(mockLlm?.requests?.length ?? 0)} events=[${kinds}] notices=[${notices.join("|")}]\n`);
    };
    let selectedRuntime;
    try {
      selectedRuntime = await waitUntil("published DSH runtime registration", async () => {
        const result = await requestData(
          collaboration.origin,
          "/v1/sessions/dsh-npm-real-session/runtimes",
          { token: owner.token },
        );
        return result.data.runtimes.find((runtime) => runtime.harness === "deepseek-harness"
          && runtime.provider === "deepseek-official"
          && runtime.model === "deepseek-flash"
          && runtime.status === "online");
      });
    } catch (error) {
      await reportDshStage();
      throw error;
    }
    await waitUntil("second Project DSH runtime registration", async () => {
      const result = await requestData(
        collaboration.origin,
        "/v1/sessions/dsh-npm-real-session-2/runtimes",
        { token: owner.token },
      );
      return result.data.runtimes.find((runtime) => runtime.harness === "deepseek-harness"
        && runtime.provider === "deepseek-official"
        && runtime.model === "deepseek-flash"
        && runtime.status === "online");
    });

    await page.getByRole("button", { name: "关闭", exact: true }).click();
    process.stderr.write("DSH gate: checking native history and cloud adoption\n");
    const firstProjectEntry = page.getByText("DSH npm real project", { exact: true });
    const secondProjectEntry = page.getByText("DSH npm second project", { exact: true });
    await firstProjectEntry.waitFor({ timeout: 30_000 });
    await secondProjectEntry.waitFor({ timeout: 30_000 });
    await firstProjectEntry.click();
    await page.waitForTimeout(1_000);
    const firstWorkspaceText = await page.locator("body").innerText();
    // The GatherThread marker has to survive DSH's own title clipping and reach
    // the session rail, which is the only place it is visible to the operator.
    assert.match(firstWorkspaceText, /DSH npm real session · 共序 · MULTI/u, firstWorkspaceText);
    await secondProjectEntry.click();
    await page.waitForTimeout(1_000);
    const secondWorkspaceText = await page.locator("body").innerText();
    assert.match(secondWorkspaceText, /DSH npm second session · 共序 · MULTI/u, secondWorkspaceText);
    assert.equal(mockLlm.requests.length, 0, "passive long-history projection must not invoke a model or compactor");

    // DSH 0.1.7 turns a workspace title into a disclosure toggle, and the global
    // "新建会话" control now opens a Session in whatever workspace is current —
    // which is DSH's startup default workspace, not the project just browsed.
    // Each project row owns an explicit per-workspace create control that passes
    // its workspace id, so the native Session is born in the second project's
    // workspace and is discoverable for cloud adoption.
    await page
      .locator('button[aria-label*="DSH npm second project"][aria-label*="新建会话"]:visible')
      .first()
      .click();
    const nativeComposer = page.locator('[contenteditable="true"][data-placeholder]:visible').first();
    const nativeSend = page.getByRole("button", { name: "发送消息", exact: true });
    await nativeComposer.waitFor({ timeout: 30_000 });
    // Creating a Session navigates the main view: the composer of the previous
    // Session lingers briefly, then a fresh one mounts for the new Session. A
    // draft typed into the outgoing editor is dropped, leaving the new send
    // control disabled. Require the draft to persist in the live composer and
    // the send control to stay enabled across consecutive polls before clicking
    // it unforced, so the request is typed into the Session that is actually open.
    let draftStablePolls = 0;
    await waitUntil("native composer holds the request draft", async () => {
      const composer = page.locator('[contenteditable="true"][data-placeholder]:visible').first();
      if (await composer.count() === 0) {
        draftStablePolls = 0;
        return false;
      }
      const text = await composer.evaluate((node) => node.textContent ?? "").catch(() => "");
      if (text.trim() !== "DSH_NATIVE_REQUEST") {
        await composer.fill("DSH_NATIVE_REQUEST").catch(() => undefined);
        draftStablePolls = 0;
        return false;
      }
      const enabled = await nativeSend.isEnabled().catch(() => false);
      draftStablePolls = enabled ? draftStablePolls + 1 : 0;
      return draftStablePolls >= 8;
    }, 45_000);
    await nativeSend.click();
    await page.locator("p", { hasText: /^WEB_DSH_FINAL$/u }).first().waitFor({ timeout: 60_000 });

    let lastNativeAdoptionPoll = 0;
    const adoptedNative = await waitUntil("native DSH Session cloud adoption", async () => {
      if (Date.now() - lastNativeAdoptionPoll < 2_500) return undefined;
      lastNativeAdoptionPoll = Date.now();
      const listed = await requestData(
        collaboration.origin,
        "/v1/projects/dsh-npm-real-project-2/sessions",
        { token: owner.token },
      );
      const candidate = listed.data.sessions.find((session) => session.id !== "dsh-npm-real-session-2");
      if (!candidate) return undefined;
      const events = await readSessionEvents(collaboration.origin, candidate.id, owner.token);
      const request = events.find((event) => event.type === "agent_request"
        && event.payload?.content === "DSH_NATIVE_REQUEST");
      const response = request && events.find((event) => event.type === "agent_response"
        && event.reply_to_event_id === request.id
        && event.payload?.text === "WEB_DSH_FINAL");
      return response ? { candidate, events } : undefined;
    }, 60_000).catch(async (error) => {
      const listed = await requestData(
        collaboration.origin,
        "/v1/projects/dsh-npm-real-project-2/sessions",
        { token: owner.token },
      ).catch(() => undefined);
      const sessions = listed?.data?.sessions ?? [];
      process.stderr.write(`ADOPT-DIAG sessions=${JSON.stringify(sessions.map((session) => session.id))}\n`);
      for (const session of sessions) {
        const events = await readSessionEvents(collaboration.origin, session.id, owner.token).catch(() => []);
        process.stderr.write(`ADOPT-DIAG session=${session.id} events=${JSON.stringify(events.map((event) => ({
          type: event.type,
          content: event.payload?.content,
          text: event.payload?.text,
        }))).slice(0, 4000)}\n`);
      }
      throw error;
    });
    assert.equal(adoptedNative.candidate.mode, "solo");
    assert.equal(adoptedNative.candidate.owner_user_id, "dsh-npm-real-owner");
    await page.waitForTimeout(1_000);
    const afterAdoption = await requestData(
      collaboration.origin,
      "/v1/projects/dsh-npm-real-project-2/sessions",
      { token: owner.token },
    );
    assert.equal(
      afterAdoption.data.sessions.filter((session) => session.id !== "dsh-npm-real-session-2").length,
      1,
      "one completed native DSH Session must create exactly one cloud Session",
    );

    await gatherthreadPage.goto(
      `${collaboration.origin}/#project=dsh-npm-real-project&session=dsh-npm-real-session`,
      { waitUntil: "load" },
    );
    process.stderr.write("DSH gate: checking workspace request and reload\n");
    await gatherthreadPage.locator("#workspace:not([hidden])").waitFor({ timeout: 30_000 });
    // A fresh browser/device must acknowledge the first-workspace cloud-code notice
    // before opening Settings. This is a real modal, not a dismissible test overlay.
    const codeNotice = gatherthreadPage.locator("#code-notice-dialog[open]");
    await codeNotice.waitFor({ timeout: 30_000 });
    await gatherthreadPage.locator("#code-notice-continue").click();
    await codeNotice.waitFor({ state: "hidden", timeout: 30_000 });
    const firstUseGuide = gatherthreadPage.locator(".onboarding-example-dialog[open]");
    await firstUseGuide.waitFor({ timeout: 30_000 });
    await gatherthreadPage.frameLocator(".onboarding-example-dialog iframe")
      .getByRole("button", { name: /^(?:Exit example|退出示例)/u }).click();
    await firstUseGuide.waitFor({ state: "hidden", timeout: 30_000 });
    await gatherthreadPage.locator("#settings-button").click();
    await gatherthreadPage.locator("#settings-dialog[open]").waitFor({ timeout: 30_000 });
    await gatherthreadPage.locator("#settings-enabled-dsh").check();
    await gatherthreadPage.locator("#settings-dialog button[type='submit']").click();
    await gatherthreadPage.locator("#settings-dialog").waitFor({ state: "hidden", timeout: 30_000 });
    // Agent, model and reasoning now live in one dialog on every screen, so the
    // composer's own controls are reachable only after it is opened.
    const probeHarnessControl = async () => {
      const report = await gatherthreadPage.evaluate(() => {
        const select = document.querySelector("#agent-harness-select");
        const dialog = select instanceof Element ? select.closest("dialog") : null;
        const style = select instanceof Element ? getComputedStyle(select) : undefined;
        return {
          options: select instanceof HTMLSelectElement ? [...select.options].map((option) => option.value) : [],
          closestDialog: dialog?.id ?? null,
          closestDialogOpen: dialog?.hasAttribute("open") ?? null,
          agentDialogOpen: document.querySelector("#mobile-agent-dialog")?.hasAttribute("open") ?? null,
          parentId: select?.parentElement?.id ?? null,
          display: style?.display ?? null,
          visibility: style?.visibility ?? null,
          height: select?.getBoundingClientRect().height ?? null,
          buttonHeight: document.querySelector("#mobile-agent-button")?.getBoundingClientRect().height ?? null,
        };
      });
      process.stderr.write(`DSH stage: harness-control=${JSON.stringify(report)}\n`);
    };
    await gatherthreadPage.locator("#mobile-agent-button").click();
    await gatherthreadPage.locator("#mobile-agent-dialog[open]").waitFor({ timeout: 30_000 });
    try {
      await gatherthreadPage.locator("#agent-harness-select").selectOption("deepseek-harness");
    } catch (error) {
      await probeHarnessControl();
      throw error;
    }
    const webRuntimeId = await waitUntil("Web-visible DSH runtime", async () => {
      return gatherthreadPage.locator("#agent-dsh-runtime-select").evaluate((element) => {
        if (!(element instanceof HTMLSelectElement)) return undefined;
        return [...element.options].find((option) => option.value && !option.disabled)?.value;
      });
    });
    let activeWebSessionId = "dsh-npm-real-session";
    if (webRuntimeId !== selectedRuntime.id) {
      const runtimeLists = await Promise.all([
        requestData(collaboration.origin, "/v1/sessions/dsh-npm-real-session/runtimes", { token: owner.token }),
        requestData(collaboration.origin, "/v1/sessions/dsh-npm-real-session-2/runtimes", { token: owner.token }),
      ]);
      const match = runtimeLists.flatMap((result, index) => result.data.runtimes.map((runtime) => ({
        runtime,
        sessionId: index === 0 ? "dsh-npm-real-session" : "dsh-npm-real-session-2",
      }))).find((candidate) => candidate.runtime.id === webRuntimeId);
      assert.ok(match, "the Web-selected DSH runtime must belong to an accessible GatherThread session");
      selectedRuntime = match.runtime;
      activeWebSessionId = match.sessionId;
    }
    await gatherthreadPage.locator("#agent-dsh-runtime-select").selectOption(webRuntimeId);
    await gatherthreadPage.locator("#mobile-agent-dialog [data-mobile-close]").click();
    await gatherthreadPage.locator("#mobile-agent-dialog[open]").waitFor({ state: "hidden", timeout: 30_000 });
    await gatherthreadPage.locator("#message-input").fill("WEB_DSH_REQUEST");
    await gatherthreadPage.locator("#send-agent-button").click();
    try {
      // The answer appears twice by design: once in the live work log, which
      // folds once the request completes, and once as the final canonical
      // message. Assert the one the reader can actually see rather than
      // whichever copy the locator happens to reach first.
      await gatherthreadPage.getByText("WEB_DSH_FINAL", { exact: true })
        .filter({ visible: true }).first().waitFor({ timeout: 60_000 });
    } catch (error) {
      const rendered = await gatherthreadPage.evaluate(() => {
        const matches = [];
        for (const element of document.querySelectorAll("body *")) {
          if (element.children.length === 0 && (element.textContent ?? "").includes("WEB_DSH")) {
            matches.push({ tag: element.tagName, cls: String(element.className).slice(0, 60), text: (element.textContent ?? "").slice(0, 90) });
          }
        }
        return { bodyHas: document.body.innerText.includes("WEB_DSH"), matches: matches.slice(0, 8) };
      });
      process.stderr.write(`DSH stage: render=${JSON.stringify(rendered)}\n`);
      await reportDshStage();
      throw error;
    }

    const completed = await waitUntil("Web-selected DSH final", async () => {
      const events = await readSessionEvents(collaboration.origin, activeWebSessionId, owner.token);
      const request = events.find((event) => event.type === "agent_request" && event.payload?.content === "WEB_DSH_REQUEST");
      if (!request) return undefined;
      const final = events.find((event) => event.type === "agent_response"
        && event.reply_to_event_id === request.id
        && event.payload?.text === "WEB_DSH_FINAL");
      return final ? { events, request, final } : undefined;
    }, 60_000);
    assert.deepEqual(completed.request.payload.execution_profile, {
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoning_effort: "high",
      runtime_id: selectedRuntime.id,
    });
    const outputs = completed.events.filter((event) => event.reply_to_event_id === completed.request.id);
    assert.equal(outputs.at(-1)?.type, "agent_response");
    assert.ok(outputs.slice(0, -1).every((event) => event.type === "agent_progress"));
    assert.equal(
      outputs.filter((event) => event.type === "agent_progress"
        && event.payload?.phase === "activity" && event.payload?.dsh_event_sequence !== undefined).length,
      1,
      "a burst of durable DSH events should produce one bounded activity renewal",
    );
    assert.equal(
      outputs.filter((event) => event.type === "agent_progress"
        && event.payload?.phase === "activity" && event.payload?.dsh_event_sequence === undefined).length,
      1,
      "the native running transition should be visible independently of durable-event renewal",
    );
    assert.equal(new Set(outputs.map((event) => event.id)).size, outputs.length);
    assert.ok(outputs.every((event) => event.runtime_provenance?.runtime_id === selectedRuntime.id));
    // ADR-0045, PRODUCT_SPEC and SECURITY.md share a claimed request's
    // native-visible output, exposed thinking included; only *hidden* reasoning
    // is excluded. DSH `0.1.7` surfaces the provider's thinking as a
    // native-visible reasoning block, so the connector publishes it by design.
    // The assertion that used to sit here demanded the opposite, which encoded
    // the older chat-completions transport where the same text never reached a
    // natively visible surface. Assert the contract, not the old transport.
    assert.ok(
      JSON.stringify(completed.events).includes("EXPOSED_NATIVE_THINKING"),
      "native-exposed thinking must reach shared output through the bounded live-output allowlist",
    );
    // The boundary that is still real: none of this may enter canonical history.
    assert.equal(
      JSON.stringify(completed.events).includes(modelKey),
      false,
      "the model credential must never reach canonical history",
    );

    await gatherthreadPage.reload({ waitUntil: "load" });
    await gatherthreadPage.locator("#workspace:not([hidden])").waitFor({ timeout: 30_000 });
    await gatherthreadPage.waitForFunction(() => {
      const harness = document.querySelector("#agent-harness-select");
      const runtime = document.querySelector("#agent-dsh-runtime-select");
      return harness instanceof HTMLSelectElement
        && runtime instanceof HTMLSelectElement
        && harness.value === "deepseek-harness"
        && runtime.value.length > 0;
    }, undefined, { timeout: 30_000 });
    // The reload closes the dialog again, so the same controls are reached the
    // same way.
    await gatherthreadPage.locator("#mobile-agent-button").click();
    await gatherthreadPage.locator("#mobile-agent-dialog[open]").waitFor({ timeout: 30_000 });
    await gatherthreadPage.locator("#agent-harness-select").selectOption("codex");
    assert.equal(await gatherthreadPage.locator("#codex-agent-profile-fields").isVisible(), true);
    assert.equal(await gatherthreadPage.locator("#dsh-agent-profile-fields").isVisible(), false);
    await gatherthreadPage.locator("#mobile-agent-dialog [data-mobile-close]").click();
    await gatherthreadPage.locator("#mobile-agent-dialog[open]").waitFor({ state: "hidden", timeout: 30_000 });

    const credentialPath = path.join(dshHome, ".credentials.yaml");
    const credentialText = await readFile(credentialPath, "utf8");
    // Windows synthesises a fixed 0o666 for every file, so the mode is only
    // meaningful where the filesystem stores one. Content and containment are
    // asserted on every platform, and the reported result says which of the two
    // this run actually checked.
    const credentialModeVerified = process.platform !== "win32";
    if (credentialModeVerified) {
      assert.equal((await lstat(credentialPath)).mode & 0o777, 0o600);
    }
    assert.match(credentialText, /gatherthread-dsh-host\/default/u);
    grantSecret = credentialText.match(/gta_[A-Za-z0-9_-]+/u)?.[0] ?? "";
    assert.ok(grantSecret, "the fixture DSH grant was not written to the official credential store");
    await page.getByRole("button", { name: /^(设置|Settings)$/u }).click();
    await section.waitFor({ timeout: 30_000 });
    await section.click();
    await panel.waitFor({ state: "visible", timeout: 30_000 });

    // Exercise code collaboration through the shipped native and Web controls.
    // Both source and private sync state stay inside this isolated DSH_HOME.
    const codeProjectId = "dsh-npm-real-project";
    process.stderr.write("DSH gate: checking source authorization and recovery\n");
    const codeRoot = path.join(root, "GatherThread Projects", "DSH npm real project");
    const codeApiPath = `/v1/projects/${codeProjectId}/code`;
    await access(codeRoot);
    await writeFile(path.join(codeRoot, "README.md"), "DSH_NATIVE_CODE_V1\n");
    await writeFile(path.join(codeRoot, ".gitignore"), ".env\nnode_modules/\n");
    await writeFile(path.join(codeRoot, ".env"), "LOCAL_ONLY=fixture-private-value\n");
    const nativeCodeState = async () => {
      const result = await rawHttp({
        port, pathname: "/gatherthread/status/get", method: "POST", host: parsedLaunch.host,
        cookie: dshCookie, origin: parsedLaunch.origin,
        body: { type: "client-request", rpcId: randomUUID(), method: "status/get", payload: {} },
      });
      assert.equal(result.status, 200);
      const payload = JSON.parse(result.body);
      assert.equal(payload.result?.ok, true);
      return payload.result.value.codeSync?.find((project) => project.projectId === codeProjectId);
    };
    assert.equal((await nativeCodeState()).authorized, false, "pairing does not authorize source upload");
    const codeSection = panel.getByRole("region", { name: "项目代码同步", exact: true });
    const nativeCodeControls = codeSection.locator("details").filter({
      has: page.locator("summary", { hasText: /^DSH npm real project$/u }),
    });
    await nativeCodeControls.locator("summary").click();
    assert.equal(await nativeCodeControls.getByRole("button", { name: "上传代码", exact: true }).isDisabled(), true);
    await gatherthreadPage.goto(`${collaboration.origin}/#project=${codeProjectId}&session=dsh-npm-real-session`, { waitUntil: "load" });
    await gatherthreadPage.locator("#workspace:not([hidden])").waitFor({ timeout: 30_000 });
    await gatherthreadPage.locator("#project-code-button").click();
    await gatherthreadPage.locator("#project-code-dialog[open]").waitFor({ timeout: 30_000 });
    assert.equal((await gatherthreadPage.locator("#code-project-name").textContent())?.trim(), "DSH npm real project");
    // The dialog now opens on the GitHub provider; this flow drives GT Cloud, so
    // select that panel before reaching its controls.
    await gatherthreadPage.locator("#code-provider-gt-cloud").click();
    try {
      await gatherthreadPage.locator("#code-enable-button").click({ timeout: 30_000 });
    } catch (error) {
      const probe = await gatherthreadPage.evaluate(() => {
        const button = document.querySelector("#code-enable-button");
        const dialog = document.querySelector("#project-code-dialog");
        const box = button?.getBoundingClientRect();
        return {
          repositoryStatus: document.querySelector("#code-repository-status")?.textContent ?? null,
          codeError: document.querySelector("#code-error")?.textContent ?? null,
          buttonDisabled: button?.disabled ?? null,
          buttonHasHiddenAttribute: button?.hasAttribute("hidden") ?? null,
          buttonRendered: button !== null && button.getClientRects().length > 0,
          buttonHeight: box?.height ?? null,
          buttonDisplay: button === null ? null : getComputedStyle(button).display,
          buttonVisibility: button === null ? null : getComputedStyle(button).visibility,
          sectionHiddenAttr: document.querySelector("#code-enable-section")?.hasAttribute("hidden") ?? null,
          dialogOpenAttr: dialog?.hasAttribute("open") ?? null,
          dialogDisplay: dialog === null ? null : getComputedStyle(dialog).display,
          openDialogs: [...document.querySelectorAll("dialog[open]")].map((item) => item.id),
        };
      });
      process.stderr.write(`DSH stage: code-dialog=${JSON.stringify(probe)}\n`);
      throw error;
    }
    await gatherthreadPage.locator("#code-confirm-accept").click();
    await gatherthreadPage.locator("#code-enabled-content").waitFor({ state: "visible", timeout: 30_000 });
    await nativeCodeControls.getByLabel("允许此 DSH 同步该项目代码", { exact: true }).click();
    await waitUntil("native code authorization and initial status", async () => {
      const state = await nativeCodeState();
      return state?.authorized && state.status?.enabled ? state : undefined;
    });
    await nativeCodeControls.getByRole("button", { name: "上传代码", exact: true }).click();
    const cloudCode = async () => (await requestData(collaboration.origin, codeApiPath, { token: owner.token })).data;
    const nativeCheckpoint = await waitUntil("native manual source upload", async () => {
      const status = await cloudCode();
      return status.branches.find((branch) => branch.id === status.own_branch_id);
    });
    const sourceSnapshot = async () => (await requestData(collaboration.origin, `${codeApiPath}/snapshot?branch_id=${encodeURIComponent(nativeCheckpoint.id)}`, { token: owner.token })).data.snapshot;
    let source = await sourceSnapshot();
    assert.deepEqual(source.files.map((file) => file.path).sort(), [".gitignore", "README.md"]);
    assert.equal(Buffer.from(source.files.find((file) => file.path === "README.md").content_base64, "base64").toString(), "DSH_NATIVE_CODE_V1\n");
    assert.equal((await nativeCodeState()).status.automatic_upload, false);
    await access(path.join(dshHome, "gatherthread-code-sync"));

    await nativeCodeControls.getByLabel("空闲时自动上传本地代码至云端", { exact: true }).click();
    await waitUntil("native auto source opt-in", async () => (await nativeCodeState())?.status?.automatic_upload === true);
    await writeFile(path.join(codeRoot, "README.md"), "DSH_IDLE_AUTO_CODE_V2\n");
    await waitUntil("settled native automatic source upload", async () => {
      const snapshot = await sourceSnapshot();
      return snapshot.commit !== nativeCheckpoint.head_commit && snapshot.files.some((file) => file.path === "README.md"
        && Buffer.from(file.content_base64, "base64").toString() === "DSH_IDLE_AUTO_CODE_V2\n");
    }, 45_000);
    await nativeCodeControls.getByLabel("空闲时自动上传本地代码至云端", { exact: true }).click();
    await waitUntil("native automatic source disabled", async () => (await nativeCodeState())?.status?.automatic_upload === false);

    const codeRuntimes = (await requestData(collaboration.origin, "/v1/sessions/dsh-npm-real-session/runtimes", { token: owner.token })).data.runtimes;
    // This endpoint returns only this user's execution runtimes; purpose is not
    // part of its deliberately narrow public DTO.
    const codeRuntime = codeRuntimes.find((runtime) => runtime.harness === "deepseek-harness" && runtime.status === "online");
    assert.ok(codeRuntime);
    await gatherthreadPage.locator("#code-open-device-view").click();
    await gatherthreadPage.locator("#code-device-view").waitFor({ state: "visible", timeout: 30_000 });
    await gatherthreadPage.locator("#code-runtime-select").selectOption(codeRuntime.id);
    await waitUntil("Web exact DSH device source status", async () => !(await gatherthreadPage.locator("#code-upload-button").isDisabled()));
    await writeFile(path.join(codeRoot, "README.md"), "DSH_WEB_DEVICE_CODE_V3\n");
    const codeRequest = gatherthreadPage.waitForRequest((request) => {
      if (request.method() !== "POST") return false;
      try { return request.postDataJSON()?.kind === "code_upload"; } catch { return false; }
    });
    await gatherthreadPage.locator("#code-upload-button").click();
    await gatherthreadPage.locator("#code-confirm-accept").click();
    const codePayload = (await codeRequest).postDataJSON();
    assert.equal(codePayload.target_runtime_id, codeRuntime.id, "Web must target exactly the selected DSH execution runtime");
    await waitUntil("Web source upload completed by real DSH", async () => {
      const snapshot = await sourceSnapshot();
      return snapshot.files.some((file) => file.path === "README.md"
        && Buffer.from(file.content_base64, "base64").toString() === "DSH_WEB_DEVICE_CODE_V3\n");
    }, 45_000);

    const requestsBeforeRecovery = mockLlm.requests.length;
    const originalSource = await readFile(path.join(codeRoot, "README.md"), "utf8");
    await nativeCodeControls.getByRole("button", { name: "恢复到新目录", exact: true }).click();
    const recoveredCode = await waitUntil("native recovery new-folder receipt", async () => {
      const state = await nativeCodeState();
      return state?.status?.recovery_directory ? state.status : undefined;
    });
    assert.equal(recoveredCode.local_status_unknown, true);
    assert.equal(path.basename(recoveredCode.recovery_directory), recoveredCode.recovery_directory);
    const recoveredRoot = path.join(path.dirname(codeRoot), recoveredCode.recovery_directory);
    assert.equal(await readFile(path.join(recoveredRoot, "README.md"), "utf8"), originalSource);
    assert.equal(await readFile(path.join(codeRoot, "README.md"), "utf8"), originalSource);
    assert.equal(mockLlm.requests.length, requestsBeforeRecovery, "code recovery never invokes the model");
    await nativeCodeControls.getByLabel("允许此 DSH 同步该项目代码", { exact: true }).click();
    await waitUntil("native code consent revoked", async () => (await nativeCodeState())?.authorized === false);
    await gatherthreadPage.locator("#close-project-code-button").click();

    const pairedDom = await panel.textContent() ?? "";
    assertAbsent(pairedDom, [owner.token, pepper, modelKey, grantSecret, root, dshHome], "DSH Client DOM");
    assertAbsent(`${host.stdout}\n${host.stderr}`, [owner.token, pepper, modelKey, grantSecret], "DSH Host output");
    assert.doesNotMatch(pairedDom, /authorization|bearer|headers|stack/iu);
    assert.equal((await readdir(workspace)).length, 0, "the read-only workspace must remain unchanged");
    assert.ok(mockLlm.requests.some((request) => JSON.stringify(request.messages).includes("WEB_DSH_REQUEST")));
    const projectedRequest = mockLlm.requests.find((request) => JSON.stringify(request.messages).includes("WEB_DSH_REQUEST"));
    const projectedText = JSON.stringify(projectedRequest.messages);
    assert.ok(projectedText.includes("NATIVE_HISTORY_BEGIN"), "the real native model request must retain the history start");
    assert.ok(projectedText.includes("NATIVE_HISTORY_TAIL"), "the real native model request must retain the history tail beyond 64 KiB");

    await panel.getByRole("button", { name: "断开此 DSH 的本地配对", exact: true }).click();
    await panel.getByRole("button", { name: "登录并配对", exact: true }).waitFor({ timeout: 30_000 });
    const clearedCredentialText = await readFile(credentialPath, "utf8");
    assert.equal(clearedCredentialText.includes(grantSecret), false);
    assert.equal(clearedCredentialText.includes("gatherthread-dsh-host/default"), false);

    await browser.close();
    browser = undefined;
    const exit = await stopDsh(host);
    // Windows has no POSIX signals, so the shutdown kill surfaces as a null
    // exit code carrying a signal instead of a graceful zero.
    if (process.platform === "win32") {
      assert.ok(exit.code === 0 || exit.signal !== null, `unexpected DSH shutdown: ${JSON.stringify(exit)}`);
    } else {
      assert.equal(exit.code, 0);
    }
    host = undefined;

    const removed = await runProcess(process.execPath, [
      dshBin, "plugin", "--profile", "web", "remove", "@gatherthread/dsh-host",
    ], { cwd: ROOT, env: environment });
    assert.equal(removed.code, 0, `${removed.stdout}\n${removed.stderr}`);
    const afterRemove = JSON.parse(await readFile(profileManifestPath, "utf8"));
    assert.equal(afterRemove.dependencies?.["@gatherthread/dsh-host"], undefined);
    assert.equal(afterRemove.dsh?.profile?.bundles.includes("@gatherthread/dsh-host"), false);

    process.stdout.write(`${JSON.stringify({
      passed: true,
      distribution: `${DSH_NPM_COMPATIBILITY.package}@${DSH_NPM_COMPATIBILITY.version}`,
      command: `npx @deepseek-ai/dsh@${DSH_NPM_COMPATIBILITY.version} web`,
      pluginMechanism: "dsh plugin --profile web add <package>",
      profile: "web",
      patchReloadFixture: startupFixture ? "startup" : "default",
      defaultLiveReloadVerified: !startupFixture,
      lifecycle: ["pack", "add", "idempotent-add", "load", "authenticated-rpc", "browser-auto-discovery", "browser-pair", "configure", "writable-native-session", "native-full-history", "native-cloud-adoption", "web-request", "progress", "final", "reload", "native-code-consent", "native-code-upload", "native-code-auto-upload", "web-exact-device-code-upload", "native-code-recovery", "code-consent-revocation", "disconnect", "remove"],
      realDshHome: false,
      networkDownloads: false,
      credentialStore: {
        official: true,
        mode: credentialModeVerified ? "0600" : null,
        modeVerified: credentialModeVerified,
        clearedBeforeRemove: true,
      },
    })}\n`);
  } catch (error) {
    if (host?.exitResult) throw dshExitDiagnosis(host, host.exitResult);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopDsh(host).catch(() => undefined);
    await collaboration?.close().catch(() => undefined);
    await mockLlm?.close().catch(() => undefined);
    if (process.env.GATHERTHREAD_KEEP_TMP) process.stderr.write(`GATHERTHREAD_KEEP_TMP=${root}\n`);
    else await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
