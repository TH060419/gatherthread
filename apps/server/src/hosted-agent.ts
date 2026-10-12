import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cleanupHostedExecution, createHostedDockerClient, runHostedDockerCommand, stopHostedContainer } from "./hosted-agent-recovery.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Actor } from "./database.js";
import { isCodeSyncPathAllowed, HostedAgentSelectionSchema, type CanonicalEvent, type CloudApiPutInput, type CodeFile, type HostedAgentRequestInput, type HostedHistorySummaryInput, type JsonValue } from "@gatherthread/protocol";
import { ApiError } from "./errors.js";
import { redactJson } from "./redaction.js";
import type { CollaborationService } from "./service.js";
import type { CodeRepository } from "./code-repository.js";
import { hostedContainerCpuArguments, parseHostedCpuSet } from "./hosted-container-cpu.js";
import { hostedContainerMemoryArguments, validateHostedMemoryPolicy, type HostedMemoryPolicy } from "./hosted-container-memory.js";
import { createHostedContainerOutputDecoder, createHostedLiveOutputConsumer, hostedContainerResult, type HostedProgressCallback } from "./hosted-live-output.js";
import { CloudApiStore, isPersonalCloudProfile, cloudApiRunIsCurrent, PERSONAL_CLOUD_DAILY_RUNS, PERSONAL_CLOUD_GLOBAL_DAILY_RUNS } from "./cloud-api.js";

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
  memoryPolicy?: HostedMemoryPolicy;
  cpuSet?: string;
  personalApiEncryptionKey?: string;
  fetch?: typeof globalThis.fetch;
  runContainer?: (args: string[], timeoutMs: number, signal?: AbortSignal, onProgress?: HostedProgressCallback) => Promise<string>;
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

