import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cleanupHostedExecution, createHostedDockerClient, runHostedDockerCommand, stopHostedContainer } from "./hosted-agent-recovery.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Actor } from "./database.js";
import { isCodeSyncPathAllowed, type CanonicalEvent, type CodeFile, type HostedAgentRequestInput, type HostedHistorySummaryInput, type JsonValue } from "@gatherthread/protocol";
import { ApiError } from "./errors.js";
import { redactJson } from "./redaction.js";
import type { CollaborationService } from "./service.js";
import type { CodeRepository } from "./code-repository.js";
import { hostedContainerCpuArguments, parseHostedCpuSet } from "./hosted-container-cpu.js";

import { HOSTED_MODEL, validateHostedEndpoints, HOSTED_USER_MIN_INTERVAL_SECONDS, HOSTED_USER_MAX_CONCURRENT,
  isSiliconFlowFreeEndpoint,
  type HostedEndpoint, type HostedRunLimits } from "./hosted-agent-pool.js";
export { HOSTED_MODEL } from "./hosted-agent-pool.js";
export const HOSTED_HARNESS = "opencode";
const RUN_NEURONS = 2_000;
const MAX_MODEL_CALLS = 8;
const MAX_MODEL_BODY_BYTES = 64_000;
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_CONTEXT_BYTES = 12_000;
const MAX_WORKSPACE_FILES = 100;
const MAX_WORKSPACE_BYTES = 512_000;
const RUN_TIMEOUT_MS = 300_000;

export interface HostedAgentOptions extends HostedRunLimits {
  endpoints: HostedEndpoint[];
  image: string;
  memoryMiB?: number;
  repositoryMemoryMiB?: number;
  cpuSet?: string;
  fetch?: typeof globalThis.fetch;
  runContainer?: (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>;
}

/** Operators may tighten existing container limits, never silently expand them. */
export function hostedContainerMemoryMiB(kind: "trial" | "repository", value?: number): number {
  const maximum = kind === "trial" ? 768 : 2048;
  const memory = value === undefined ? maximum : value;
  if (!Number.isSafeInteger(memory) || memory < 256 || memory > maximum) {
    throw new Error(`Cloud ${kind} container memory must be an integer from 256 to ${maximum} MiB`);
  }
  return memory;
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

export function runDocker(args: string[], timeoutMs: number, outputLimit = 1_000_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createHostedDockerClient();
    let child: ReturnType<typeof spawn>;
    try { child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: client.environment }); }
    catch (error) { client.close(); reject(error); return; }
    let output = "";
    let size = 0;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } child.kill("SIGKILL"); };
    const abort = () => fail(new Error("container_interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => fail(new Error("container_timeout")), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) fail(new Error("container_output_too_large"));
      else output += chunk.toString("utf8");
    });
    let stderrSize = 0, stderrTail = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-512);
      if (stderrSize > 64_000) fail(new Error("container_output_too_large"));
    });
    child.once("error", (error) => { clearTimeout(timer); fail(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { client.close(); }
      catch { fail(new Error("container_client_cleanup_failed")); return; }
      if (settled) return;
      settled = true;
      if (code === 0) resolve(output);
      else reject(new Error(stderrTail.match(/(?:^|\n)GT_HOSTED_FAILURE:(agent_(?:startup|session|answer|idle|shutdown)_failed)\r?\n$/u)?.[1] ?? "container_failed"));
    });
  });
}

/** Only model egress: short-lived Unix socket with per-run request and Neuron caps. */
export class HostedModelProxy {
  private calls = 0;
  private failure: string | undefined;
  diagnostics() { return { providerAttempts: this.calls, errorCode: this.failure }; }
  private spent = 0;
  readonly server = createServer((request, response) => void this.forward(request, response));
  constructor(private readonly options: { endpoint: HostedEndpoint; fetch?: typeof globalThis.fetch;
    repositoryRun?: boolean;
    signal?: AbortSignal;
    authorize?: () => void;
    onUnavailable?: (retryAfterMs: number) => void }) {}

