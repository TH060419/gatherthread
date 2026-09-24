export const DEFAULT_MCP_MESSAGE_BYTES = 1_048_576;
export const MAX_MCP_BATCH_REQUESTS = 128;

export function validateMessageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("MCP message size limit must be a positive integer");
  return value;
}

/** Validate the entire input before dispatching any member of a batch. */
export function payloadLimitError(payload: unknown): string | undefined {
  if (Array.isArray(payload) && payload.length > MAX_MCP_BATCH_REQUESTS) {
    return "Batch exceeds the request count limit";
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 50_000 || depth > 64) return "Message exceeds the JSON complexity limit";
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) {
        if (nodes + pending.length >= 50_000) return "Message exceeds the JSON complexity limit";
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return undefined;
}
