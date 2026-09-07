#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;

try {
  const raw = await readInput();
  const event = JSON.parse(raw);
  if (!event || typeof event !== "object"
    || !["UserPromptSubmit", "Stop"].includes(event.hook_event_name)
    || typeof event.cwd !== "string" || !event.cwd
    || typeof event.session_id !== "string" || !event.session_id) {
    throw new Error("invalid hook event");
  }
  const response = await forward(await findRelay(event.cwd), event);
  const result = JSON.parse(response);
  const output = event.hook_event_name === "UserPromptSubmit" && typeof result.additionalContext === "string"
    ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.additionalContext } }
    : {};
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch {
  process.stdout.write("{}\n");
  process.stderr.write("gatherthread-hook: local connector relay unavailable\n");
}

async function findRelay(eventCwd) {
  const lexicalCandidate = path.resolve(eventCwd);
  const lexicalRelay = await findRelayFromCandidate(lexicalCandidate);
  if (lexicalRelay) return lexicalRelay;

  // The connector registry is keyed by the lexical workspace path supplied at
  // setup time. A canonical fallback still supports events reported through a
  // resolved symlink, while keeping Windows realpath aliases from changing the
  // primary registry key.
  const canonicalCandidate = await realpath(lexicalCandidate);
  if (platformComparablePath(canonicalCandidate) !== platformComparablePath(lexicalCandidate)) {
    const canonicalRelay = await findRelayFromCandidate(canonicalCandidate);
    if (canonicalRelay) return canonicalRelay;
  }
  throw new Error("no connector registry for hook cwd");
}

async function findRelayFromCandidate(initialCandidate) {
  let candidate = initialCandidate;
  while (true) {
    const comparableCandidate = platformComparablePath(candidate);
    const id = createHash("sha256")
      .update(comparableCandidate)
      .digest("hex")
      .slice(0, 24);
    const stateRoot = path.join(homedir(), ".gatherthread", "codex", "hooks", id);
    try {
      const registry = JSON.parse(await readFile(path.join(stateRoot, "hook-registry.json"), "utf8"));
      if (platformComparablePath(registry.workspacePath) === comparableCandidate
        && registry.hookSource === "plugin") {
        return process.platform === "win32"
          ? `\\\\.\\pipe\\gatherthread-${id}-hook-relay`
          : path.join(stateRoot, "hook-relay.sock");
      }
    } catch {
      // Continue toward the filesystem root; only a connector registry is authoritative.
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function platformComparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readInput() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_BYTES) reject(new Error("hook input too large"));
    });
    process.stdin.once("end", () => resolve(input));
    process.stdin.once("error", reject);
  });
}

function forward(endpoint, event) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(4000, () => socket.destroy(new Error("hook relay timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ source: "plugin", event })}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_BYTES) socket.destroy(new Error("hook response too large"));
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}