  async listen(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => { this.server.off("error", reject); resolve(); });
    });
    chmodSync(path, 0o666);
  }

  close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const fail = (code: number) => { if (!response.headersSent) response.writeHead(code).end(); else response.destroy(); };
    let upstreamAttempted = false;
    try {
      this.options.authorize?.();
      if (request.method !== "POST" || request.url !== "/v1/chat/completions"
        || request.headers["content-type"]?.split(";")[0] !== "application/json") return fail(404);
      const outputLimit = this.options.repositoryRun ? 2048 : MAX_OUTPUT_TOKENS;
      const bytes = await readBody(request, this.options.repositoryRun ? 128_000 : MAX_MODEL_BODY_BYTES);
      const body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (body.model !== this.options.endpoint.model || !Array.isArray(body.messages) || body.messages.length < 1
        || body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens)
          || (body.max_tokens as number) < 1 || (body.max_tokens as number) > outputLimit)) return fail(400);
      const charge = costUpperBound(bytes.length);
      if (this.calls >= (this.options.repositoryRun ? 64 : MAX_MODEL_CALLS) || this.options.endpoint.provider === "cloudflare-workers-ai" && this.spent + charge > RUN_NEURONS) return fail(429);
      // The untrusted body may arrive after access was revoked. Fence every
      // outbound call before charging or treating an error as provider failure.
      this.options.authorize?.();
      this.calls += 1;
      this.spent += charge;
      delete body.max_completion_tokens;
      body.max_tokens = outputLimit;
      body.n = 1;
      if (this.options.endpoint.provider === "deepseek") body.thinking = { type: "disabled" };
      if (isSiliconFlowFreeEndpoint(this.options.endpoint)
        && ["Qwen/Qwen3.5-4B", "Qwen/Qwen3-8B"].includes(this.options.endpoint.model)) {
        // SiliconFlow's answer cap excludes reasoning tokens. Interactive
        // trial models should answer directly rather than spend an unbounded
        // hidden-thinking budget; this does not change any local Agent setting.
        body.enable_thinking = false;
        delete body.thinking_budget;
      }
      upstreamAttempted = true;
      const upstream = await (this.options.fetch ?? globalThis.fetch)(
        `${this.options.endpoint.baseUrl}/chat/completions`, {
          method: "POST", redirect: "error", signal: this.options.signal
            ? AbortSignal.any([this.options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${this.options.endpoint.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      if (upstream.status === 429 || upstream.status >= 500 || upstream.status === 401 || upstream.status === 403) {
        const retry = upstream.headers.get("retry-after");
        const seconds = retry && /^\d+$/u.test(retry) ? Number(retry) : 60;
        this.options.onUnavailable?.(Math.max(30_000, Math.min(300_000, seconds * 1000)));
      }
      if (!upstream.ok) {
        this.failure = upstream.status === 401 || upstream.status === 403 ? "provider_auth_failed"
          : upstream.status === 429 ? "provider_rate_limited" : upstream.status >= 500 ? "provider_unavailable" : "provider_request_failed";
        return fail(upstream.status);
      }
      this.failure = undefined;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (!upstream.body) { response.end(); return; }
      let sent = 0;
      for await (const chunk of upstream.body) {
        sent += chunk.length;
        if (sent > 256_000) { response.destroy(); break; }
        response.write(chunk);
      }
      response.end();
    } catch (error) {
      if (upstreamAttempted && !this.options.signal?.aborted) {
        this.failure = error instanceof Error && error.name === "TimeoutError" ? "provider_timeout" : "provider_unavailable";
        this.options.onUnavailable?.(30_000);
      }
      fail(502);
    }
  }
}

function writeSnapshot(root: string, files: CodeFile[]): void {
  if (files.length > MAX_WORKSPACE_FILES || files.reduce((n, f) => n + Buffer.byteLength(f.content_base64, "base64"), 0) > MAX_WORKSPACE_BYTES) {
    throw new ApiError(413, "hosted_code_too_large", "Cloud Agent accepts at most 100 files and 500 KiB of code");
  }
  for (const file of files) {
    if (!isCodeSyncPathAllowed(file.path)) throw new Error("unsafe_snapshot_path");
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    // mkdir's mode is umask-filtered for every new ancestor. Only these
    // validated snapshot directories, not the private job root, are readable.
    let directory = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      directory = join(directory, part);
      chmodSync(directory, 0o755);
    }
    writeFileSync(path, Buffer.from(file.content_base64, "base64"), { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
    chmodSync(path, file.executable ? 0o755 : 0o644);
  }
}

export class HostedAgent {
  private readonly cooldowns = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly service: CollaborationService, private readonly codeRepository: CodeRepository,
    private readonly options: HostedAgentOptions) {
    validateHostedEndpoints(options.endpoints);
    if (!/^(?:[-a-z0-9./_]+@)?sha256:[a-f0-9]{64}$/u.test(options.image)) {
      throw new Error("Cloud Agent needs a digest-pinned container image");
    }
    hostedContainerMemoryMiB("trial", options.memoryMiB);
    hostedContainerMemoryMiB("repository", options.repositoryMemoryMiB);
    if (parseHostedCpuSet(options.cpuSet) !== undefined && options.maxConcurrent !== 1) {
      throw new Error("Cloud Agent CPU set mode requires maxConcurrent to be 1");
    }
    for (const [name, value, maximum] of [
      ["userDailyRuns", options.userDailyRuns, 10_000],
      ["globalDailyRuns", options.globalDailyRuns, 100_000],
      ["maxConcurrent", options.maxConcurrent, 8],
    ] as const) {
      if (value === null && name !== "maxConcurrent" && options.endpoints.every((e) => e.dailyRuns === null)) continue;
      if (value === null || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is out of range`);
    }
    const interval = options.userMinIntervalSeconds ?? HOSTED_USER_MIN_INTERVAL_SECONDS;
    const userConcurrency = options.userMaxConcurrent ?? HOSTED_USER_MAX_CONCURRENT;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 3600
      || !Number.isSafeInteger(userConcurrency) || userConcurrency < 1 || userConcurrency > options.maxConcurrent) {
      throw new Error("Cloud Agent user rate limits are out of range");
    }
  }

  status(actor: Actor) {
    const usage = this.service.database.hostedAgentUsage(actor, this.options.userDailyRuns, this.options.globalDailyRuns);
    const rateLimits = this.service.database.hostedAgentRateUsage(actor,
      this.options.userMinIntervalSeconds, this.options.userMaxConcurrent);
    const profiles = [...new Set(this.options.endpoints.map((e) => e.profileId))].map((id) => {
      const endpoints = this.options.endpoints.filter((e) => e.profileId === id);
      const first = endpoints[0]!;
      const groups = [...new Map(endpoints.map((e) => [e.quotaGroup, e])).values()];
      const capacities = groups.map((endpoint) => {
        const used = this.service.database.hostedEndpointUsage(endpoint);
        return { remaining: endpoint.dailyRuns === null ? endpoint.maxConcurrent : Math.max(0, endpoint.dailyRuns - used.daily),
          slots: Math.max(0, endpoint.maxConcurrent - used.active),
          cooling: (this.cooldowns.get(endpoint.quotaGroup) ?? 0) > Date.now() };
      });
      const capacity = Math.min(Math.max(0, this.options.maxConcurrent - this.service.database.hostedActiveRuns()),
        capacities.reduce((n, c) => n + (c.cooling ? 0 : Math.min(c.remaining, c.slots)), 0));
      const dailyAvailable = (usage.user_limit_runs === null || usage.user_used_runs < usage.user_limit_runs)
        && (usage.global_limit_runs === null || usage.global_used_runs < usage.global_limit_runs);
      const status = !dailyAvailable || capacities.every((c) => !c.remaining) ? "daily_limit"
        : rateLimits.user_active_runs >= rateLimits.user_max_concurrent ? "user_busy"
        : rateLimits.retry_after_seconds > 0 ? "rate_limit"
        : capacity > 0 ? "available" : capacities.some((c) => c.cooling) ? "cooldown" : "busy";
      return { id, label: first.label, provider: first.provider, model: first.model,
        available: status === "available", capacity, status };
    });
    return { enabled: true, harness: HOSTED_HARNESS, ...usage, rate_limits: rateLimits, profiles,
      capabilities: ["read_code", "edit_code", "terminal", "run_tests"],
      privacy: "Session text and opted-in GT Cloud code are sent to the selected model provider. Code runs in an isolated temporary container." };
  }

  private assertDockerReady(): void {
    if (this.options.runContainer) return;
    const ready = runHostedDockerCommand(["info", "--format", "{{.ServerVersion}}"], 5_000);
    const image = runHostedDockerCommand(["image", "inspect", this.options.image], 5_000);
    if (ready.status !== 0 || image.status !== 0) throw new ApiError(503, "hosted_runner_unavailable", "Cloud Agent execution is unavailable");
  }

  reserveRepository(actor: Actor, sessionId: string, input: HostedAgentRequestInput,
    onReserved: (event: CanonicalEvent) => void) {
    this.assertDockerReady();
    const context = this.service.readHistoryContext(actor, sessionId);
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES) {
      throw new ApiError(413, "hosted_context_too_large", "Cloud Agent needs a shorter conversation context");
    }
    const endpoints = this.options.endpoints.filter((e) => e.profileId === input.profile_id);
    if (!endpoints.length || endpoints[0]!.provider === "cloudflare-workers-ai") {
      throw new ApiError(400, "github_model_unavailable", "Repository tasks require a DeepSeek or compatible API profile");
    }
    const result = this.service.reserveHostedAgentRequest(actor, sessionId, input,
      endpoints.map((e) => ({ ...e, blocked: (this.cooldowns.get(e.quotaGroup) ?? 0) > Date.now() })),
      this.options, onReserved);
    return { ...result, endpoint: endpoints.find((e) => e.id === result.endpointId), context };
  }

  coolDown(quotaGroup: string, milliseconds: number) {
    this.cooldowns.set(quotaGroup, Date.now() + milliseconds);
  }

  /** Reply on durable acceptance; execution is not tied to an edge HTTP timeout. */
  start(actor: Actor, sessionId: string, input: HostedAgentRequestInput, summary?: HostedHistorySummaryInput) {
    const receipt = Promise.withResolvers<{ request_event: CanonicalEvent; replayed: boolean }>();
    void this.request(actor, sessionId, input, (event) => receipt.resolve({ request_event: event, replayed: false }), summary)
      .then((result) => receipt.resolve({ request_event: result.request_event, replayed: result.replayed }), receipt.reject);
    return receipt.promise;
  }

  startSummary(actor: Actor, sessionId: string, input: HostedHistorySummaryInput) {
    return this.start(actor, sessionId, { profile_id: input.profile_id, content: "Summarize selected history",
      include_code: false, idempotency_key: input.idempotency_key }, input);
  }

  pause(actor: Actor, sessionId: string, requestId: string) {
    const result = this.service.pauseHostedAgentRequest(actor, sessionId, requestId);
    this.controllers.get(requestId)?.abort();
    return result;
  }

  async request(actor: Actor, sessionId: string, input: HostedAgentRequestInput, onAccepted?: (event: CanonicalEvent) => void,
    summary?: HostedHistorySummaryInput) {
    if (input.github_task_id) throw new ApiError(400, "github_task_route_required", "Use the cloud repository task endpoint");
    const endpoints = this.options.endpoints.filter((e) => e.profileId === input.profile_id);
    if (!endpoints.length) throw new ApiError(400, "hosted_profile_unavailable", "Select an available cloud model in Agent settings");
    this.assertDockerReady();
    const session = this.service.database.requireSession(sessionId);
    const context = summary ? null : this.service.readHistoryContext(actor, sessionId);
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
    const reserved = this.service.reserveHostedAgentRequest(actor, sessionId, input,
      endpoints.map((endpoint) => ({ ...endpoint, blocked: (this.cooldowns.get(endpoint.quotaGroup) ?? 0) > Date.now() })), this.options, undefined, summary);
    if (!reserved.created) return { request_event: reserved.event, replayed: true };
    const controller = new AbortController();
    this.controllers.set(reserved.event.id, controller);
    onAccepted?.(reserved.event);
    const endpoint = endpoints.find((e) => e.id === reserved.endpointId)!;
    let content = "";
    let errorCode: string | undefined;
    let root: string;
    try { root = mkdtempSync(join(tmpdir(), "gt-hosted-")); }
    catch {
      this.controllers.delete(reserved.event.id);
      const result = this.service.finishHostedAgentRequest(reserved.event.id, {});
      return { request_event: reserved.event, response_event: result, replayed: false };
    }
    const workspace = join(root, "workspace");
    const control = join(root, "control");
    const socket = join(root, "model.sock");
    const name = `gt-hosted-${randomBytes(8).toString("hex")}`;
    const proxy = new HostedModelProxy({ endpoint, signal: controller.signal, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      authorize: () => {
        this.service.database.assertActiveDevice(actor);
        const session = this.service.database.requireSession(sessionId);
        const role = this.service.requireMembership(actor, sessionId);
        const job = this.service.database.sqlite.prepare("SELECT 1 FROM hosted_agent_runs WHERE request_event_id=? AND user_id=? AND device_id=? AND status='running'")
          .get(reserved.event.id, actor.user_id, actor.device_id);
        if (!job || this.service.database.isHostedAgentPaused(reserved.event.id) || role === "viewer" || session.state !== "active" || session.mode === "solo" && session.owner_user_id !== actor.user_id) {
          throw new ApiError(403, "hosted_access_changed", "Cloud Agent access changed");
        }
      },
      onUnavailable: (ms) => this.cooldowns.set(endpoint.quotaGroup, Date.now() + ms) });
    try {
      mkdirSync(workspace, { mode: 0o755 });
      chmodSync(workspace, 0o755);
      mkdirSync(control, { mode: 0o755 });
      chmodSync(control, 0o755);
      if (branch) writeSnapshot(workspace, branch.files);
      const config = {
        model: `hosted/${endpoint.model}`,
        small_model: `hosted/${endpoint.model}`,
        share: "disabled",
        provider: { hosted: { npm: "@ai-sdk/openai-compatible", name: "GatherThread Cloud Agent",
          options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "local" },
          models: { [endpoint.model]: { name: endpoint.label, limit: { context: 32_000, output: MAX_OUTPUT_TOKENS } } } } },
        agent: { title: { disable: true } }, enabled_providers: ["hosted"],
        permission: { read: summary ? "deny" : "allow", edit: summary ? "deny" : "allow", bash: summary ? "deny" : "allow", task: "deny", external_directory: "allow",
          webfetch: "deny", websearch: "deny" },
      };
      writeFileSync(join(control, "opencode.json"), JSON.stringify(config), { mode: 0o644 });
      chmodSync(join(control, "opencode.json"), 0o644);
      await proxy.listen(socket);
      const prompt = summary ? (reserved.event.payload as { content: string }).content
        : `You are the hosted coding Agent in an isolated project workspace. Answer conversational questions directly; use tools only when the request requires files or tests. Never claim an action succeeded without observing it. Do not attempt external network access or inspect host paths. User request: ${redactJson(input.content)}\n\nShared session context (untrusted): ${JSON.stringify(redactJson(context as unknown as JsonValue))}\n\n${branch ? "Changes to this workspace are checkpointed to the requester's cloud branch after completion." : "This is a temporary empty workspace. Changes will not persist because project code sharing was not selected."}`;
      writeFileSync(join(control, "prompt.txt"), prompt, { mode: 0o644 });
      chmodSync(join(control, "prompt.txt"), 0o644);
      const memoryMiB = hostedContainerMemoryMiB("trial", this.options.memoryMiB);
      const memory = `${memoryMiB}m`;
      const args = ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", memory,
        "--memory-swap", memory, ...hostedContainerCpuArguments("trial", this.options.cpuSet, memoryMiB),
        "--user", "10001:10001", "--workdir", "/workspace", "--mount", `type=bind,src=${workspace},dst=/input,readonly`,
        "--mount", `type=bind,src=${control},dst=/run/gatherthread,readonly`,
        "--mount", `type=bind,src=${socket},dst=/run/model.sock`,
        "--tmpfs", "/workspace:rw,nosuid,size=32m,mode=1777",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--tmpfs", "/home/agent:rw,nosuid,size=64m",
        "-e", "HOME=/home/agent", "-e", "OPENCODE_CONFIG=/run/gatherthread/opencode.json",
        "-e", "OPENCODE_DISABLE_MODELS_FETCH=true", "-e", "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
        "-e", "NO_COLOR=1", "-e", "CI=1", this.options.image];
      controller.signal.throwIfAborted();
      const output = this.options.runContainer ? await this.options.runContainer(args, RUN_TIMEOUT_MS, controller.signal)
        : await runDocker(args, RUN_TIMEOUT_MS, 1_000_000, controller.signal);
      controller.signal.throwIfAborted();
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
    } catch (error) {
      content = "";
      errorCode = proxy.diagnostics().errorCode ?? (error instanceof Error ? error.message : undefined);
    }
    finally {
      try {
        await cleanupHostedExecution(() => { if (!this.options.runContainer) stopHostedContainer(name); }, [
          () => proxy.close().catch(() => undefined), () => rmSync(root, { recursive: true, force: true }),
        ]);
      } finally { this.controllers.delete(reserved.event.id); }
    }
    const result = this.service.finishHostedAgentRequest(reserved.event.id, {
      content, ...(errorCode ? { errorCode } : {}), providerAttempts: proxy.diagnostics().providerAttempts,
    });
    return { request_event: reserved.event, response_event: result, replayed: false };
  }
}
