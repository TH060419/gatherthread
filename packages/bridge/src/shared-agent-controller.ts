import { createHash, randomUUID } from "node:crypto";
import { AgentShareExecutionCapsuleSchema, type AgentShare, type AgentShareJob, type AgentShareExecutionCapsule,
  type AgentShareJobLeaseInput, type AgentShareJobProgressInput, type CompleteAgentShareJobInput, type AbortAgentShareJobInput } from "@gatherthread/protocol";
import { SharedExecutorCleanupUnconfirmedError, type SharedAgentExecutor } from "./shared-agent-executor.js";
import { assertSharedStoppedAcknowledgment, SharedStoppedReceiptOutbox, type SharedStoppedReceipt } from "./shared-stop-receipts.js";

export type SharedAgentAvailability = "ready" | "locked" | "offline" | "unsupported";
export type SharedAgentAvailabilityProbe = () => Promise<SharedAgentAvailability>;

export interface SharedAgentControlApi {
  listShares(projectId: string): Promise<{ shares: AgentShare[] }>;
  listJobs(projectId: string): Promise<{ jobs: AgentShareJob[] }>;
  claim(jobId: string, key: string): Promise<{ job: AgentShareJob; capsule: AgentShareExecutionCapsule; replayed: boolean }>;
  renewLease(jobId: string, input: AgentShareJobLeaseInput): Promise<{ job: AgentShareJob; lease_expires_at: string; deadline_at: string }>;
  progress(jobId: string, input: AgentShareJobProgressInput): Promise<unknown>;
  complete(jobId: string, input: CompleteAgentShareJobInput): Promise<unknown>;
  abortAck(jobId: string, input: AbortAgentShareJobInput): Promise<unknown>;
  reportAvailability(shareId: string, state: SharedAgentAvailability, key: string): Promise<unknown>;
  reportSourceAvailability(projectId: string, runtimeId: string, state: SharedAgentAvailability, key: string): Promise<unknown>;
}
export interface SharedAgentJobControllerOptions {
  projectId: string; sourceRuntimeId: string; ownerDeviceId: string;
  api: SharedAgentControlApi; executor: SharedAgentExecutor; availability?: SharedAgentAvailabilityProbe;
  signal?: AbortSignal; onError?: (error: Error) => void; now?: () => number;
  tickMs?: number; watchdogMs?: number;
  /** Production: a 0700 control directory outside the project. Omit only in in-memory tests. */
  privateStateRoot?: string;
}
interface ActiveSharedJob { capsule: AgentShareExecutionCapsule; abort: AbortController; settled: Promise<void>;
  lastContact: number; leaseUntil: number; timedOut: boolean; cleanupUnconfirmed?: boolean; }

