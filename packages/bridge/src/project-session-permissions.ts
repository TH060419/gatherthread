import { CollaborationHttpError } from "./http-client.js";
import type {
  ProjectHarnessAdapter,
  ProjectHarnessDeactivationReason,
  ProjectHarnessSessionBinding,
} from "./project-harness.js";
import type { SessionSummary } from "./types.js";

export interface ManagedPublishingBinding {
  deactivateLocalPublishing?: ProjectHarnessSessionBinding["deactivateLocalPublishing"];
}

/**
 * One authoritative write-eligibility rule shared by every project harness.
 * A project-level role alone is insufficient for personal Solo sessions.
 */
export function isSessionWritableBy(session: SessionSummary, actorUserId?: string): boolean {
  if (session.role === "viewer") return false;
  if (session.mode === "solo") {
    return session.ownerUserId === undefined
      ? session.role === "owner"
      : session.ownerUserId === actorUserId;
  }
  return session.role === "owner" || session.role === "participant";
}

export async function reconcileProjectSessionPermissions<T extends ManagedPublishingBinding>(input: {
  sessions: readonly SessionSummary[];
  actorUserId?: string;
  managed: Map<string, T>;
  harness: Pick<ProjectHarnessAdapter, "deactivateExecutionBindings">;
}): Promise<{
  visibleSessions: SessionSummary[];
  eligibleSessions: SessionSummary[];
  errors: Error[];
}> {
  const visibleSessions = input.sessions.filter((session) => session.state !== "archived");
  const eligibleSessions = visibleSessions.filter((session) =>
    isSessionWritableBy(session, input.actorUserId),
  );
  const eligibleIds = new Set(eligibleSessions.map((session) => session.id));
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const errors: Error[] = [];
  for (const [sessionId, current] of [...input.managed]) {
    if (eligibleIds.has(sessionId)) continue;
    input.managed.delete(sessionId);
    try {
      await current.deactivateLocalPublishing?.(projectSessionDeactivationReason(
        sessionsById.get(sessionId),
      ));
    } catch (error) {
      errors.push(error instanceof Error
        ? error
        : new Error("Local publishing deactivation failed"));
    }
  }
  try {
    await input.harness.deactivateExecutionBindings?.({
      retainSessionIds: [...input.managed.keys()],
      preserveSessionIds: [...eligibleIds],
    });
  } catch (error) {
    errors.push(error instanceof Error
      ? error
      : new Error("Execution allowlist reconciliation failed"));
  }
  return { visibleSessions, eligibleSessions, errors };
}

export async function refreshProjectSessionPermissions<T extends ManagedPublishingBinding>(input: {
  loadSessions: () => Promise<SessionSummary[]>;
  actorUserId?: string;
  managed: Map<string, T>;
  harness: Pick<ProjectHarnessAdapter, "deactivateExecutionBindings">;
}): Promise<
  | { status: "updated"; visibleSessions: SessionSummary[]; eligibleSessions: SessionSummary[]; errors: Error[] }
  | { status: "transient_failure"; error: unknown }
  | { status: "project_inaccessible"; error: CollaborationHttpError }
> {
  let sessions: SessionSummary[];
  try {
    sessions = await input.loadSessions();
  } catch (error) {
    return isProjectAccessRevoked(error)
      ? { status: "project_inaccessible", error }
      : { status: "transient_failure", error };
  }
  return {
    status: "updated",
    ...await reconcileProjectSessionPermissions({
      sessions,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      managed: input.managed,
      harness: input.harness,
    }),
  };
}

export function projectSessionDeactivationReason(
  session: SessionSummary | undefined,
): ProjectHarnessDeactivationReason {
  if (!session) return "removed";
  if (session.state === "archived") return "archived";
  return "read_only";
}

export function isProjectAccessRevoked(error: unknown): error is CollaborationHttpError {
  return error instanceof CollaborationHttpError
    && (error.status === 403 || error.status === 404);
}
