import { createIdempotencyKey, eventContent } from "./domain.js";
import { eligibleHistorySources, historySelectionError, historySummaryTimeline, selectedHistorySourceIds } from "./history-summaries.js";

/** Derived display state is tab-local. It never edits canonical history or drafts. */
export function mountHistorySummaries({ document, api, localizer, getContext, onChange, renderMarkdown }) {
  const el = (id) => document.getElementById(id);
  const t = (text) => localizer.t(text);
  const confirmation = el("history-summary-confirm-dialog");
  const versionsDialog = el("history-summary-versions-dialog");
  const selected = new Set();
  const expanded = new Set();
  let selecting = false;
  let original = false;
  let scope;
  let attempt = null;
  let confirmationAttempt = null;
  let accepted = null;
  let error = "";
  let returnFocus = null;
  let eligibleIds = new Set();
  let pendingOwnSummary = false;

  function context() { return getContext(); }
  function events() {
    const loaded = context().events;
    return accepted && !loaded.some((event) => event.id === accepted.id) ? [...loaded, accepted] : loaded;
  }
  const fingerprint = (profile) => JSON.stringify(profile);
  const sameScope = (value) => value && value.scope === context().scope;
  function busy() {
    return Boolean(attempt || pendingOwnSummary);
  }
  function canGenerate() { return context().writable && Boolean(context().executionProfile); }
  function icon(label, glyph, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button workspace-icon-button history-summary-icon";
    button.setAttribute("aria-label", t(label));
    button.title = t(label);
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = glyph;
    button.append(mark);
    button.addEventListener("click", action);
    return button;
  }
  function closeConfirmation() {
    confirmationAttempt = null;
    if (confirmation.open) confirmation.close();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function reset() {
    scope = context().scope;
    selecting = false;
    original = false;
    selected.clear();
    expanded.clear();
    attempt = null;
    accepted = null;
    error = "";
    returnFocus = null;
    pendingOwnSummary = false;
    closeConfirmation();
    if (versionsDialog.open) versionsDialog.close();
    el("history-summary-versions").replaceChildren();
  }
  function updateContext() {
    if (scope !== context().scope) reset();
    if (attempt) {
      const receipt = context().events.find((event) => event.idempotencyKey === attempt.idempotencyKey);
      if (receipt) { accepted = receipt; attempt = null; error = ""; selecting = false; selected.clear(); }
    }
    if (!context().writable) {
      selecting = false;
      selected.clear();
      closeConfirmation();
    }
    const eligible = new Set(eligibleHistorySources(context().events).map((event) => event.id));
    eligibleIds = eligible;
    for (const id of selected) if (!eligible.has(id)) selected.delete(id);
    const versions = historySummaryTimeline(events()).versions;
    pendingOwnSummary = versions.some((version) => version.status === "pending" && version.request.actor?.id === context().userId);
    el("history-summary-select-button").hidden = !context().writable;
    el("history-summary-select-button").disabled = !canGenerate() || busy() || !eligible.size;
    el("history-summary-select-button").setAttribute("aria-pressed", String(selecting));
    el("history-summary-view-button").hidden = versions.length === 0;
    el("history-summary-versions-button").hidden = versions.length === 0;
    const viewLabel = original ? "Show summaries" : "Show original messages";
    el("history-summary-view-button").setAttribute("aria-label", t(viewLabel));
    el("history-summary-view-button").title = t(viewLabel);
    el("history-summary-view-button").setAttribute("aria-pressed", String(original));
    el("history-summary-toolbar").hidden = !selecting && !attempt;
    el("history-summary-count").textContent = `${selected.size} / 100 · ${t("messages selected")}`;
    const selectionError = selecting ? historySelectionError(context().events, selectedHistorySourceIds(context().events, selected)) : "";
    el("history-summary-generate-button").disabled = !canGenerate() || Boolean(selectionError) || busy();
    el("history-summary-cancel-button").disabled = Boolean(attempt);
    el("history-summary-resend-button").hidden = !attempt || attempt.sending;
    el("history-summary-resend-button").disabled = !canGenerate() || fingerprint(context().executionProfile) !== fingerprint(attempt?.executionProfile);
    el("history-summary-status").textContent = t(error || (selected.size ? selectionError : ""));
    el("history-summary-confirm-button").disabled = !confirmationAttempt || Boolean(attempt?.sending)
      || !canGenerate() || !sameScope(confirmationAttempt)
      || fingerprint(context().executionProfile) !== fingerprint(confirmationAttempt.executionProfile);
    if (versionsDialog.open) renderVersions();
  }
  function changeSelection(ids = []) {
    if (!canGenerate() || busy()) return;
    selected.clear();
    ids.forEach((id) => selected.add(id));
    selecting = true;
    error = "";
    if (versionsDialog.open) versionsDialog.close();
    onChange();
    el("history-summary-count").focus({ preventScroll: true });
  }
  function prepare() {
    if (!canGenerate() || busy()) return;
    const ids = selectedHistorySourceIds(context().events, selected);
    error = historySelectionError(context().events, ids);
    if (error) { updateContext(); return; }
    confirmationAttempt = {
      scope: context().scope, sessionId: context().sessionId, sourceEventIds: ids,
      executionProfile: structuredClone(context().executionProfile), instructions: context().instructions,
      idempotencyKey: createIdempotencyKey("history-summary"), sending: false,
    };
    showConfirmation();
  }
  function showConfirmation() {
    const profile = confirmationAttempt.executionProfile;
    el("history-summary-confirm-target").textContent = [profile.harness, profile.provider, profile.model, profile.reasoningEffort,
      profile.runtimeId].filter(Boolean).join(" · ");
    el("history-summary-confirm-count").textContent = `${confirmationAttempt.sourceEventIds.length} · ${t("messages selected")}`;
    returnFocus = document.activeElement;
    confirmation.showModal();
    updateContext();
    el("history-summary-confirm-cancel").focus();
  }
  async function submit() {
    const frozen = confirmationAttempt;
    if (!sameScope(frozen) || !canGenerate() || attempt?.sending
      || fingerprint(context().executionProfile) !== fingerprint(frozen.executionProfile)) return;
    error = historySelectionError(context().events, frozen.sourceEventIds);
    if (error) { closeConfirmation(); updateContext(); return; }
    attempt = frozen;
    frozen.sending = true;
    closeConfirmation();
    updateContext();
    try {
      const receipt = await api.createHistorySummary(frozen.sessionId, frozen);
      if (!sameScope(frozen) || attempt !== frozen) return;
      accepted = receipt;
      attempt = null;
      selected.clear();
      selecting = false;
      error = "";
    } catch (failure) {
      if (!sameScope(frozen) || attempt !== frozen) return;
      frozen.sending = false;
      const uncertain = !failure.status || failure.status >= 500;
      if (!uncertain) attempt = null;
      error = uncertain ? "Summary acceptance is uncertain. Retry this same request safely; do not start another generation."
        : failure.status === 413 ? "Selected history exceeds 20 KiB. Select fewer messages; nothing will be truncated."
          : [401, 403, 404].includes(failure.status) ? "Summary generation is no longer available in this session. Check your access and reopen it."
            : failure.status === 409 ? "The summary request could not start. Check your selected Agent and pending requests, then try again."
              : failure.status === 400 ? "Some selected sources or summary instructions are no longer valid. Review the selection and settings."
                : "Unable to request a history summary.";
    } finally {
      if (sameScope(frozen)) onChange();
    }
  }
  function sourceControl(event) {
    if (!selecting || !eligibleIds.has(event.id)) return null;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "history-source-checkbox";
    input.checked = selected.has(event.id);
    input.disabled = Boolean(attempt) || (!input.checked && selected.size >= 100);
    input.setAttribute("aria-label", `${t(event.payload?.history_summary ? "Select summary" : "Select message")} #${event.sequence}`);
    input.dataset.sourceEventId = event.id;
    input.addEventListener("change", () => {
      if (input.checked && selected.size < 100) selected.add(event.id);
      else selected.delete(event.id);
      updateContext();
      // Keep focused checkboxes mounted while enabling/disabling the cap.
      for (const checkbox of document.querySelectorAll(".history-source-checkbox")) {
        checkbox.checked = selected.has(checkbox.dataset.sourceEventId);
        checkbox.disabled = Boolean(attempt) || (!checkbox.checked && selected.size >= 100);
      }
    });
    return input;
  }
  function card(version, { list = false } = {}) {
    const article = document.createElement("article");
    article.className = "event-card history-summary-card";
    article.dataset.summaryRequestId = version.id;
    article.dataset.state = version.status;
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = t(version.status === "completed" ? "History summary" : version.status === "failed" ? "Summary failed" : "Summary pending");
    const controls = document.createElement("div");
    controls.className = "history-summary-actions";
    if (!list && version.status === "completed") controls.append(icon(expanded.has(version.id) ? "Show summary" : "Show selected originals", "⇄", () => {
      if (expanded.has(version.id)) expanded.delete(version.id); else expanded.add(version.id);
      onChange();
    }));
    if (context().writable && version.status !== "pending") {
      const regenerate = icon("Select sources to regenerate with my Agent", "↻", () => changeSelection(version.metadata.source_event_ids));
      regenerate.disabled = !version.available || !canGenerate() || busy();
      controls.append(regenerate);
    }
    header.append(title, controls);
    if (version.response && version.status === "completed") {
      const checkbox = sourceControl(version.response);
      if (checkbox) {
        checkbox.setAttribute("aria-label", `${t("Select summary")} #${version.response.sequence}`);
        header.prepend(checkbox);
      }
    }
    const attribution = document.createElement("p");
    attribution.className = "history-summary-meta";
    attribution.textContent = `${version.request.actor?.username ?? ""} · #${version.request.sequence} · ${version.metadata.source_event_ids.length} ${t("source messages")}`;
    article.append(header, attribution);
    if (version.status === "completed") {
      const disclaimer = document.createElement("p");
      disclaimer.className = "history-summary-note";
      disclaimer.textContent = t("Derived, lossy summary. Original messages are preserved.");
      article.append(disclaimer);
      if (list || !expanded.has(version.id)) {
        const body = renderMarkdown(eventContent(version.response));
        // A summary remains shared user content in the versions dialog too.
        // UI language changes must not translate matching words in its body.
        body.setAttribute("data-i18n-skip", "");
        article.append(body);
      }
    } else {
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = t(version.status === "pending"
        ? "Waiting for the selected local Agent. A new generation is unavailable until this request finishes."
        : "Summary generation failed. Originals are unchanged. Select them to retry with your current Agent.");
      article.append(status);
    }
    if (list) {
      const sources = document.createElement("p");
      sources.className = "history-summary-meta";
      sources.textContent = version.available ? version.sources.map((event) => `#${event.sequence}`).join(", ")
        : t("Some originals are not available in the loaded history.");
      article.append(sources);
    }
    return article;
  }
  function renderVersions() {
    const list = el("history-summary-versions");
    list.replaceChildren();
    for (const version of historySummaryTimeline(events()).versions) {
      const item = document.createElement("li");
      item.append(card(version, { list: true }));
      list.append(item);
    }
  }
  el("history-summary-select-button").addEventListener("click", () => changeSelection());
  el("history-summary-cancel-button").addEventListener("click", () => {
    if (attempt) return;
    selecting = false; selected.clear(); error = ""; onChange();
    el("history-summary-select-button").focus({ preventScroll: true });
  });
  el("history-summary-generate-button").addEventListener("click", prepare);
  el("history-summary-resend-button").addEventListener("click", () => {
    if (!attempt || attempt.sending) return;
    confirmationAttempt = attempt; showConfirmation();
  });
  el("history-summary-confirm-button").addEventListener("click", submit);
  el("history-summary-confirm-cancel").addEventListener("click", closeConfirmation);
  confirmation.addEventListener("cancel", (event) => { event.preventDefault(); closeConfirmation(); });
  el("history-summary-view-button").addEventListener("click", () => { original = !original; onChange(); });
  el("history-summary-versions-button").addEventListener("click", () => { renderVersions(); versionsDialog.showModal(); });
  el("history-summary-versions-close").addEventListener("click", () => versionsDialog.close());
  versionsDialog.addEventListener("close", () => {
    if (context().sessionId) el("history-summary-versions-button").focus({ preventScroll: true });
  });
  return {
    reset, updateContext, sourceControl, card,
    timeline: () => historySummaryTimeline(events(), { original, selecting, expanded }),
    // Receipts are already canonical but do not advance the realtime cursor.
    events,
  };
}
