import type { JsonValue } from "@agent-cooperation/protocol";

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

export function forbidden(message = "Insufficient session permissions"): ApiError {
  return new ApiError(403, "forbidden", message);
}

export function notFound(resource: string): ApiError {
  return new ApiError(404, "not_found", `${resource} not found`);
}

export function unauthorized(message = "A valid bearer token is required"): ApiError {
  return new ApiError(401, "unauthorized", message);
}
