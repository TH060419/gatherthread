/** OpenCode 1.18.32 JSON events: publish assistant text only, never tool data. */
export function publicAnswer(output) {
  const parts = new Map();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error("agent_failed");
    if (event.type === "text" && event.part?.type === "text"
      && typeof event.part.id === "string" && typeof event.part.text === "string") {
      parts.set(event.part.id, event.part.text);
    }
  }
  const answer = [...parts.values()].join("\n\n").trim();
  if (!answer) throw new Error("empty_agent_answer");
  return answer.slice(0, 14_000);
}

/** Accept only the authoritative, completed response from OpenCode's prompt API. */
export function publicSessionAnswer(reply, sessionID) {
  const info = reply?.info;
  if (info?.role !== "assistant" || info.sessionID !== sessionID || typeof info.id !== "string"
    || !info.id || !Number.isFinite(info.time?.completed) || info.time.completed <= 0
    || info.error !== undefined || !["stop", "length"].includes(info.finish) || !Array.isArray(reply.parts)) {
    throw new Error("agent_failed");
  }
  const parts = new Map();
  for (const part of reply.parts) {
    if (part?.type !== "text" || part.synthetic || part.ignored) continue;
    if (part.sessionID !== sessionID || part.messageID !== info.id || typeof part.id !== "string"
      || !part.id || typeof part.text !== "string" || parts.has(part.id)) throw new Error("agent_failed");
    parts.set(part.id, part.text);
  }
  const answer = [...parts.values()].join("\n\n").trim();
  if (!answer) throw new Error("empty_agent_answer");
  return answer.slice(0, 14_000);
}

export function sessionIsIdle(status, sessionID) {
  return Boolean(status && typeof status === "object" && !Array.isArray(status)
    && (!Object.hasOwn(status, sessionID) || status[sessionID]?.type === "idle"));
}
