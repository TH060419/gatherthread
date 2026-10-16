/** Display-only: canonical prompts and routing receipts are never modified. */
export function teamEventPresentation(event, events, t = text => text) {
  const request = event.type === "agent_request" ? event : event.type === "agent_response"
    ? events.find(candidate => candidate.id === event.replyTo && candidate.type === "agent_request") : null;
  const marker = request?.payload?.agent_team;
  if (!marker || event.deleted || event.contentUnavailable || request.deleted || request.contentUnavailable) return null;
  const label = `${t(marker.purpose === "test" ? "Team test" : "Team")} · ${marker.node_label}`;
  if (event.type === "agent_request") return { label, content: marker.purpose === "test"
    ? t("Checking this module's connection.") : marker.task_content };
  const text = event.payload?.content ?? event.payload?.text ?? event.content;
  if (typeof text !== "string") return { label };
  const testLines = text.trim().split(/\r?\n/u);
  if (marker.purpose === "test" && testLines[0] === `GT_TEAM_OK:${marker.node_id}:${marker.step_id}`
    && testLines.slice(1).every(line => /^GT_TEAM_ROUTE:[A-Za-z0-9._:-]+$/u.test(line))) {
    return { label, content: t("Module connection succeeded.") };
  }
  const block = /(?:^|\n)```gatherthread-team[ \t]*\r?\n([^]*?)\r?\n```\s*$/u.exec(text);
  if (!block) return { label };
  try {
    const decision = JSON.parse(block[1]);
    if (decision.version !== 1 || decision.step_id !== marker.step_id || !["complete", "delegate", "clarify"].includes(decision.action)) return { label };
    const fields = decision.action === "delegate" ? ["version", "step_id", "action", "target_node_id", "task"] : ["version", "step_id", "action"];
    if (Object.keys(decision).length !== fields.length || Object.keys(decision).some(key => !fields.includes(key))) return { label };
    if (decision.action === "delegate" && (typeof decision.target_node_id !== "string" || decision.target_node_id.length > 128
      || !/^[A-Za-z0-9._:-]+$/u.test(decision.target_node_id) || typeof decision.task !== "string"
      || !decision.task.trim() || decision.task.trim().length > 3000 || decision.task.includes("\0"))) return { label };
    return { label, content: text.slice(0, block.index).trimEnd() || t(decision.action === "clarify" ? "Awaiting clarification" : "Module finished.") };
  } catch { return { label }; }
}
