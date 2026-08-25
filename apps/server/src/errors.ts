import type { JsonValue } from "@gatherthread/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "conflict", message);
}

export function idempotencyConflict(message = "Idempotency key is already bound to another operation"): ApiError {
  return new ApiError(409, "idempotency_conflict", message);
}

export function runtimeBusy(message = "Runtime already has an active agent request"): ApiError {
  return new ApiError(409, "runtime_busy", message);
}

export function agentRequestAlreadyClaimed(): ApiError {
  return new ApiError(409, "agent_request_already_claimed", "Agent request is already claimed by another runtime");
}

export function forbidden(message = "Insufficient session permissions"): ApiError {
  return new ApiError(403, "forbidden", message);
}

export function notFound(resource: string): ApiError {
  return new ApiError(404, "not_found", `${resource} not found`);
}

export function unauthorized(message = "A valid bearer token is required"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function storageQuotaExceeded(scope: "event" | "user" | "session" | "deployment", limitBytes: number): ApiError {
  return new ApiError(507, "storage_quota_exceeded", `${scope} event storage quota exceeded`, {
    scope,
    limit_bytes: limitBytes,
  });
}

export function snapshotStorageQuotaExceeded(
  scope: "result" | "user" | "session" | "deployment",
  limitBytes: number,
): ApiError {
  return new ApiError(507, "storage_quota_exceeded", `${scope} snapshot storage quota exceeded`, {
    resource: "snapshot",
    scope,
    limit_bytes: limitBytes,
  });
}
