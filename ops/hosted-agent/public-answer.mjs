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