/** Separate from ordinary native projection/claims; no owner transcript is read. */
export class SharedAgentJobController {
  readonly #options: SharedAgentJobControllerOptions; readonly #probe: SharedAgentAvailabilityProbe;
  readonly #rootAbort = new AbortController(); readonly #now: () => number;
  #active: ActiveSharedJob | undefined; #timer: ReturnType<typeof setInterval> | undefined;
  #tick: Promise<void> | undefined; #state: SharedAgentAvailability = "unsupported";
  #stopPromise: Promise<void> | undefined;
  #shares: AgentShare[] = []; #lastTick: number | undefined; #started = false;
  // Restart is itself an interruption. Even a healthy connection must commit an
  // OFF barrier before reporting READY, preserving manual re-enable semantics.
  #mustDisableShares = true;
  #reportedSource: SharedAgentAvailability | undefined;
  #availabilityRevision = 0;
  readonly #reported = new Map<string, string>(); readonly #cleanup = new Map<string, SharedStoppedReceipt>();
  readonly #outbox: SharedStoppedReceiptOutbox | undefined; #outboxLoaded = false;
  constructor(options: SharedAgentJobControllerOptions) {
    this.#options = options; this.#now = options.now ?? Date.now;
    // Production executors already passed isolation/preflight. Live transport,
    // exact-source authorization and renewable leases establish availability;
    // a desktop lock alone is not a connection outage.
    this.#probe = options.availability ?? (async () => "ready");
    this.#outbox = options.privateStateRoot ? new SharedStoppedReceiptOutbox(options.privateStateRoot) : undefined;
    options.signal?.addEventListener("abort", () => {
      void this.stop().catch(() => this.#options.onError?.(new Error("Shared Agent shutdown cleanup is unconfirmed")));
    }, { once: true });
  }
  start(): void {
    if (this.#started || this.#rootAbort.signal.aborted || this.#options.signal?.aborted) return;
    this.#started = true; void this.tick();
    this.#timer = setInterval(() => { void this.tick(); }, this.#options.tickMs ?? 2000); this.#timer.unref();
  }
  tick(): Promise<void> {
    if (this.#rootAbort.signal.aborted) return Promise.resolve();
    // Every timer checks the independent deadline even while control HTTP
    // is stalled. Contact cannot be refreshed by mere device heartbeat.
    this.#checkWatchdog();
    if (this.#tick) return this.#tick;
    const work = this.#tickOnce().catch((error: unknown) => {
      if (error !== null && typeof error === "object" && (error as { code?: unknown }).code === "agent_share_busy") return;
      this.#active?.abort.abort(new Error("Shared Agent authorization could not be verified"));
      this.#state = "offline"; this.#reported.clear(); this.#mustDisableShares = true; this.#availabilityRevision++;
      this.#options.onError?.(new Error("Shared Agent control is unavailable; shared execution was stopped"));
    });
    this.#tick = work;
    void work.finally(() => { if (this.#tick === work) this.#tick = undefined; });
    return work;
  }
  stop(): Promise<void> {
    return this.#stopPromise ??= this.#stopOnce();
  }
  async #stopOnce(): Promise<void> {
    this.#rootAbort.abort(new Error("Shared Agent connection stopped")); clearInterval(this.#timer);
    this.#active?.abort.abort(this.#rootAbort.signal.reason);
    // Let any in-flight READY report settle before the final OFF report.
    await this.#tick;
    const active = this.#active;
    await active?.settled;
    if (active?.cleanupUnconfirmed && this.#options.executor.close === undefined) throw new SharedExecutorCleanupUnconfirmedError();
    await this.#options.executor.close?.();
    if (active?.cleanupUnconfirmed) {
      await this.#recordStopped(active.capsule);
    }
    // A shutdown can race with a claim response before an executor is started.
    // These capsules also retain server capacity until an explicit cleanup ACK.
    await this.#loadOutbox();
    await Promise.allSettled([...this.#cleanup.values()].map(receipt => this.#ackStopped(receipt)));
    await Promise.allSettled([
      this.#options.api.reportSourceAvailability(this.#options.projectId, this.#options.sourceRuntimeId, "offline", randomUUID()),
      ...this.#shares.map(share => this.#options.api.reportAvailability(share.id, "offline", randomUUID())),
    ]);
  }
  #checkWatchdog(): void {
    const now = this.#now(), active = this.#active;
    const gap = this.#lastTick !== undefined && (now < this.#lastTick || now - this.#lastTick > Math.max(6000, (this.#options.tickMs ?? 2000) * 3));
    this.#lastTick = now;
    if (gap) { this.#mustDisableShares = true; this.#reported.clear(); this.#availabilityRevision++; }
    if (active && (gap || now >= active.leaseUntil || now - active.lastContact >= Math.min(this.#options.watchdogMs ?? 10000, 10000))) {
      active.abort.abort(new Error("Shared Agent authorization lease expired")); this.#reported.clear(); this.#mustDisableShares = true;
    }
    if (active && now >= Date.parse(active.capsule.deadline_at)) {
      active.timedOut = true; active.abort.abort(new Error("Shared Agent execution timed out"));
    }
  }
  async #tickOnce(): Promise<void> {
    await this.#loadOutbox();
    // Exact stopped receipts remain valid after their source/session/project is
    // removed. Report failures must not prevent that independent cleanup.
    await this.#flushStopped();
    const availabilityRevision = this.#availabilityRevision;
    const state = await this.#probe();
    if (this.#rootAbort.signal.aborted) return;
    if (state !== "ready") this.#active?.abort.abort(new Error("Shared Agent owner device is unavailable"));
    this.#state = state;
    const reportState = this.#mustDisableShares && state !== "locked" ? "offline" : state;
    if (this.#reportedSource !== reportState) {
      await this.#options.api.reportSourceAvailability(this.#options.projectId, this.#options.sourceRuntimeId, reportState, randomUUID());
      this.#reportedSource = reportState;
    }
    if (this.#rootAbort.signal.aborted) return;
    const { shares } = await this.#options.api.listShares(this.#options.projectId);
    if (this.#rootAbort.signal.aborted) return;
    this.#shares = shares.filter(share => share.source_runtime_id === this.#options.sourceRuntimeId
      && share.owner_device_id === this.#options.ownerDeviceId && share.project_id === this.#options.projectId);
    if (this.#mustDisableShares) {
      // A local sleep/contact failure must be committed as OFF before READY.
      // Otherwise a fast reconnect could hide the interruption from the server
      // and restore borrowing without the owner's manual re-enable.
      for (const share of this.#shares) await this.#options.api.reportAvailability(share.id, "offline", randomUUID());
      this.#mustDisableShares = false; this.#reported.clear();
      return;
    }
    for (const share of this.#shares) {
      const mark = `${share.revision}:${state}`;
      if (this.#reported.get(share.id) !== mark) {
        await this.#options.api.reportAvailability(share.id, state, randomUUID());
        this.#reported.set(share.id, mark);
      }
    }
    if (this.#active) {
      const active = this.#active, share = this.#shares.find(item => item.id === active.capsule.job.share_id);
      if (state !== "ready" || !share?.enabled || share.revision !== active.capsule.job.share_revision) {
        active.abort.abort(new Error("Shared Agent grant was withdrawn")); return;
      }
      if (active.abort.signal.aborted) return;
      const lease = await this.#options.api.renewLease(active.capsule.job.id, { claim_attempt: active.capsule.claim_attempt, idempotency_key: randomUUID() });
      if (lease.job.status !== "running" || lease.job.id !== active.capsule.job.id || lease.job.share_revision !== active.capsule.job.share_revision) {
        active.abort.abort(new Error("Shared Agent grant was withdrawn")); return;
      }
      active.lastContact = this.#now(); active.leaseUntil = Math.min(Date.parse(lease.lease_expires_at), active.lastContact + 10000);
      if (!Number.isFinite(active.leaseUntil)) active.abort.abort(new Error("Invalid shared execution lease"));
      return;
    }
    if (state !== "ready" || this.#rootAbort.signal.aborted || availabilityRevision !== this.#availabilityRevision) return;
    // `available` describes admission of a NEW borrower request. An accepted
    // queued/running job already owns its reserved slot/budget and may itself
    // make that flag false; only the atomic claim/lease can settle eligibility.
    const allowed = new Map(this.#shares.filter(share => share.enabled).map(share => [share.id, share]));
    if (!allowed.size) return;
    const { jobs } = await this.#options.api.listJobs(this.#options.projectId);
    const next = jobs.find(job => job.status === "queued" && allowed.get(job.share_id)?.revision === job.share_revision);
    if (!next || this.#rootAbort.signal.aborted) return;
    const claim = await this.#options.api.claim(next.id, `shared-claim:${createHash("sha256").update(`${this.#options.sourceRuntimeId}:${next.id}`).digest("hex")}`);
    const capsule = AgentShareExecutionCapsuleSchema.parse(claim.capsule);
    if (capsule.source_runtime_id !== this.#options.sourceRuntimeId || capsule.owner_device_id !== this.#options.ownerDeviceId
      || capsule.job.project_id !== this.#options.projectId || capsule.job.id !== next.id || capsule.job.status !== "running"
      || capsule.job.share_id !== next.share_id || capsule.job.share_revision !== next.share_revision || this.#rootAbort.signal.aborted
      || availabilityRevision !== this.#availabilityRevision) {
      await this.#recordStopped(capsule); throw new Error("Shared Agent capsule target mismatch");
    }
    const active: ActiveSharedJob = { capsule, abort: new AbortController(), settled: Promise.resolve(), lastContact: this.#now(),
      leaseUntil: Math.min(Date.parse(capsule.lease_expires_at), this.#now() + 10000), timedOut: false };
    this.#active = active;
    active.settled = this.#execute(active).finally(() => { if (this.#active === active && !active.cleanupUnconfirmed) this.#active = undefined; });
    void active.settled.catch(() => { this.#options.onError?.(new Error("Shared Agent settlement could not be confirmed")); });
  }
  async #execute(active: ActiveSharedJob): Promise<void> {
    const { capsule } = active, profile = capsule.job.execution_profile;
    let content = "The shared Agent could not complete this request.", outcome: CompleteAgentShareJobInput["outcome"] = "failed";
    try {
      if (!Number.isFinite(active.leaseUntil) || active.leaseUntil <= this.#now()) throw new Error("Invalid shared execution lease");
      const result = await this.#options.executor.execute(capsule, active.abort.signal);
      active.abort.signal.throwIfAborted();
      if (result.observedModel !== profile.model || result.observedReasoningEffort !== profile.reasoning_effort) throw new Error("Shared Agent execution route mismatch");
      content = result.content; outcome = "completed";
    } catch (error) {
      if (error instanceof SharedExecutorCleanupUnconfirmedError) {
        active.cleanupUnconfirmed = true; active.abort.abort(error); this.#mustDisableShares = true;
        this.#options.onError?.(new Error("Shared Agent native cleanup is unconfirmed; capacity remains reserved"));
        return;
      }
      if (active.timedOut) outcome = "timed_out";
    }
    try { await this.#recordStopped(capsule); }
    catch {
      active.cleanupUnconfirmed = true; active.abort.abort(new Error("Shared Agent stop receipt could not be persisted")); this.#mustDisableShares = true;
      this.#options.onError?.(new Error("Shared Agent cleanup receipt is unavailable; capacity remains reserved")); return;
    }
    if (active.abort.signal.aborted && !active.timedOut) {
      try { await this.#ackStopped(this.#cleanup.get(capsule.job.id)!); } catch { /* The durable outbox retries after reconnect. */ }
      return;
    }
    try {
      await this.#options.api.complete(capsule.job.id, { claim_attempt: capsule.claim_attempt,
        idempotency_key: `shared-complete:${capsule.job.id}:${capsule.claim_attempt}`, executor_stopped: true, outcome,
        observed_model: profile.model, ...(profile.reasoning_effort === undefined ? {} : { observed_reasoning_effort: profile.reasoning_effort }),
        payload: { content, status: outcome === "completed" ? "completed" : "failed",
          ...(outcome === "completed" ? { capture_fidelity: "harness_transcript", source_harness: profile.harness } : {}) } });
      await this.#forgetStopped(this.#cleanup.get(capsule.job.id)!);
    } catch { throw new Error("Shared Agent settlement unavailable"); }
  }
  async #loadOutbox(): Promise<void> {
    if (this.#outboxLoaded) return;
    for (const receipt of await this.#outbox?.list(this.#options) ?? []) this.#cleanup.set(receipt.jobId, receipt);
    this.#outboxLoaded = true;
  }
  async #recordStopped(capsule: AgentShareExecutionCapsule): Promise<void> {
    if (capsule.source_runtime_id !== this.#options.sourceRuntimeId || capsule.job.project_id !== this.#options.projectId
      || capsule.owner_device_id !== this.#options.ownerDeviceId) throw new Error("Shared cleanup receipt scope mismatch");
    const receipt: SharedStoppedReceipt = { version: 1, jobId: capsule.job.id, claimAttempt: capsule.claim_attempt,
      sourceRuntimeId: this.#options.sourceRuntimeId, projectId: this.#options.projectId, ownerDeviceId: this.#options.ownerDeviceId };
    await this.#outbox?.put(receipt); this.#cleanup.set(receipt.jobId, receipt);
  }
  async #forgetStopped(receipt: SharedStoppedReceipt): Promise<void> {
    await this.#outbox?.remove(receipt); this.#cleanup.delete(receipt.jobId);
  }
  async #ackStopped(receipt: SharedStoppedReceipt): Promise<void> {
    assertSharedStoppedAcknowledgment(receipt, await this.#options.api.abortAck(receipt.jobId, { claim_attempt: receipt.claimAttempt, executor_stopped: true,
      idempotency_key: `shared-abort:${receipt.jobId}:${receipt.claimAttempt}` })); await this.#forgetStopped(receipt);
  }
  async #flushStopped(): Promise<void> {
    for (const receipt of this.#cleanup.values()) if (receipt.jobId !== this.#active?.capsule.job.id) await this.#ackStopped(receipt);
  }
}
