import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Actor } from "./database.js";
import { isCodeSyncPathAllowed, type CodeFile, type HostedAgentRequestInput, type JsonValue } from "@gatherthread/protocol";
import { ApiError } from "./errors.js";
import { redactJson } from "./redaction.js";
import type { CollaborationService } from "./service.js";
import type { CodeRepository } from "./code-repository.js";

export const HOSTED_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const HOSTED_HARNESS = "opencode";
const RUN_NEURONS = 2_000;
const MAX_MODEL_CALLS = 8;
const MAX_MODEL_BODY_BYTES = 64_000;
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_CONTEXT_BYTES = 12_000;
const MAX_WORKSPACE_FILES = 100;
const MAX_WORKSPACE_BYTES = 512_000;
const RUN_TIMEOUT_MS = 120_000;

export interface HostedAgentOptions {
  accountId: string;
  apiToken: string;
  image: string;
  defaultUserDailyNeurons: number;
  globalDailyNeurons: number;
  maxConcurrent: number;
  fetch?: typeof globalThis.fetch;
  runContainer?: (args: string[], timeoutMs: number) => Promise<string>;
}

function costUpperBound(bodyBytes: number): number {
  return Math.ceil((2 * bodyBytes * 4_625 + MAX_OUTPUT_TOKENS * 30_475) / 1_000_000);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function runDocker(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/",
    } });
    let output = "";
    let size = 0;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } child.kill("SIGKILL"); };
    const timer = setTimeout(() => fail(new Error("container_timeout")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) fail(new Error("container_output_too_large"));
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 64_000) fail(new Error("container_output_too_large")); });
    child.once("error", (error) => { clearTimeout(timer); fail(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(output);
      else reject(new Error("container_failed"));
    });
  });
}

/** Only model egress: short-lived Unix socket with per-run request and Neuron caps. */
export class HostedModelProxy {
  private calls = 0;
  private spent = 0;
  readonly server = createServer((request, response) => void this.forward(request, response));
  constructor(private readonly options: HostedAgentOptions) {}

  async listen(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => { this.server.off("error", reject); resolve(); });
    });
    chmodSync(path, 0o666);
  }

  close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const fail = (code: number) => { if (!response.headersSent) response.writeHead(code).end(); else response.destroy(); };
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions"
        || request.headers["content-type"]?.split(";")[0] !== "application/json") return fail(404);
      const bytes = await readBody(request, MAX_MODEL_BODY_BYTES);
      const body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (body.model !== HOSTED_MODEL || !Array.isArray(body.messages) || body.messages.length < 1
        || body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens)
          || (body.max_tokens as number) < 1 || (body.max_tokens as number) > MAX_OUTPUT_TOKENS)) return fail(400);
      const charge = costUpperBound(bytes.length);
      if (this.calls >= MAX_MODEL_CALLS || this.spent + charge > RUN_NEURONS) return fail(429);
      this.calls += 1;
      this.spent += charge;
      delete body.max_completion_tokens;
      body.max_tokens = MAX_OUTPUT_TOKENS;
      body.n = 1;
      const upstream = await (this.options.fetch ?? globalThis.fetch)(
        `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/ai/v1/chat/completions`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${this.options.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (!upstream.body) { response.end(); return; }
      let sent = 0;
      for await (const chunk of upstream.body) {
        sent += chunk.length;
        if (sent > 256_000) { response.destroy(); break; }
        response.write(chunk);
      }
      response.end();
    } catch { fail(502); }
  }
}

