export function messageText(event) {
  const payload = event?.payload;
  return typeof payload?.content === "string" ? payload.content
    : typeof payload?.text === "string" ? payload.text : "";
}

export function agentWorkStatus(events, runtimeId) {
  if (!runtimeId) return null;
  const completed = new Set(events.filter((event) => event.type === "agent_response").map((event) => event.replyTo));
  const work = events.filter((event) => event.type === "agent_progress" && !completed.has(event.replyTo)
    && event.provenance?.runtimeId === runtimeId).at(-1);
  return work ? work.payload?.status === "thinking" ? "Agent thinking" : "Agent busy" : null;
}

export function messageExcerpt(event) {
  const text = messageText(event).replace(/\s+/gu, " ");
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

export function mentionQuery(text, caret) {
  const match = /(?:^|\s)@([^@\n]{0,60})$/u.exec(text.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}

export function insertMention(text, range, member) {
  const label = `@${member.username}`;
  return { text: `${text.slice(0, range.start)}${label} ${text.slice(range.end)}`,
    caret: range.start + label.length + 1,
    mention: { user_id: member.userId, start: range.start, end: range.start + label.length } };
}

export function reconcileMentions(before, after, mentions) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const shift = newEnd - oldEnd;
  return mentions.flatMap((mention) => {
    if (mention.end <= start) return [mention];
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + shift, end: mention.end + shift }];
    return [];
  });
}

