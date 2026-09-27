import { eventContent, isFailedAgentResponse } from "./domain.js";
import {
  activeHistorySummaries, createHistorySummarySourceResolver, historySummaryMarker, historySummaryText,
  historySummaryVersions as validatedHistorySummaryVersions, isHistorySummaryRequest, selectHistorySummarySources,
  HISTORY_SUMMARY_MAX_SOURCE_BYTES,
} from "./history-summary-policy.js";

export const HISTORY_SUMMARY_MAX_EVENTS = 100;
export { HISTORY_SUMMARY_MAX_SOURCE_BYTES };
export const HISTORY_SUMMARY_MAX_INSTRUCTIONS = 4000;
const replyTo = (event) => event.replyTo ?? event.reply_to_event_id;
const publicEvent = (event) => event?.visibility === "session";
const sourceTypes = new Set(["human_chat", "agent_request", "agent_response"]);

export function historyWireEvents(events) {
  return events.map((event) => ({
    id: event.id, sequence: event.sequence, type: event.type, actor_user_id: event.actor?.id ?? event.actor_user_id,
    payload: event.payload, reply_to_event_id: replyTo(event), visibility: publicEvent(event) ? "session" : "owner_only",
  }));
}

export function historySummaryMetadata(event) {
  return publicEvent(event) ? historySummaryMarker(historyWireEvents([event])[0]) ?? null : null;
}

function historySummaryIndex(events) {
  const wire = historyWireEvents(events);
  const summaryIds = new Set();
  const nonemptyIds = new Set();
  const successfulResponseIds = new Set();
  const completedRequestIds = new Set();
  const firstResponseByRequest = new Map();
  const requests = [];
  for (let index = 0; index < wire.length; index += 1) {
    const item = wire[index];
    if (isHistorySummaryRequest(item)) summaryIds.add(item.id);
    if (item.visibility !== "session") continue;
    if (historySummaryText(item.payload).trim()) nonemptyIds.add(item.id);
    const metadata = historySummaryMarker(item);
    if (metadata) requests.push({ request: events[index], metadata });
    if (item.type !== "agent_response") continue;
    const parent = item.reply_to_event_id;
    if (parent && !firstResponseByRequest.has(parent)) firstResponseByRequest.set(parent, events[index]);
    // Match the shared leaf predicate exactly, without its per-source relation
    // scans. In particular, a defined error (even null/false) is not success.
    if (nonemptyIds.has(item.id) && item.payload?.error === undefined
      && (item.payload?.status === undefined || item.payload.status === "completed" || item.payload.status === "succeeded")) {
      successfulResponseIds.add(item.id);
      if (typeof parent === "string") completedRequestIds.add(parent);
    }
  }
  const validated = validatedHistorySummaryVersions(wire);
  const summaries = new Set(validated.map((version) => version.response.id));
  const eligible = events.filter((event) => publicEvent(event) && (summaryIds.has(replyTo(event))
    ? summaries.has(event.id)
    : sourceTypes.has(event.type) && nonemptyIds.has(event.id) && !summaryIds.has(event.id)
      && (event.type === "human_chat" || successfulResponseIds.has(event.id)
        || (event.type === "agent_request" && completedRequestIds.has(event.id)))));
  return { wire, eligible, validated, requests, firstResponseByRequest,
    sourceMap: new Map(eligible.map((event) => [event.id, event])) };
}

export function eligibleHistorySources(events) {
  return historySummaryIndex(events).eligible;
}

function versionsFromIndex({ sourceMap, validated, requests, firstResponseByRequest }) {
  const completed = new Map(validated.map((version) => [version.request.id, version]));
  const sourcesFor = createHistorySummarySourceResolver(validated);
  return requests.map(({ request, metadata }) => {
    const response = firstResponseByRequest.get(request.id);
    const sources = metadata.source_event_ids.map((id) => sourceMap.get(id)).filter(Boolean).sort((a, b) => a.sequence - b.sequence);
    const available = sources.length === metadata.source_event_ids.length && sources.every((event) => event.sequence < request.sequence);
    const status = !response ? "pending" : isFailedAgentResponse(response) || response.payload?.error
      || (response.payload?.status && !["completed", "succeeded"].includes(response.payload.status))
      || !eventContent(response).trim() ? "failed" : "completed";
    const version = completed.get(request.id);
    const coverage = version ? sourcesFor(version).map((id) => sourceMap.get(id))
      .filter(Boolean).sort((a, b) => a.sequence - b.sequence) : sources;
    return { id: request.id, request, response, metadata, sources, coverage, available, status };
  }).sort((a, b) => (b.response?.sequence ?? b.request.sequence) - (a.response?.sequence ?? a.request.sequence));
}

export function historySummaryVersions(events) {
  return versionsFromIndex(historySummaryIndex(events));
}

// Choose whole versions, never a partial summary of overlapping source sets.
// Originals remain canonical and become selectable again in selection mode.
export function historySummaryTimeline(events, { original = false, selecting = false, expanded = new Set() } = {}) {
  const index = historySummaryIndex(events);
  const versions = versionsFromIndex(index);
  const activeIds = new Set(activeHistorySummaries(index.wire).map((version) => version.request.id));
  const active = versions.filter((version) => activeIds.has(version.id));
  const requestIds = new Set(versions.map((version) => version.id));
  const hidden = new Set(events.filter((event) => requestIds.has(event.id) || requestIds.has(replyTo(event))).map((event) => event.id));
  const before = new Map();
  const add = (id, version) => before.set(id, [...(before.get(id) ?? []), version]);
  if (!original && !selecting) {
    for (const version of active) {
      add(version.coverage[0].id, version);
      if (!expanded.has(version.id)) version.coverage.forEach((event) => hidden.add(event.id));
    }
  }
  for (const version of versions) {
    if (version.status !== "completed" || selecting) add(version.id, version);
  }
  return { versions, active, hidden, before };
}

export function selectedHistorySourceIds(events, selected) {
  return eligibleHistorySources(events).filter((event) => selected.has(event.id)).sort((a, b) => a.sequence - b.sequence).map((event) => event.id);
}

export function historySelectionError(events, ids) {
  if (ids.length < 1 || ids.length > HISTORY_SUMMARY_MAX_EVENTS || new Set(ids).size !== ids.length) {
    return "Select between 1 and 100 messages or summaries.";
  }
  try { selectHistorySummarySources(historyWireEvents(events), ids); return ""; }
  catch (error) { return error.code === "too_large"
    ? "Selected history exceeds 20 KiB. Select fewer messages; nothing will be truncated."
    : "Some selected sources are no longer available. Select them again."; }
}

export function historySummaryExecutionWire(profile) {
  if (!profile?.runtimeId) throw new Error("Choose an exact online Agent runtime before generating a summary.");
  return {
    harness: profile.harness,
    model: profile.model,
    runtime_id: profile.runtimeId,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    ...(profile.reasoningEffort === undefined ? {} : { reasoning_effort: profile.reasoningEffort }),
  };
}