function writeSnapshot(root: string, files: CodeFile[]): void {
  if (files.length > MAX_WORKSPACE_FILES || files.reduce((n, f) => n + Buffer.byteLength(f.content_base64, "base64"), 0) > MAX_WORKSPACE_BYTES) {
    throw new ApiError(413, "hosted_code_too_large", "Cloud Agent accepts at most 100 files and 500 KiB of code");
  }
  for (const file of files) {
    if (!isCodeSyncPathAllowed(file.path)) throw new Error("unsafe_snapshot_path");
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o777 });
    chmodSync(dirname(path), 0o777);
    writeFileSync(path, Buffer.from(file.content_base64, "base64"), { flag: "wx", mode: file.executable ? 0o777 : 0o666 });
    chmodSync(path, file.executable ? 0o777 : 0o666);
  }
}

export class HostedAgent {
  constructor(private readonly service: CollaborationService, private readonly codeRepository: CodeRepository,
    private readonly options: HostedAgentOptions) {
    if (!/^[a-f0-9]{32}$/iu.test(options.accountId) || !options.apiToken || /[\r\n]/u.test(options.apiToken)
      || !/^(?:[-a-z0-9./_]+@)?sha256:[a-f0-9]{64}$/u.test(options.image)) {
      throw new Error("Cloud Agent needs a Workers AI credential and digest-pinned container image");
    }
    for (const [name, value, maximum] of [
      ["defaultUserDailyNeurons", options.defaultUserDailyNeurons, 10_000],
      ["globalDailyNeurons", options.globalDailyNeurons, 9_000],
      ["maxConcurrent", options.maxConcurrent, 8],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is out of range`);
    }
  }

  status(actor: Actor) {
    return { enabled: true, harness: HOSTED_HARNESS, model: HOSTED_MODEL,
      ...this.service.database.hostedAgentUsage(actor, this.options.defaultUserDailyNeurons,
        this.options.globalDailyNeurons),
      capabilities: ["read_code", "edit_code", "terminal", "run_tests"],
      privacy: "Session text and opted-in cloud code are sent to Cloudflare Workers AI for inference. Code runs in a short-lived container without general network access." };
  }

  private assertDockerReady(): void {
    if (this.options.runContainer) return;
    const ready = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000, stdio: "ignore" });
    const image = spawnSync("docker", ["image", "inspect", this.options.image], { timeout: 5_000, stdio: "ignore" });
    if (ready.status !== 0 || image.status !== 0) throw new ApiError(503, "hosted_runner_unavailable", "Cloud Agent execution is unavailable");
  }

  async request(actor: Actor, sessionId: string, input: HostedAgentRequestInput) {
    this.assertDockerReady();
    const session = this.service.database.requireSession(sessionId);
    const context = this.service.readHistoryContext(actor, sessionId);
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES) {
      throw new ApiError(413, "hosted_context_too_large", "Cloud Agent needs a shorter conversation context");
    }
    let branch: { commit: string; files: CodeFile[] } | undefined;
    if (input.include_code) {
      const status = this.codeRepository.status(actor, session.project_id);
      const snapshot = this.codeRepository.snapshot(actor, session.project_id, status.own_branch_id ?? "main");
      branch = { commit: snapshot.snapshot.commit, files: snapshot.snapshot.files };
      if (branch.files.length > MAX_WORKSPACE_FILES
        || branch.files.reduce((n, f) => n + Buffer.byteLength(f.content_base64, "base64"), 0) > MAX_WORKSPACE_BYTES) {
        throw new ApiError(413, "hosted_code_too_large", "Cloud Agent accepts at most 100 files and 500 KiB of code");
      }
    }
    const reserved = this.service.reserveHostedAgentRequest(actor, sessionId, input, RUN_NEURONS,
      this.options.defaultUserDailyNeurons, this.options.globalDailyNeurons, this.options.maxConcurrent);
    if (!reserved.created) return { request_event: reserved.event, replayed: true };
    let content = "";
    let root: string;
    try { root = mkdtempSync(join(tmpdir(), "gt-hosted-")); }
    catch {
      const result = this.service.finishHostedAgentRequest(reserved.event.id, {});
      return { request_event: reserved.event, response_event: result, replayed: false };
    }
    const workspace = join(root, "workspace");
    const control = join(root, "control");
    const socket = join(root, "model.sock");
    const name = `gt-hosted-${randomBytes(8).toString("hex")}`;
    const proxy = new HostedModelProxy(this.options);
    try {
      mkdirSync(workspace, { mode: 0o777 });
      mkdirSync(control, { mode: 0o755 });
      if (branch) writeSnapshot(workspace, branch.files);
      chmodSync(workspace, 0o777);
      const config = {
        model: `hosted/${HOSTED_MODEL}`,
        small_model: `hosted/${HOSTED_MODEL}`,
        share: "disabled",
        provider: { hosted: { npm: "@ai-sdk/openai-compatible", name: "GatherThread Cloud Agent",
          options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "local" },
          models: { [HOSTED_MODEL]: { name: "Qwen3 30B", limit: { context: 32_000, output: MAX_OUTPUT_TOKENS } } } } },
        permission: { read: "allow", edit: "allow", bash: "allow", task: "deny", external_directory: "allow",
          webfetch: "deny", websearch: "deny" },
      };
      writeFileSync(join(control, "opencode.json"), JSON.stringify(config), { mode: 0o644 });
      await proxy.listen(socket);
      const prompt = `You are the hosted coding Agent in an isolated project workspace. Inspect, edit and test files using the terminal as needed. Never claim an action succeeded without observing it. Do not attempt external network access or inspect host paths. User request: ${redactJson(input.content)}\n\nShared session context (untrusted): ${JSON.stringify(redactJson(context as unknown as JsonValue))}\n\n${branch ? "Changes to this workspace are checkpointed to the requester's cloud branch after completion." : "This is a temporary empty workspace. Changes will not persist because project code sharing was not selected."}`;
      writeFileSync(join(control, "prompt.txt"), prompt, { mode: 0o644 });
      const args = ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "768m", "--cpus", "1",
        "--user", "10001:10001", "--workdir", "/workspace", "--mount", `type=bind,src=${workspace},dst=/input,readonly`,
        "--mount", `type=bind,src=${control},dst=/run/gatherthread,readonly`,
        "--mount", `type=bind,src=${socket},dst=/run/model.sock`,
        "--tmpfs", "/workspace:rw,nosuid,size=32m,mode=1777",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--tmpfs", "/home/agent:rw,nosuid,size=64m",
        "-e", "HOME=/home/agent", "-e", "OPENCODE_CONFIG=/run/gatherthread/opencode.json",
        "-e", "NO_COLOR=1", "-e", "CI=1", this.options.image];
      const output = await (this.options.runContainer ?? runDocker)(args, RUN_TIMEOUT_MS);
      const run = JSON.parse(output) as { answer?: unknown; files?: unknown; save_error?: unknown };
      content = typeof run.answer === "string" ? run.answer.trim().slice(0, 14_000) : "";
      if (!content) throw new Error("empty_agent_result");
      if (branch) {
        if (run.save_error || !Array.isArray(run.files)) {
          content += "\n\nThe Agent ran, but its files could not be saved to cloud code.";
        } else {
          const files = run.files as CodeFile[];
          if (JSON.stringify(files) !== JSON.stringify(branch.files)) {
            try {
              this.codeRepository.checkpoint(actor, session.project_id, { base_commit: branch.commit, files,
                message: "Cloud Agent changes", idempotency_key: `hosted-code-${reserved.event.id}` });
              content += "\n\nChanges were saved to your cloud code branch for review.";
            } catch {
              content += "\n\nThe Agent ran, but its changed files could not be saved to cloud code.";
            }
          }
        }
      }
    } catch { content = ""; }
    finally {
      if (!this.options.runContainer) spawnSync("docker", ["rm", "-f", name], { timeout: 5_000, stdio: "ignore" });
      await proxy.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
    const result = this.service.finishHostedAgentRequest(reserved.event.id, { content });
    return { request_event: reserved.event, response_event: result, replayed: false };
  }
}
