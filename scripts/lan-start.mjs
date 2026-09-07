#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { configureConnectionEnvironment, isPrivateLanHostname } from "./configure-connection.mjs";

const DEFAULT_PORT = 8443;
const HEALTH_TIMEOUT_MS = 120_000;
const ROOT_TIMEOUT_MS = 20_000;

function normalizeFamily(family) {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

export function privateLanAddresses(interfaces = networkInterfaces()) {
  const candidates = [];
  const seen = new Set();
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses ?? []) {
      const family = normalizeFamily(entry.family);
      if (entry.internal || family === 0 || !isPrivateLanHostname(entry.address) || seen.has(entry.address)) continue;
      seen.add(entry.address);
      candidates.push({ interfaceName, address: entry.address, family });
    }
  }
  return candidates.sort((left, right) => left.family - right.family
    || left.interfaceName.localeCompare(right.interfaceName)
    || left.address.localeCompare(right.address));
}

function validatePort(raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error("LAN port must contain digits only");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("LAN port must be an integer from 1024 to 65535");
  }
  return port;
}

function validateAddress(raw) {
  const address = raw?.trim();
  if (!address || !isIP(address) || !isPrivateLanHostname(address)) {
    throw new Error("--address must be an RFC1918 or ULA private IP address");
  }
  return address;
}

export function parseLanStartArguments(args) {
  let address;
  let port = DEFAULT_PORT;
  let displayName;
  let deviceName;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!new Set(["--address", "--port", "--display-name", "--device-name"]).has(option) || !value) {
      throw new Error("Usage: npm run lan:start -- [--address PRIVATE_IP] [--port 8443] [--display-name NAME] [--device-name NAME]");
    }
    if (option === "--address") address = validateAddress(value);
    if (option === "--port") port = validatePort(value);
    if (option === "--display-name") displayName = value.trim();
    if (option === "--device-name") deviceName = value.trim();
    index += 1;
  }
  if (displayName === "" || deviceName === "") throw new Error("display and device names must not be blank");
  return { address, port, displayName, deviceName };
}

export function lanOrigin(address, port = DEFAULT_PORT) {
  const safeAddress = validateAddress(address);
  const safePort = validatePort(port);
  return `https://${isIP(safeAddress) === 6 ? `[${safeAddress}]` : safeAddress}:${safePort}`;
}

export function caddyInstallHint(platform = process.platform) {
  if (platform === "darwin") return "Install Caddy once with: brew install caddy";
  if (platform === "win32") return "Install Caddy once with Chocolatey (`choco install caddy`) or Scoop (`scoop install caddy`), then reopen the terminal.";
  return "Install Caddy 2 once from https://caddyserver.com/docs/install, then rerun this command.";
}

async function chooseAddress(explicitAddress) {
  if (explicitAddress) return explicitAddress;
  const candidates = privateLanAddresses();
  if (candidates.length === 0) {
    throw new Error("no private LAN address was found; connect to the LAN or pass --address PRIVATE_IP");
  }
  if (candidates.length === 1) return candidates[0].address;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`multiple private addresses were found; rerun with --address followed by one of: ${candidates.map(({ address }) => address).join(", ")}`);
  }
  process.stdout.write("Choose the trusted LAN address:\n");
  candidates.forEach(({ interfaceName, address }, index) => {
    process.stdout.write(`  ${index + 1}. ${address} (${interfaceName})\n`);
  });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Selection [1-${candidates.length}]: `);
    const selected = Number(answer);
    if (!Number.isInteger(selected) || selected < 1 || selected > candidates.length) {
      throw new Error("invalid LAN address selection");
    }
    return candidates[selected - 1].address;
  } finally {
    prompt.close();
  }
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: options.stdio ?? "inherit",
  });
  return child;
}

function childResult(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code: code ?? 1, signal }));
  });
}

async function runAndWait(command, args, options) {
  const result = await childResult(run(command, args, options));
  if (result.signal) throw new Error(`${command} stopped by ${result.signal}`);
  if (result.code !== 0) throw new Error(`${command} exited with code ${result.code}`);
}

async function hasCaddy() {
  try {
    await runAndWait("caddy", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function npmCommand(script, forwarded = []) {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return { command: process.execPath, args: [npmCli, "run", script, ...(forwarded.length ? ["--", ...forwarded] : [])] };
  if (process.platform === "win32") {
    throw new Error("run LAN startup through `npm run lan:start` so npm_execpath is available on Windows");
  }
  return { command: "npm", args: ["run", script, ...(forwarded.length ? ["--", ...forwarded] : [])] };
}

function unquote(value) {
  if (value?.length >= 2 && value[0] === value.at(-1) && new Set(["\"", "'"]).has(value[0])) return value.slice(1, -1);
  return value;
}

function environmentValue(contents, name) {
  const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? unquote(match[1].trim()) : undefined;
}

async function initializeIfNeeded(envPath, displayName, deviceName) {
  const contents = await readFile(envPath, "utf8");
  const databasePath = resolve(process.cwd(), environmentValue(contents, "GATHERTHREAD_DATABASE_PATH") || ".local/collaboration.sqlite");
  let databaseExists = true;
  try {
    const info = await lstat(databasePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("configured database must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    databaseExists = false;
  }
  if (databaseExists) {
    if (!environmentValue(contents, "GATHERTHREAD_AUTH_TOKEN_PEPPER")) {
      throw new Error("the existing database has no configured credential pepper; restore its original Pepper before starting");
    }
    return;
  }

  if ((!displayName || !deviceName) && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("a new database requires --display-name and --device-name when no interactive terminal is available");
  }
  let prompt;
  try {
    if (!displayName || !deviceName) prompt = createInterface({ input: process.stdin, output: process.stdout });
    const ownerName = displayName || (await prompt.question("Creator display name: ")).trim();
    const ownerDevice = deviceName || (await prompt.question("This device name: ")).trim();
    if (!ownerName || !ownerDevice) throw new Error("display and device names must not be blank");
    process.stdout.write("\nCreating the first account. Save the device token printed below; it is shown only once.\n\n");
    const init = npmCommand("owner-host:init", ["--display-name", ownerName, "--device-name", ownerDevice]);
    await runAndWait(init.command, init.args);
  } finally {
    prompt?.close();
  }
}

async function waitForHealth(port, serverExit) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const earlyExit = await Promise.race([
      serverExit.then((result) => ({ result })),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 250)),
    ]);
    if (earlyExit) throw new Error(`GatherThread exited before becoming ready (code ${earlyExit.result.code})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The process is still building or starting.
    }
  }
  throw new Error(`GatherThread did not become ready within ${HEALTH_TIMEOUT_MS / 1000} seconds`);
}

