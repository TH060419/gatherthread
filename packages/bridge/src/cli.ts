#!/usr/bin/env node
import { redactText } from "@agent-cooperation/adapters";
import { LocalBridge } from "./bridge.js";
import { loadBridgeDaemonConfig } from "./config.js";
import { BridgeDaemon } from "./daemon.js";
import { SubprocessHarnessExecutor } from "./executor.js";
import { FileCursorStore } from "./cursors.js";
import { HttpCollaborationClient } from "./http-client.js";

export async function runBridgeCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadBridgeDaemonConfig(env);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("Bridge shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const api = new HttpCollaborationClient({
      baseUrl: config.connection.apiUrl,
      bearerToken: config.connection.bearerToken,
      requestTimeoutMs: config.connection.requestTimeoutMs,
      signal: shutdown.signal,
    });
    const bridge = new LocalBridge({
      api,
      cursorStore: new FileCursorStore(config.cursorPath),
      runtime: config.runtime,
      transcriptRoots: {},
    });
    const executor = new SubprocessHarnessExecutor({
      ...config.adapter,
      harness: config.runtime.harness,
      signal: shutdown.signal,
      env,
    });
    const daemon = new BridgeDaemon({
      bridge,
      executor,
      pollIntervalMs: config.pollIntervalMs,
      pollLimit: config.pollLimit,
      signal: shutdown.signal,
      onPollError(error) {
        process.stderr.write(`relayroom-bridge: ${safeError(error, config.connection.bearerToken)}; retrying\n`);
      },
    });
    await daemon.run();
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function safeError(error: unknown, bearerToken: string): string {
  const message = error instanceof Error ? error.message : "worker poll failed";
  return redactText(message.replaceAll(bearerToken, "[REDACTED]").replace(/[\r\n]+/g, " "));
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runBridgeCli().catch(() => {
    process.stderr.write("relayroom-bridge: startup failed; check environment configuration and Relayroom availability\n");
    process.exitCode = 1;
  });
}