export function runDocker(args: string[], timeoutMs: number, outputLimit = 1_000_000, signal?: AbortSignal,
  onProgress?: HostedProgressCallback): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createHostedDockerClient();
    let child: ReturnType<typeof spawn>;
    try { child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: client.environment }); }
    catch (error) { client.close(); reject(error); return; }
    const progressLimit = args.includes("GT_HOSTED_REPOSITORY=1") ? 2 * 1024 * 1024 : 256_000;
    const output = createHostedContainerOutputDecoder(onProgress, progressLimit);
    let size = 0;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } child.kill("SIGKILL"); };
    const abort = () => fail(new Error("container_interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => fail(new Error("container_timeout")), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit + progressLimit) fail(new Error("container_output_too_large"));
      else { output.write(chunk); if (output.resultBytes() > outputLimit) fail(new Error("container_output_too_large")); }
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
      if (code === 0) {
        const result = output.finish();
        if (output.resultBytes() > outputLimit) reject(new Error("container_output_too_large"));
        else resolve(result);
      }
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
    const network = new AbortController();
    const abortNetwork = () => network.abort();
    request.once("aborted", abortNetwork); response.once("close", abortNetwork);
    const authorize = () => {
      try { network.signal.throwIfAborted(); this.options.signal?.throwIfAborted(); this.options.authorize?.(); }
      catch (error) { network.abort(); throw error; }
    };
    try {
      authorize();
      const native = this.options.endpoint.transport === "anthropic-messages";
      if (request.method !== "POST" || request.url !== (native ? "/v1/messages" : "/v1/chat/completions")
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
      authorize();
      this.calls += 1;
      this.spent += charge;
      delete body.max_completion_tokens;
      body.max_tokens = outputLimit;
      if (native) {
        // The existing execution output budget is intentionally unchanged.
        // Extended thinking requires a larger provider-specific token budget.
        delete body.n; delete body.thinking;
      } else body.n = 1;
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
        `${this.options.endpoint.baseUrl}/${native ? "messages" : "chat/completions"}`, {
          method: "POST", redirect: "error", signal: AbortSignal.any([network.signal, AbortSignal.timeout(30_000),
            ...(this.options.signal ? [this.options.signal] : [])]),
          headers: native ? { "x-api-key": this.options.endpoint.apiToken, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
            : { Authorization: `Bearer ${this.options.endpoint.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      authorize();
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
        authorize();
        sent += chunk.length;
        if (sent > 256_000) { network.abort(); response.destroy(); return; }
        if (!response.write(chunk)) await once(response, "drain", { signal: network.signal });
      }
      response.end();
    } catch (error) {
      if (upstreamAttempted && !network.signal.aborted && !this.options.signal?.aborted) {
        this.failure = error instanceof Error && error.name === "TimeoutError" ? "provider_timeout" : "provider_unavailable";
        this.options.onUnavailable?.(30_000);
      }
      network.abort();
      fail(502);
    } finally {
      request.off("aborted", abortNetwork); response.off("close", abortNetwork);
      network.abort();
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
  private readonly unsubscribeDeletion: () => void;
  readonly personalApi: CloudApiStore;
  constructor(private readonly service: CollaborationService, private readonly codeRepository: CodeRepository,
    private readonly options: HostedAgentOptions) {
    validateHostedEndpoints(options.endpoints);
    this.personalApi = new CloudApiStore(service.database, options.personalApiEncryptionKey);
    if (!/^(?:[-a-z0-9./_]+@)?sha256:[a-f0-9]{64}$/u.test(options.image)) {
      throw new Error("Cloud Agent needs a digest-pinned container image");
    }
    hostedContainerMemoryMiB("trial", options.memoryMiB);
    hostedContainerMemoryMiB("repository", options.repositoryMemoryMiB);
    validateHostedMemoryPolicy(options.memoryPolicy, options.maxConcurrent, options.cpuSet);
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
    this.unsubscribeDeletion = service.onEvent((event) => {
      if (event.type !== "message_deleted") return;
      for (const [requestId, controller] of this.controllers) {
        const job = service.database.sqlite.prepare("SELECT session_id FROM hosted_agent_runs WHERE request_event_id=?").get(requestId);
        if (job?.session_id === event.session_id) controller.abort();
      }
    });
  }

  close(): void { this.unsubscribeDeletion(); for (const controller of this.controllers.values()) controller.abort(); }

  status(actor: Actor) {
    const usage = this.service.database.hostedAgentUsage(actor, this.options.userDailyRuns, this.options.globalDailyRuns);
    const rateLimits = this.service.database.hostedAgentRateUsage(actor,
      this.options.userMinIntervalSeconds, this.options.userMaxConcurrent);
    const personalEndpoints = this.personalApi.status(actor).configurations.filter(c => c.enabled).flatMap(c => {
      try { return [this.personalApi.resolve(actor, c.profile_id, c.revision)]; } catch { return []; }
    });
    const allEndpoints = [...this.options.endpoints, ...personalEndpoints];
    const profiles = [...new Set(allEndpoints.map((e) => e.profileId))].map((id) => {
      const endpoints = allEndpoints.filter((e) => e.profileId === id);
      const first = endpoints[0]!;
      const profileUsage = first.personal ? this.service.database.hostedAgentUsage(actor, PERSONAL_CLOUD_DAILY_RUNS,
        PERSONAL_CLOUD_GLOBAL_DAILY_RUNS, "personal") : usage;
      const groups = [...new Map(endpoints.map((e) => [e.quotaGroup, e])).values()];
      const capacities = groups.map((endpoint) => {
        const used = this.service.database.hostedEndpointUsage(endpoint);
        return { remaining: endpoint.dailyRuns === null ? endpoint.maxConcurrent : Math.max(0, endpoint.dailyRuns - used.daily),
          slots: Math.max(0, endpoint.maxConcurrent - used.active),
          cooling: (this.cooldowns.get(endpoint.quotaGroup) ?? 0) > Date.now() };
      });
      const capacity = Math.min(Math.max(0, this.options.maxConcurrent - this.service.database.hostedActiveRuns()),
        capacities.reduce((n, c) => n + (c.cooling ? 0 : Math.min(c.remaining, c.slots)), 0));
      const dailyAvailable = (profileUsage.user_limit_runs === null || profileUsage.user_used_runs < profileUsage.user_limit_runs)
        && (profileUsage.global_limit_runs === null || profileUsage.global_used_runs < profileUsage.global_limit_runs);
      const status = !dailyAvailable || capacities.every((c) => !c.remaining) ? "daily_limit"
        : rateLimits.user_active_runs >= rateLimits.user_max_concurrent ? "user_busy"
        : rateLimits.retry_after_seconds > 0 ? "rate_limit"
        : capacity > 0 ? "available" : capacities.some((c) => c.cooling) ? "cooldown" : "busy";
      return { id, label: first.label, provider: first.provider, model: first.model,
        available: status === "available", capacity, status,
        ...(first.personal ? { source: "personal" as const, api_config_revision: first.personal.configRevision } : {}) };
    });
    return { enabled: true, harness: HOSTED_HARNESS, ...usage, rate_limits: rateLimits, profiles,
      capabilities: ["read_code", "edit_code", "terminal", "run_tests"],
      privacy: "Session text and opted-in GT Cloud code are sent to the selected model provider. Code runs in an isolated temporary container." };
  }

  putPersonalApi(actor: Actor, id: string, input: CloudApiPutInput) {
    const saved = this.personalApi.put(actor, id, input);
    this.abortChangedPersonalRuns();
    return saved;
  }

  removePersonalApi(actor: Actor, id: string, revision: string) {
    this.personalApi.remove(actor, id, revision);
    this.abortChangedPersonalRuns();
  }

  private abortChangedPersonalRuns() {
    for (const [requestId, controller] of this.controllers) {
      if (!cloudApiRunIsCurrent(this.service.database, requestId)) controller.abort();
    }
  }

  assertRunCurrent(requestId: string): void {
    if (!cloudApiRunIsCurrent(this.service.database, requestId)) {
      throw new ApiError(409, "cloud_api_changed", "Personal API configuration changed; start a new request");
    }
  }

  selection(actor: Actor, sessionId: string, requestId: string) {
    const database = this.service.database, session = database.requireSession(sessionId);
    const role = this.service.requireMembership(actor, sessionId);
    if (role === "viewer" || session.state !== "active" || session.mode === "solo" && session.owner_user_id !== actor.user_id) {
      throw new ApiError(403, "hosted_access_changed", "Cloud Agent access changed");
    }
    const job = database.sqlite.prepare("SELECT profile_id,provider,model FROM hosted_agent_runs WHERE request_event_id=? AND session_id=? AND user_id=?")
      .get(requestId, sessionId, actor.user_id) as { profile_id: string; provider: string; model: string } | undefined;
    if (!job) throw new ApiError(404, "hosted_request_unavailable", "Cloud Agent request is unavailable");
    database.assertRequestContextCurrent(sessionId, requestId);
    const event = database.getEvent(sessionId, requestId);
    const payload = event.payload as { profile_id?: unknown; execution_profile?: { provider?: unknown; model?: unknown } };
    if (event.type !== "agent_request" || event.actor_user_id !== actor.user_id || payload.profile_id !== job.profile_id
      || payload.execution_profile?.provider !== job.provider || payload.execution_profile.model !== job.model) {
      throw new ApiError(404, "hosted_request_unavailable", "Cloud Agent request is unavailable");
    }
    const pin = database.sqlite.prepare("SELECT user_id,config_id,config_revision FROM cloud_api_run_bindings WHERE request_event_id=?")
      .get(requestId) as { user_id: string; config_id: string; config_revision: string } | undefined;
    if (isPersonalCloudProfile(job.profile_id)) {
      if (!pin || pin.user_id !== actor.user_id || `api-${pin.config_id}` !== job.profile_id) {
        throw new ApiError(404, "hosted_request_unavailable", "Cloud Agent request is unavailable");
      }
      this.assertRunCurrent(requestId);
      const endpoint = this.personalApi.resolve(actor, job.profile_id, pin.config_revision);
      if (endpoint.provider !== job.provider || endpoint.model !== job.model) throw new ApiError(409, "cloud_api_changed", "Personal API configuration changed; start a new request");
      return HostedAgentSelectionSchema.parse({ profile_id: job.profile_id, api_config_revision: pin.config_revision });
    }
    if (pin) throw new ApiError(404, "hosted_request_unavailable", "Cloud Agent request is unavailable");
    if (!this.options.endpoints.some(endpoint => endpoint.profileId === job.profile_id && endpoint.provider === job.provider && endpoint.model === job.model)) {
      throw new ApiError(409, "hosted_profile_changed", "Cloud Agent model configuration changed; start a new request");
    }
    return HostedAgentSelectionSchema.parse({ profile_id: job.profile_id });
  }

  private endpointsFor(actor: Actor, input: HostedAgentRequestInput): HostedEndpoint[] {
    if (isPersonalCloudProfile(input.profile_id)) return [this.personalApi.resolve(actor, input.profile_id, input.api_config_revision)];
    if (input.api_config_revision !== undefined) throw new ApiError(400, "cloud_api_invalid", "A service model cannot use personal API configuration");
    return this.options.endpoints.filter(e => e.profileId === input.profile_id);
  }

  private limitsFor(endpoints: HostedEndpoint[]): HostedRunLimits {
    return endpoints[0]?.personal ? { ...this.options, userDailyRuns: PERSONAL_CLOUD_DAILY_RUNS,
      globalDailyRuns: PERSONAL_CLOUD_GLOBAL_DAILY_RUNS, billingSource: "personal" } : this.options;
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
    const endpoints = this.endpointsFor(actor, input);
    if (!endpoints.length || endpoints[0]!.provider === "cloudflare-workers-ai") {
      throw new ApiError(400, "github_model_unavailable", "Repository tasks require a DeepSeek or compatible API profile");
    }
    const result = this.service.reserveHostedAgentRequest(actor, sessionId, input,
      endpoints.map((e) => ({ ...e, blocked: (this.cooldowns.get(e.quotaGroup) ?? 0) > Date.now() })),
      this.limitsFor(endpoints), (event) => {
        if ((event.content_revision ?? 0) !== (context.content_revision ?? 0)) throw new ApiError(409,
          "context_changed", "Shared history changed while preparing the task; start a new request");
        onReserved(event);
      });
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
    const contentRevision = this.service.database.requireSession(sessionId).content_revision ?? 0;
    return this.start(actor, sessionId, { profile_id: input.profile_id, content: "Summarize selected history",
      include_code: false, idempotency_key: input.idempotency_key, content_revision: contentRevision,
      ...(input.api_config_revision ? { api_config_revision: input.api_config_revision } : {}) }, input);
  }

  pause(actor: Actor, sessionId: string, requestId: string) {
    const result = this.service.pauseHostedAgentRequest(actor, sessionId, requestId);
    this.controllers.get(requestId)?.abort();
    return result;
  }

  async request(actor: Actor, sessionId: string, input: HostedAgentRequestInput, onAccepted?: (event: CanonicalEvent) => void,
    summary?: HostedHistorySummaryInput) {
    if (input.github_task_id) throw new ApiError(400, "github_task_route_required", "Use the cloud repository task endpoint");
    const endpoints = this.endpointsFor(actor, input);
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
      endpoints.map((endpoint) => ({ ...endpoint, blocked: (this.cooldowns.get(endpoint.quotaGroup) ?? 0) > Date.now() })), this.limitsFor(endpoints), (event) => {
        if (context && (event.content_revision ?? 0) !== (context.content_revision ?? 0)) throw new ApiError(409,
          "context_changed", "Shared history changed while preparing the task; start a new request");
      }, summary);
    if (!reserved.created) return { request_event: reserved.event, replayed: true };
    const controller = new AbortController();
    this.controllers.set(reserved.event.id, controller);
    const contextWatch = setInterval(() => {
      if (!this.service.database.isRequestContextCurrent(sessionId, reserved.event.id)) controller.abort();
    }, 1000);
    contextWatch.unref();
    onAccepted?.(reserved.event);
    const endpoint = endpoints.find((e) => e.id === reserved.endpointId)!;
    const authorize = () => {
      controller.signal.throwIfAborted();
      this.service.database.assertRequestContextCurrent(sessionId, reserved.event.id);
      this.assertRunCurrent(reserved.event.id);
      this.service.database.assertActiveDevice(actor);
      const session = this.service.database.requireSession(sessionId), role = this.service.requireMembership(actor, sessionId);
      const job = this.service.database.sqlite.prepare("SELECT 1 FROM hosted_agent_runs WHERE request_event_id=? AND user_id=? AND device_id=? AND status='running'")
        .get(reserved.event.id, actor.user_id, actor.device_id);
      if (!job || this.service.database.isHostedAgentPaused(reserved.event.id) || role === "viewer" || session.state !== "active"
        || session.mode === "solo" && session.owner_user_id !== actor.user_id) throw new ApiError(403, "hosted_access_changed", "Cloud Agent access changed");
    };
    const authorizationWatch = setInterval(() => { try { authorize(); } catch { controller.abort(); } }, 2000);
    authorizationWatch.unref();
    let content = "";
    let errorCode: string | undefined;
    let root: string;
    try { root = mkdtempSync(join(tmpdir(), "gt-hosted-")); }
    catch {
      clearInterval(authorizationWatch);
      this.controllers.delete(reserved.event.id);
      clearInterval(contextWatch);
      const result = this.service.finishHostedAgentRequest(reserved.event.id, {});
      return { request_event: reserved.event, response_event: result, replayed: false };
    }
    const workspace = join(root, "workspace");
    const control = join(root, "control");
    const socket = join(root, "model.sock");
    const name = `gt-hosted-${randomBytes(8).toString("hex")}`;
    const live = createHostedLiveOutputConsumer((update) => controller.signal.aborted ? false
      : this.service.appendHostedAgentProgress(reserved.event.id, update));
    const proxy = new HostedModelProxy({ endpoint, signal: controller.signal, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      authorize,
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
        provider: { hosted: { npm: endpoint.transport === "anthropic-messages" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible", name: "GatherThread Cloud Agent",
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
      const args = ["run", "--rm", "--log-driver", "none", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128",
        ...hostedContainerMemoryArguments(memoryMiB, this.options.memoryPolicy),
        ...hostedContainerCpuArguments("trial", this.options.cpuSet, memoryMiB, this.options.memoryPolicy),
        "--user", "10001:10001", "--workdir", "/workspace", "--mount", `type=bind,src=${workspace},dst=/input,readonly`,
        "--mount", `type=bind,src=${control},dst=/run/gatherthread,readonly`,
        "--mount", `type=bind,src=${socket},dst=/run/model.sock`,
        "--tmpfs", "/workspace:rw,nosuid,size=32m,mode=1777",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--tmpfs", "/home/agent:rw,nosuid,size=64m",
        "-e", "HOME=/home/agent", "-e", "OPENCODE_CONFIG=/run/gatherthread/opencode.json",
        "-e", "OPENCODE_DISABLE_MODELS_FETCH=true", "-e", "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
        "-e", "NO_COLOR=1", "-e", "CI=1", this.options.image];
      authorize();
      const output = this.options.runContainer ? await this.options.runContainer(args, RUN_TIMEOUT_MS, controller.signal, live.accept)
        : await runDocker(args, RUN_TIMEOUT_MS, 1_000_000, controller.signal, live.accept);
      authorize();
      const run = JSON.parse(hostedContainerResult(output, live.accept)) as { answer?: unknown; files?: unknown; save_error?: unknown };
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
                message: "Cloud Agent changes", idempotency_key: `hosted-code-${reserved.event.id}` }, authorize);
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
        await live.finish(Boolean(content));
      } finally {
        clearInterval(authorizationWatch); clearInterval(contextWatch);
        await live.finish(false); this.controllers.delete(reserved.event.id);
      }
    }
    const result = this.service.finishHostedAgentRequest(reserved.event.id, {
      content, ...(errorCode ? { errorCode } : {}), providerAttempts: proxy.diagnostics().providerAttempts,
    });
    return { request_event: reserved.event, response_event: result, replayed: false };
  }
}
