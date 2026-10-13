import { AgentTeamRequestMetadataSchema, AgentTeamDirectiveSchema } from "@gatherthread/protocol";

/** A presentation projection only. Copy, quote and replay retain the canonical event. */
export function teamMessagePresentation(event, events, content) {
  if (event.deleted || event.contentUnavailable) return null;
  const request = event.type === "agent_request" ? event : event.type === "agent_response"
    ? events.find(candidate => candidate.id === event.replyTo && candidate.type === "agent_request") : null;
  if (!request || request.deleted || request.contentUnavailable || typeof request.actor?.id !== "string" || request.actor.id !== event.actor?.id) return null;
  const metadata = AgentTeamRequestMetadataSchema.safeParse(request.payload?.agent_team);
  if (!metadata.success) return null;
  const base = { ...metadata.data, ownerId: request.actor.id };
  if (event.type === "agent_request") return { ...base, content: metadata.data.task_content, details: content, kind: "instructions" };
  if (event.payload?.status === "failed" || typeof content !== "string") return { ...base, content, details: null, kind: null };
  const blocks = [...content.matchAll(/^```gatherthread-team[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gmu)];
  if (blocks.length !== 1 || !content.trimEnd().endsWith(blocks[0][0]) || blocks[0][1].length > 15000) return { ...base, content, details: null, kind: null };
  try {
    const directive = AgentTeamDirectiveSchema.parse(JSON.parse(blocks[0][1]));
    if (directive.step_id !== metadata.data.step_id) return { ...base, content, details: null, kind: null };
    return { ...base, content: content.slice(0, blocks[0].index).trimEnd(), details: blocks[0][0], kind: "routing" };
  } catch { return { ...base, content, details: null, kind: null }; }
}
