#!/usr/bin/env node
import { randomBytes as secureRandomBytes } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set(["local", "lan", "tailscale"]);
const MANAGED_VALUES = [
  "NODE_ENV",
  "GATHERTHREAD_SERVER_HOST",
  "GATHERTHREAD_PUBLIC_BASE_URL",
  "GATHERTHREAD_ALLOWED_ORIGINS",
  "GATHERTHREAD_TLS_TERMINATED_BY_PROXY",
  "GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP",
];

function exactOrigin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must not contain a path, query, or fragment`);
  }
  return url;
}

function unbracket(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isPrivateLanHostname(hostname) {
  const normalized = unbracket(hostname.toLowerCase());
  if (normalized.endsWith(".home.arpa")) return true;
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (family === 6) {
    const firstByte = Number.parseInt(normalized.slice(0, 2), 16);
    return Number.isInteger(firstByte) && (firstByte & 0xfe) === 0xfc;
  }
  return false;
}

export function validateLanOrigin(raw) {
  const url = exactOrigin(raw, "LAN URL");
  if (url.protocol !== "https:") throw new Error("LAN URL must use HTTPS");
  if (!isPrivateLanHostname(url.hostname)) {
    throw new Error("LAN URL must use an RFC1918/ULA address or a .home.arpa hostname");
  }
  if (!url.port) {
    throw new Error("LAN URL must include an unprivileged HTTPS port such as :8443");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("LAN HTTPS port must be an integer from 1024 to 65535");
  }
  return url;
}

export function validateTailscaleOrigin(raw) {
  const url = exactOrigin(raw, "Tailscale URL");
  if (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(".ts.net") || url.port) {
    throw new Error("Tailscale URL must be this host's exact https://*.ts.net origin without a port");
  }
  return url;
}

export function parseConnectionArguments(args) {
  const [mode, ...rest] = args;
  if (!mode || !MODES.has(mode)) {
    throw new Error("Usage: configure-connection.mjs <local|lan|tailscale> [--url EXACT_ORIGIN]");
  }
  let rawUrl;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument !== "--url" || rawUrl !== undefined || !rest[index + 1]) {
      throw new Error("Only one --url EXACT_ORIGIN option is supported");
    }
    rawUrl = rest[index + 1];
    index += 1;
  }
  if (mode === "local" && rawUrl !== undefined) throw new Error("local mode does not accept --url");
  if (mode !== "local" && rawUrl === undefined) throw new Error(`${mode} mode requires --url EXACT_ORIGIN`);
  return { mode, ...(rawUrl ? { rawUrl } : {}) };
}

function assignmentPattern(name) {
  return new RegExp(`^${name}=.*$`, "gm");
}

function configuredValue(contents, name) {
  const matches = [...contents.matchAll(assignmentPattern(name))];
  if (matches.length > 1) throw new Error(`${name} is defined more than once in .env`);
  return matches[0]?.[0].slice(name.length + 1);
}

function setConfiguredValue(contents, name, value) {
  const pattern = assignmentPattern(name);
  const matches = [...contents.matchAll(pattern)];
  if (matches.length > 1) throw new Error(`${name} is defined more than once in .env`);
  if (matches.length === 1) return contents.replace(pattern, () => `${name}=${value}`);
  return `${contents.replace(/\s*$/, "")}\n${name}=${value}\n`;
}

function connectionValues(mode, rawUrl, serverPort) {
  const shared = {
    GATHERTHREAD_SERVER_HOST: "127.0.0.1",
    GATHERTHREAD_ALLOWED_ORIGINS: "",
    GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP: "false",
  };
  if (mode === "local") {
    return {
      ...shared,
      NODE_ENV: "development",
      GATHERTHREAD_PUBLIC_BASE_URL: `http://127.0.0.1:${serverPort}`,
      GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "false",
    };
  }
  const url = mode === "lan" ? validateLanOrigin(rawUrl) : validateTailscaleOrigin(rawUrl);
  return {
    ...shared,
    NODE_ENV: "production",
    GATHERTHREAD_PUBLIC_BASE_URL: url.origin,
    GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "true",
  };
}

async function readEnvironmentSource(cwd) {
  const envPath = resolve(cwd, ".env");
  try {
    const info = await lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(".env must be a regular file, not a symlink");
    return { envPath, contents: await readFile(envPath, "utf8") };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { envPath, contents: await readFile(resolve(cwd, ".env.example"), "utf8") };
  }
}

async function writePrivateFile(path, contents, randomBytes) {
  const temporaryPath = join(dirname(path), `.env.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function configureConnectionEnvironment({
  cwd = process.cwd(),
  mode,
  rawUrl,
  randomBytes = secureRandomBytes,
} = {}) {
  if (!MODES.has(mode)) throw new Error("mode must be local, lan, or tailscale");
  const { envPath, contents } = await readEnvironmentSource(cwd);
  const rawPort = configuredValue(contents, "GATHERTHREAD_SERVER_PORT")?.trim() || "8787";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
    throw new Error("GATHERTHREAD_SERVER_PORT must be an integer from 1 to 65535 before configuring a connection");
  }
  const values = connectionValues(mode, rawUrl, rawPort);
  let nextContents = contents;
  for (const name of MANAGED_VALUES) {
    nextContents = setConfiguredValue(nextContents, name, values[name]);
  }
  await writePrivateFile(envPath, nextContents, randomBytes);
  return {
    mode,
    envPath,
    publicBaseUrl: values.GATHERTHREAD_PUBLIC_BASE_URL,
    serverPort: Number(rawPort),
  };
}

async function main() {
  const { mode, rawUrl } = parseConnectionArguments(process.argv.slice(2));
  const result = await configureConnectionEnvironment({ mode, rawUrl });
  process.stdout.write(`Configured ${result.mode} connection in private ${result.envPath}\n`);
  process.stdout.write(`Browser origin: ${result.publicBaseUrl}\n`);
  process.stdout.write("Existing database, credential pepper, storage limits, and device credentials were preserved.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Connection configuration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