async function waitForRootCertificate(path, proxyExit) {
  const deadline = Date.now() + ROOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const earlyExit = await Promise.race([
      proxyExit.then((result) => ({ result })),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 250)),
    ]);
    if (earlyExit) throw new Error(`LAN HTTPS proxy exited before becoming ready (code ${earlyExit.result.code})`);
    try {
      const contents = await readFile(path);
      return createHash("sha256").update(contents).digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Caddy did not create the LAN root certificate in time");
}

function terminate(child, signal = "SIGTERM") {
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

async function main() {
  const options = parseLanStartArguments(process.argv.slice(2));
  if (!(await hasCaddy())) throw new Error(caddyInstallHint());
  const address = await chooseAddress(options.address);
  const origin = lanOrigin(address, options.port);
  const configured = await configureConnectionEnvironment({ mode: "lan", rawUrl: origin });
  await initializeIfNeeded(configured.envPath, options.displayName, options.deviceName);

  process.stdout.write(`\nLAN configuration ready: ${origin}\nBuilding and starting GatherThread...\n\n`);
  const build = npmCommand("build");
  await runAndWait(build.command, build.args);

  const server = run(process.execPath, ["--env-file-if-exists=.env", "apps/server/dist/src/cli.js", "start"]);
  const serverExit = childResult(server);
  let proxy;
  const stop = (signal) => {
    terminate(proxy, signal);
    terminate(server, signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    await waitForHealth(configured.serverPort, serverExit);
    proxy = run(process.execPath, ["--env-file-if-exists=.env", "scripts/self-host-lan.mjs"]);
    const proxyExit = childResult(proxy);
    const rootCertificatePath = resolve(process.cwd(), ".local/network/lan/caddy-data/caddy/pki/authorities/local/root.crt");
    const fingerprint = await waitForRootCertificate(rootCertificatePath, proxyExit);
    process.stdout.write(`\nLAN is ready: ${origin}\n`);
    process.stdout.write(`Client root certificate: ${rootCertificatePath}\n`);
    process.stdout.write(`SHA-256: ${fingerprint}\n`);
    process.stdout.write("Install this root certificate on each trusted client, then open the LAN URL. Press Control-C to stop both services.\n\n");

    const result = await Promise.race([
      serverExit.then((value) => ({ source: "GatherThread", value })),
      proxyExit.then((value) => ({ source: "LAN proxy", value })),
    ]);
    stop("SIGTERM");
    if (result.value.signal && !new Set(["SIGINT", "SIGTERM"]).has(result.value.signal)) {
      throw new Error(`${result.source} stopped by ${result.value.signal}`);
    }
    if (result.value.code !== 0 && !result.value.signal) {
      throw new Error(`${result.source} exited with code ${result.value.code}`);
    }
  } catch (error) {
    stop("SIGTERM");
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`LAN one-command startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
