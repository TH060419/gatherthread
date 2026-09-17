#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPrivateLanHostname, validateLanOrigin } from "./configure-connection.mjs";

const SAFE_CHILD_ENVIRONMENT = new Set([
  "APPDATA",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR",
]);

export function assertLanProxyConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") {
    throw new Error("LAN HTTPS requires NODE_ENV=production; run npm run connection:lan first");
  }
  const host = env.GATHERTHREAD_SERVER_HOST?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("LAN HTTPS requires GATHERTHREAD_SERVER_HOST=127.0.0.1");
  const rawPort = env.GATHERTHREAD_SERVER_PORT ?? "18787";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
    throw new Error("GATHERTHREAD_SERVER_PORT must be an integer from 1 to 65535");
  }
  if (env.GATHERTHREAD_TLS_TERMINATED_BY_PROXY !== "true") {
    throw new Error("LAN HTTPS requires GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true");
  }
  const publicUrl = validateLanOrigin(env.GATHERTHREAD_PUBLIC_BASE_URL?.trim() || "");
  return { publicUrl, target: `http://127.0.0.1:${rawPort}` };
}

export async function resolveLanBindAddress(publicUrl, lookup = dnsLookup) {
  const hostname = publicUrl.hostname.startsWith("[") && publicUrl.hostname.endsWith("]")
    ? publicUrl.hostname.slice(1, -1)
    : publicUrl.hostname;
  if (isIP(hostname)) return hostname;
  const addresses = await lookup(hostname, { all: true });
  const privateAddress = addresses.find(({ address }) => isPrivateLanHostname(address));
  if (!privateAddress) throw new Error(`${hostname} does not resolve to a private LAN address on this host`);
  return privateAddress.address;
}

export function renderLanCaddyfile(publicUrl, target, bindAddress) {
  return `{
\tskip_install_trust
\tauto_https disable_redirects
}

${publicUrl.origin} {
\tbind ${bindAddress}
\ttls internal
\tencode zstd gzip
\treverse_proxy ${target}
\theader -Server
}
`;
}

export function caddyChildEnvironment(env, dataHome, configHome) {
  const childEnvironment = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && SAFE_CHILD_ENVIRONMENT.has(name)) childEnvironment[name] = value;
  }
  childEnvironment.XDG_DATA_HOME = dataHome;
  childEnvironment.XDG_CONFIG_HOME = configHome;
  return childEnvironment;
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, shell: false });
    const forwarders = new Map();
    const cleanup = () => {
      for (const [signal, forward] of forwarders) process.removeListener(signal, forward);
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const forward = () => child.kill(signal);
      forwarders.set(signal, forward);
      process.once(signal, forward);
    }
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolvePromise({ code: code ?? 1, signal });
    });
  });
}

async function main() {
  const { publicUrl, target } = assertLanProxyConfiguration();
  const bindAddress = await resolveLanBindAddress(publicUrl);
  const runtimeDirectory = resolve(process.cwd(), ".local/network/lan");
  const dataHome = join(runtimeDirectory, "caddy-data");
  const configHome = join(runtimeDirectory, "caddy-config");
  const caddyfilePath = join(runtimeDirectory, "Caddyfile");
  const rootCertificatePath = join(dataHome, "caddy/pki/authorities/local/root.crt");
  await mkdir(dataHome, { recursive: true, mode: 0o700 });
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await writeFile(caddyfilePath, renderLanCaddyfile(publicUrl, target, bindAddress), { encoding: "utf8", mode: 0o600 });
  await chmod(runtimeDirectory, 0o700);
  await chmod(caddyfilePath, 0o600);

  const childEnvironment = caddyChildEnvironment(process.env, dataHome, configHome);
  try {
    const validation = await run("caddy", ["validate", "--config", caddyfilePath, "--adapter", "caddyfile"], childEnvironment);
    if (validation.signal) process.kill(process.pid, validation.signal);
    if (validation.code !== 0) process.exit(validation.code);
  } catch (error) {
    throw new Error(`unable to run Caddy; install Caddy 2 first (${error instanceof Error ? error.message : String(error)})`);
  }

  process.stdout.write(`Starting LAN-only HTTPS ${publicUrl.origin} on ${bindAddress} -> ${target}\n`);
  process.stdout.write(`Caddy's dedicated GatherThread LAN root certificate will be at:\n${rootCertificatePath}\n`);
  process.stdout.write("Install that root certificate on each test device before opening GatherThread; never bypass a certificate warning.\n");
  process.stdout.write("Do not configure router port forwarding or expose this port outside the trusted LAN.\n");
  const result = await run("caddy", ["run", "--config", caddyfilePath, "--adapter", "caddyfile"], childEnvironment);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`LAN HTTPS startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
