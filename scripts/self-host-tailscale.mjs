#!/usr/bin/env node
import { spawn } from "node:child_process";

const host = process.env.GATHERTHREAD_SERVER_HOST?.trim() || "127.0.0.1";
const rawPort = process.env.GATHERTHREAD_SERVER_PORT ?? "18787";
const publicBaseUrl = process.env.GATHERTHREAD_PUBLIC_BASE_URL?.trim();

if (process.env.NODE_ENV !== "production") {
  throw new Error("Tailscale Serve setup requires NODE_ENV=production so owner-host security checks cannot be skipped");
}
if (host !== "127.0.0.1") throw new Error("Tailscale Serve setup requires GATHERTHREAD_SERVER_HOST=127.0.0.1");
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
  throw new Error("GATHERTHREAD_SERVER_PORT must be an integer from 1 to 65535");
}
let publicUrl;
try {
  publicUrl = publicBaseUrl ? new URL(publicBaseUrl) : undefined;
} catch {
  throw new Error("GATHERTHREAD_PUBLIC_BASE_URL must be this device's exact https://*.ts.net origin");
}
if (
  !publicUrl
  || publicUrl.protocol !== "https:"
  || !publicUrl.hostname.endsWith(".ts.net")
  || publicUrl.username
  || publicUrl.password
  || publicUrl.pathname !== "/"
  || publicUrl.search
  || publicUrl.hash
) {
  throw new Error("Set GATHERTHREAD_PUBLIC_BASE_URL to this device's https://*.ts.net origin first");
}
if (process.env.GATHERTHREAD_TLS_TERMINATED_BY_PROXY !== "true") {
  throw new Error("Set GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true before configuring Tailscale Serve");
}

const target = `http://127.0.0.1:${rawPort}`;
process.stdout.write(`Configuring tailnet-only HTTPS Serve for ${publicUrl.origin} -> ${target}\n`);
process.stdout.write("This helper never enables Tailscale Funnel.\n");

const child = spawn("tailscale", ["serve", "--bg", "--https=443", target], {
  stdio: "inherit",
});
child.once("error", (error) => {
  process.stderr.write(`Unable to run tailscale: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