export function mountMessageActions({ document, api, localizer, getContext, selectSession, revealEvent, announce }) {
  const el = (id) => document.getElementById(id);
  const input = el("message-input"), picker = el("mention-picker"), dialog = el("mentions-dialog");
  document.body.append(picker); // Escapes the fixed composer's overflow and glass containing block.
  const t = (value) => localizer.t(value);
  let quote = null, mentions = [], previous = input.value, choices = [], active = 0, generation = 0, nextBeforeId = null;
  const seen = new Set(); // Session-only: no message content or private identity stored in Web Storage.
  let latest = [], inboxEntries = [], paginated = false, pageLoading = false, refreshSequence = 0, initialized = false;
  function icon(label, path, action) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "icon-button message-action";
    button.title = t(label); button.setAttribute("aria-label", t(label));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", path);
    svg.append(shape); button.append(svg); button.addEventListener("click", action);
    return button;
  }
  function reset() {
    generation++; quote = null; mentions = []; previous = input.value; picker.hidden = true;
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); initialized = false;
    el("composer-quote").hidden = true; latest = []; inboxEntries = []; paginated = false; pageLoading = false; nextBeforeId = null;
    el("mentions-count").textContent = ""; el("mentions-list").replaceChildren();
    if (dialog.open) dialog.close();
  }
  function choose(member) {
    const range = mentionQuery(input.value, input.selectionStart);
    if (!range || !getContext().writable) return;
    const result = insertMention(input.value, range, member);
    mentions = [...reconcileMentions(input.value, result.text, mentions), result.mention].sort((a, b) => a.start - b.start).slice(0, 32);
    input.value = previous = result.text;
    picker.hidden = true; input.setAttribute("aria-expanded", "false");
    input.focus(); input.setSelectionRange(result.caret, result.caret);
  }
  function updatePicker() {
    const range = mentionQuery(input.value, input.selectionStart);
    choices = range && getContext().writable ? (getContext().members ?? []).filter((member) =>
      member.username.toLocaleLowerCase().includes(range.query.toLocaleLowerCase())).slice(0, 12) : [];
    active = Math.min(active, Math.max(0, choices.length - 1));
    picker.replaceChildren(); picker.hidden = choices.length === 0;
    const rect = input.getBoundingClientRect();
    picker.style.left = `${rect.left}px`; picker.style.width = `${rect.width}px`;
    picker.style.maxHeight = `${Math.max(40, Math.min(220, rect.top - 12))}px`;
    picker.style.top = `${Math.max(8, rect.top - Math.min(220, choices.length * 40 + 8) - 8)}px`;
    input.setAttribute("aria-expanded", String(!picker.hidden));
    choices.forEach((member, index) => {
      const button = document.createElement("button"); button.type = "button";
      button.id = `mention-option-${index}`; button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === active));
      button.textContent = `@${member.username}`;
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => choose(member)); picker.append(button);
    });
    if (choices.length) input.setAttribute("aria-activedescendant", `mention-option-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }
  input.addEventListener("input", () => {
    mentions = reconcileMentions(previous, input.value, mentions); previous = input.value; active = 0; updatePicker();
  });
  input.addEventListener("click", updatePicker);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || picker.hidden) return;
    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Escape") { picker.hidden = true; input.setAttribute("aria-expanded", "false"); }
      else if (event.key === "Enter") choose(choices[active]);
      else { active = (active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length; updatePicker(); }
    }
  });
  input.addEventListener("blur", () => { picker.hidden = true; input.setAttribute("aria-expanded", "false"); });
  el("cancel-message-quote").addEventListener("click", () => { quote = null; el("composer-quote").hidden = true; input.focus(); });
  async function refresh({ append = false } = {}) {
    if (pageLoading) return;
    const context = getContext(), stamp = generation, request = ++refreshSequence, cursor = append ? nextBeforeId : undefined;
    if (!context.projectId || !context.userId) return;
    if (append) { pageLoading = true; el("mentions-more").disabled = true; }
    try {
      const result = await api.listProjectMentions(context.projectId, cursor);
      if (request !== refreshSequence || stamp !== generation || getContext().projectId !== context.projectId || getContext().userId !== context.userId) return;
      if (!append && initialized && result.mentions.some((event) => !seen.has(event.id) && !latest.some((old) => old.id === event.id))) {
        announce(t("You have a new mention."));
      }
      initialized = true;
      if (!append) latest = result.mentions;
      if (append || !paginated) nextBeforeId = result.next_before_id;
      const unread = latest.filter((event) => !seen.has(event.id));
      el("mentions-count").textContent = unread.length ? String(unread.length) : "";
      el("mentions-button").title = t("Mentions");
      if (dialog.open) {
        const ids = new Set(result.mentions.map((event) => event.id));
        inboxEntries = append ? [...inboxEntries, ...result.mentions.filter((event) => !inboxEntries.some((old) => old.id === event.id))]
          : [...result.mentions, ...inboxEntries.filter((event) => !ids.has(event.id))];
        if (append) paginated = true;
        const scrollTop = el("mentions-list").scrollTop;
        const focusedId = document.activeElement?.dataset?.mentionEventId;
        el("mentions-list").replaceChildren();
        for (const event of inboxEntries) {
          const item = document.createElement("li"), button = document.createElement("button");
          button.type = "button"; button.className = "mention-inbox-entry";
          button.dataset.mentionEventId = event.id;
          const heading = document.createElement("strong"); heading.textContent = `${event.session_title} · ${event.actor_display_name}`;
          const excerpt = document.createElement("span"); excerpt.textContent = event.excerpt;
          button.append(heading, excerpt);
          button.addEventListener("click", async () => {
            dialog.close();
            try {
              if (getContext().sessionId !== event.session_id) await selectSession(event.session_id);
              if (getContext().projectId === context.projectId && getContext().sessionId === event.session_id) {
                seen.add(event.id); revealEvent(event.id, event.sequence); void refresh();
              }
            } catch { announce(t("Unable to locate this message.")); }
          });
          item.append(button); el("mentions-list").append(item);
          if (event.id === focusedId) button.focus({ preventScroll: true });
        }
        el("mentions-list").scrollTop = scrollTop;
        el("mentions-empty").hidden = inboxEntries.length > 0;
        el("mentions-more").hidden = !nextBeforeId;
      }
    } catch {
      if (request === refreshSequence && stamp === generation && dialog.open) el("mentions-error").textContent = t("Unable to load mentions.");
    } finally {
      if (request === refreshSequence && stamp === generation) { pageLoading = false; el("mentions-more").disabled = false; }
    }
  }
  el("mentions-button").addEventListener("click", () => {
    refreshSequence++; inboxEntries = []; paginated = false; pageLoading = false; nextBeforeId = null;
    el("mentions-list").replaceChildren(); el("mentions-list").scrollTop = 0;
    dialog.showModal(); el("mentions-error").textContent = ""; void refresh();
  });
  el("mentions-close").addEventListener("click", () => dialog.close());
  el("mentions-more").addEventListener("click", () => void refresh({ append: true }));
  dialog.addEventListener("close", () => el("mentions-button").focus({ preventScroll: true }));
  function actions(event) {
    const row = document.createElement("div"); row.className = "message-actions";
    row.append(icon("Copy message", "M8 8h12v12H8zM4 16V4h12", async () => {
      try {
        const text = messageText(event);
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(text); announce(t("Copied to clipboard."));
      } catch { announce(t("Copy failed. Select the message text to copy it.")); }
    }));
    if (getContext().writable && event.visibility !== "owner_only") row.append(icon("Quote message", "M9 6 3 12l6 6M3 12h10a7 7 0 0 1 7 7", () => {
      quote = { id: event.id, sessionId: getContext().sessionId };
      el("composer-quote-text").textContent = `${event.actor.username}: ${messageExcerpt(event) || t("Message")}`;
      el("composer-quote").hidden = false; input.focus();
    }));
    return row;
  }
  function quoted(event, events) {
    if (!["human_chat", "agent_request"].includes(event.type) || !event.replyTo) return null;
    const target = events.find((item) => item.id === event.replyTo);
    const button = document.createElement("button"); button.type = "button"; button.className = "quoted-message";
    button.textContent = target ? `${target.actor.username}: ${messageExcerpt(target) || t("Message")}` : t("Original message unavailable");
    button.disabled = !target; button.addEventListener("click", () => revealEvent(target.id, target.sequence));
    return button;
  }
  return { reset, refresh, actions, quoted,
    metadata: () => ({ replyTo: quote?.sessionId === getContext().sessionId ? quote.id : null,
      mentions: reconcileMentions(previous, input.value, mentions).slice(0, 32) }),
    sent: () => { quote = null; mentions = []; previous = input.value; el("composer-quote").hidden = true; picker.hidden = true; },
  };
}
