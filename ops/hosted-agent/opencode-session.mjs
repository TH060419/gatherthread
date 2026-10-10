import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { publicSessionAnswer, sessionIsIdle } from "./public-answer.mjs";

const ORIGIN = "http://127.0.0.1:8790";
const VERSION = "1.18.32";

async function readJson(response, limit) {
  if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json"
    || !response.body) throw new Error("agent_failed");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("agent_failed");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** One isolated harness process; no SDK/SSE subscriber or second CLI process. */
export async function runOpencodeSession(workspace, prompt, outputLimit,
  { spawnProcess = spawn, fetchResponse = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const child = spawnProcess("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "8790", "--no-mdns"],
    { cwd: workspace, env: { ...process.env, PWD: workspace, BUN_OPTIONS: "--smol" }, stdio: ["ignore", "pipe", "pipe"] });
  let stopping = false, exited = false, closed = false, outputBytes = 0;
  let failed = false, forcedKill = false, shutdownRequested = false, closeCode, closeSignal;
  const fail = () => {
    failed = true;
    if (!stopping) controller.abort(new Error("agent_failed"));
  };
  child.once("error", fail);
  child.once("exit", () => { exited = true; if (!stopping) fail(); });
  const closure = new Promise(resolve => child.once("close", (code, signal) => {
    closed = true; closeCode = code; closeSignal = signal; resolve();
  }));
  // Drain both pipes, but never share server logs or exception details.
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => {
    outputBytes += bytes.length;
    if (outputBytes > outputLimit) { fail(); forcedKill = true; child.kill("SIGKILL"); }
  });
  const request = async (path, body, timeoutMs) => readJson(await fetchResponse(`${ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { "content-type": "application/json", "x-opencode-directory": workspace },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: timeoutMs ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) : controller.signal,
  }), outputLimit);
  try {
    let healthy = false;
    const startupDeadline = Date.now() + 15_000;
    while (Date.now() < startupDeadline && !healthy) {
      controller.signal.throwIfAborted();
      try {
        const health = await request("/global/health", undefined, 1000);
        if (health.healthy === true && health.version !== VERSION) throw new Error("agent_version_mismatch");
        healthy = health.healthy === true && health.version === VERSION;
      } catch (error) {
        if (error.message === "agent_version_mismatch") throw error;
      }
      if (!healthy) await delay(75, undefined, { signal: controller.signal });
    }
    if (!healthy || exited) throw new Error("agent_failed");
    const session = await request("/session", { title: "GatherThread cloud task",
      // Headless jobs have no question/plan-confirmation UI; never wait for it.
      permission: ["question", "plan_enter", "plan_exit"].map(permission => ({ permission, action: "deny", pattern: "*" })),
    }, 5000);
    if (!/^ses_[A-Za-z0-9]+$/u.test(session.id ?? "")) throw new Error("agent_failed");
    // This HTTP request awaits the final message, not the first text chunk.
    const reply = await request(`/session/${session.id}/message`, { agent: "build", parts: [{ type: "text", text: prompt }] });
    const answer = publicSessionAnswer(reply, session.id);
    const idleDeadline = Date.now() + 1000;
    while (!sessionIsIdle(await request("/session/status", undefined, 1000), session.id)) {
      if (Date.now() >= idleDeadline) throw new Error("agent_failed");
      await delay(50, undefined, { signal: controller.signal });
    }
    if (exited) throw new Error("agent_failed");
    return answer;
  } catch {
    throw new Error("agent_failed");
  } finally {
    // serve is intentionally persistent. Stop it only after final validation,
    // or failure, and wait for process closure before snapshotting any files.
    stopping = true;
    controller.abort();
    if (!exited) { shutdownRequested = true; child.kill("SIGTERM"); }
    await Promise.race([closure, delay(1000)]);
    if (!closed) { forcedKill = true; child.kill("SIGKILL"); await Promise.race([closure, delay(1000)]); }
    const expectedClose = closeCode === 0 && closeSignal === null
      || shutdownRequested && closeCode === null && closeSignal === "SIGTERM";
    if (!closed || failed || forcedKill || !expectedClose) throw new Error("agent_failed");
  }
}
