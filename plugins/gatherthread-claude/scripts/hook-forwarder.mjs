#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";

const LIMIT = 1024 * 1024;
try {
  const input = await readInput();
  if (!input || typeof input !== "object" || !["UserPromptSubmit", "Stop", "SessionStart", "PostModelSwitch", "StopFailure", "SessionEnd"].includes(input.hook_event_name)
    || typeof input.cwd !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(input.session_id ?? "")) throw new Error();
  const cwd = await realpath(input.cwd), comparable = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  const id = createHash("sha256").update(comparable).digest("hex").slice(0, 24);
  const directory = path.join(homedir(), ".gatherthread", "claude-code", "hooks", id);
  const directoryStat = await lstat(directory), file = path.join(directory, "hook-registry.json"), stat = await lstat(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let ancestor = homedir();
  for (const component of [".gatherthread", "claude-code", "hooks", id]) {
    ancestor = path.join(ancestor, component);
    const metadata = await lstat(ancestor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(ancestor) !== ancestor
      || uid !== undefined && metadata.uid !== uid || process.platform !== "win32" && (metadata.mode & 0o077)) throw new Error();
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768
    || uid !== undefined && (directoryStat.uid !== uid || stat.uid !== uid)
    || process.platform !== "win32" && ((directoryStat.mode & 0o077) || (stat.mode & 0o077))) throw new Error();
  const registry = JSON.parse(await readFile(file, "utf8"));
  if (registry.version !== 1 || registry.workspacePath !== cwd || registry.hookSource !== "plugin"
    || !/^[A-Za-z0-9_-]{43}$/u.test(registry.capability ?? "")) throw new Error();
  const event = { hook_event_name: input.hook_event_name, session_id: input.session_id, cwd };
  if (input.hook_event_name === "UserPromptSubmit") {
    if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > 65536) throw new Error();
    event.prompt = input.prompt;
  } else if (input.hook_event_name === "Stop") {
    // Always deliver bound terminal metadata, even when its body cannot be
    // captured. Otherwise an oversized answer leaves file sync busy forever.
    if (typeof input.last_assistant_message === "string" && Buffer.byteLength(input.last_assistant_message) <= 128 * 1024) event.last_assistant_message = input.last_assistant_message;
    event.stop_hook_active = input.stop_hook_active === true;
    if (typeof input.transcript_path === "string" && input.transcript_path.length <= 4096 && !/[\r\n\0]/u.test(input.transcript_path)) event.transcript_path = input.transcript_path;
  } else if (input.hook_event_name === "SessionStart") {
    if (typeof input.model === "string" && /^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(input.model)) event.model = input.model;
    if (typeof input.source === "string" && input.source.length <= 32) event.source = input.source;
  } else if (input.hook_event_name === "PostModelSwitch") {
    if (typeof input.to_model !== "string" || !/^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(input.to_model)) throw new Error();
    event.to_model = input.to_model;
  }
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\gatherthread-claude-code-${id}-hook-relay` : path.join(directory, "hook-relay.sock");
  const response = await forward(endpoint, { capability: registry.capability, event });
  const result = JSON.parse(response);
  const output = event.hook_event_name !== "UserPromptSubmit" ? {} : result.block === true
    ? { decision: "block", reason: "GatherThread is syncing local files or running a remote Claude request. Wait for it to finish, then submit again." }
    : typeof result.additionalContext === "string" && Buffer.byteLength(result.additionalContext) <= 65536
      ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.additionalContext } } : {};
  process.stdout.write(JSON.stringify(output) + "\n");
} catch { process.stdout.write("{}\n"); }

function readInput() {
  return new Promise((resolve, reject) => {
    // Select top-level Hook fields while streaming. A huge answer or unrelated
    // native metadata must not discard the small terminal identity or require
    // buffering a whole transcript-sized JSON frame in memory.
    const fields = new Set(["hook_event_name", "session_id", "cwd", "prompt", "last_assistant_message", "stop_hook_active", "transcript_path", "model", "source", "to_model"]);
    const selected = Object.create(null), seen = new Set();
    let phase = "open", key = "", mode = "", role = "", raw = "", size = 0, overflow = false, escaped = false;
    let compound = [], empty = true, failed = false;
    const finish = value => {
      if (fields.has(key)) {
        if (seen.has(key)) throw new Error();
        seen.add(key); if (value !== undefined) selected[key] = value;
      }
      phase = "after"; mode = "";
    };
    const beginString = nextRole => {
      mode = "string"; role = nextRole; raw = '"'; size = 1; overflow = false; escaped = false;
    };
    const consume = character => {
      if (mode === "string") {
        const capture = role === "key" || role === "value" && fields.has(key);
        if (capture && !overflow) {
          size += Buffer.byteLength(character);
          if (size > (role === "key" ? 4096 : LIMIT)) { overflow = true; raw = ""; }
          else raw += character;
        }
        if (escaped) { escaped = false; return true; }
        if (character === "\\") { escaped = true; return true; }
        if (character === '"') {
          if (role === "nested") mode = "compound";
          else if (role === "key") {
            if (overflow) throw new Error();
            key = JSON.parse(raw); phase = "colon"; mode = "";
          } else finish(capture && !overflow ? JSON.parse(raw) : undefined);
        } else if (character.charCodeAt(0) < 32) throw new Error();
        return true;
      }
      if (mode === "compound") {
        if (character === '"') beginString("nested");
        else if (character === "{" || character === "[") { if (compound.length >= 64) throw new Error(); compound.push(character); }
        else if (character === "}" || character === "]") {
          if (compound.pop() !== (character === "}" ? "{" : "[")) throw new Error();
          if (!compound.length) finish(undefined);
        }
        return true;
      }
      if (mode === "primitive") {
        if (/[\s,}]/u.test(character)) { finish(JSON.parse(raw)); return false; }
        if (raw.length >= 64) throw new Error(); raw += character; return true;
      }
      if (/\s/u.test(character)) return true;
      if (phase === "open" && character === "{") phase = "key";
      else if (phase === "key" && character === '"') beginString("key");
      else if (phase === "key" && character === "}" && empty) phase = "done";
      else if (phase === "colon" && character === ":") phase = "value";
      else if (phase === "value") {
        if (character === '"') beginString("value");
        else if (character === "{" || character === "[") { mode = "compound"; compound = [character]; }
        else { mode = "primitive"; raw = character; }
      } else if (phase === "after" && character === ",") { phase = "key"; empty = false; }
      else if (phase === "after" && character === "}") phase = "done";
      else throw new Error();
      return true;
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      if (failed) return;
      try { for (const character of chunk) while (!consume(character)) { /* Consume a primitive's delimiter in the next state. */ } }
      catch { failed = true; reject(new Error()); }
    });
    process.stdin.once("end", () => phase === "done" && !failed ? resolve(selected) : reject(new Error()));
    process.stdin.once("error", reject);
  });
}
function forward(endpoint, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint); let value = "";
    socket.setEncoding("utf8"); socket.setTimeout(4000, () => socket.destroy(new Error()));
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => { value += chunk; if (Buffer.byteLength(value) > LIMIT) socket.destroy(new Error()); });
    socket.once("end", () => resolve(value)); socket.once("error", reject);
  });
}
