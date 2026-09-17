#!/usr/bin/env node
import {
  HttpCollaborationClient,
  LocalConnectorCollaborationClient,
  booleanEnv,
  loadGatherThreadConnectionConfig,
} from "@gatherthread/bridge";
import { CollaborationMcpService } from "./service.js";
import { StdioMcpServer } from "./stdio.js";

export async function runMcpCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("MCP shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const profile = toolProfileEnv(env);
    const transport = mcpTransportEnv(env, profile);
    const api = transport === "connector"
      ? new LocalConnectorCollaborationClient({ workspacePath: process.cwd() })
      : httpClientFromEnvironment(env, shutdown.signal);
    const service = new CollaborationMcpService({
      api,
      ...(transport === "connector" ? { localSync: api as LocalConnectorCollaborationClient } : {}),
      toolProfile: profile,
      allowProviderRequestCapture: booleanEnv(
        env,
        "GATHERTHREAD_ALLOW_PROVIDER_REQUEST_CAPTURE",
        false,
      ),
    });
    await new StdioMcpServer(service).run({
      signal: shutdown.signal,
      maxMessageBytes: integerEnv(env, "GATHERTHREAD_MCP_MAX_MESSAGE_BYTES", 1_048_576),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function httpClientFromEnvironment(env: NodeJS.ProcessEnv, signal: AbortSignal): HttpCollaborationClient {
  const config = loadGatherThreadConnectionConfig(env);
  return new HttpCollaborationClient({
    baseUrl: config.apiUrl,
    bearerToken: config.bearerToken,
    requestTimeoutMs: config.requestTimeoutMs,
    signal,
  });
}

export function mcpTransportEnv(
  env: NodeJS.ProcessEnv,
  profile: "user" | "runtime",
): "connector" | "server-env" {
  const transport = env.GATHERTHREAD_MCP_TRANSPORT?.trim()
    || (profile === "runtime" ? "server-env" : "connector");
  if (transport !== "connector" && transport !== "server-env") {
    throw new Error("GATHERTHREAD_MCP_TRANSPORT must be connector or server-env");
  }
  if (profile === "runtime" && transport !== "server-env") {
    throw new Error("The runtime MCP profile requires the server-env transport");
  }
  return transport;
}

export function toolProfileEnv(env: NodeJS.ProcessEnv): "user" | "runtime" {
  const profile = env.GATHERTHREAD_MCP_TOOL_PROFILE?.trim() || "user";
  if (profile !== "user" && profile !== "runtime") {
    throw new Error("GATHERTHREAD_MCP_TOOL_PROFILE must be user or runtime");
  }
  return profile;
}

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 67_108_864) {
    throw new Error(`${name} must be an integer from 1024 to 67108864`);
  }
  return value;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runMcpCli().catch(() => {
    // stdout is reserved exclusively for MCP JSON-RPC frames.
    process.stderr.write("gatherthread-mcp: startup or transport failure\n");
    process.exitCode = 1;
  });
}
