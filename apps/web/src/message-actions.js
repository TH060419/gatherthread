export function messageText(event) {
  if (event?.deleted || event?.contentUnavailable) return "";
  const payload = event?.payload;
  return typeof payload?.content === "string" ? payload.content
    : typeof payload?.text === "string" ? payload.text : "";
}

export function agentWorkStatus(events, runtimeId) {
  if (!runtimeId) return null;
  const completed = new Set(events.filter((event) => event.type === "agent_response"
    || (event.type === "agent_progress" && event.payload?.status === "paused")).map((event) => event.replyTo));
  for (const event of events) if (event.type === "agent_request" && (event.deleted || event.contentUnavailable)) completed.add(event.id);
  const work = events.filter((event) => event.type === "agent_progress" && !completed.has(event.replyTo)
    && !event.deleted && !event.contentUnavailable
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

export function mountMessageActions({ document, api, localizer, getContext, selectSession, revealEvent, announce, deletionAction }) {
  const el = (id) => document.getElementById(id);
  const input = el("message-input"), picker = el("mention-picker"), dialog = el("mentions-dialog");
  document.body.append(picker); // Escapes the fixed composer's overflow and glass containing block.
  const t = (value) => localizer.t(value);
  let quote = null, mentions = [], previous = input.value, choices = [], active = 0, generation = 0, nextBeforeId = null;
  // Same-tab read preferences contain bounded IDs only, never message content.
  // A denied/full session store falls back to memory without affecting messages.
  const seenScopes = new Map();
  const readStorageKey = "gatherthread.mentions-read.v1";
  let readStorage;
  try {
    readStorage = document.defaultView?.sessionStorage;
    const raw = readStorage?.getItem(readStorageKey);
    if (raw && raw.length <= 6_000_000) {
      const stored = JSON.parse(raw);
      if (Array.isArray(stored) && stored.length <= 12) for (const item of stored) {
        if (Array.isArray(item) && typeof item[0] === "string" && item[0].length <= 1000
          && Array.isArray(item[1]) && item[1].length <= 2048
          && item[1].every(id => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(id))) {
          seenScopes.set(item[0], new Set(item[1]));
        }
      }
    }
  } catch { /* Invalid/denied storage is not a navigation or account failure. */ }
  let seen = new Set(), seenScope = "", jumpRequest = null;
  let latest = [], inboxEntries = [], inboxIdentity = "", paginated = false, pageLoading = false, refreshSequence = 0, initialized = false;
  const identity = (context = getContext()) => JSON.stringify([context.identityScope ?? "", context.userId, context.projectId]);
  function useSeenScope(context = getContext()) {
    const key = context.userId && context.projectId ? JSON.stringify([context.userId, context.projectId]) : "";
    if (key === seenScope) return;
    seenScope = key;
    if (!key) { seen = new Set(); return; }
    seen = seenScopes.get(key) ?? new Set();
    seenScopes.delete(key); seenScopes.set(key, seen);
    if (seenScopes.size > 12) seenScopes.delete(seenScopes.keys().next().value);
  }
  function unreadEntries() {
    useSeenScope();
    const context = getContext();
    return inboxIdentity === identity() ? inboxEntries.filter(event => {
      const current = event.session_id === context.sessionId ? context.events?.find(item => item.id === event.id) : null;
      return !seen.has(event.id) && !current?.deleted && !current?.contentUnavailable;
    }) : [];
  }
  function renderMentionControl() {
    const button = el("mentions-button"), count = unreadEntries().length;
    const loading = jumpRequest?.identity === identity();
    const caption = loading ? t("Locating mention…") : t("Mentioned you");
    const label = loading ? caption : `${count} · ${t("Jump to unread mention")}`;
    button.hidden = count === 0;
    button.disabled = Boolean(loading);
    button.title = label; button.setAttribute("aria-label", label);
    button.removeAttribute("aria-haspopup"); button.removeAttribute("aria-expanded");
    button.setAttribute("aria-controls", "timeline-region");
    if (loading) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
    el("mentions-count").textContent = count ? String(count) : "";
    if (el("mentions-label")) el("mentions-label").textContent = caption;
  }
  function rememberSeen(id) {
    seen.add(id);
    if (seen.size > 2048) seen.delete(seen.values().next().value);
  }
  function persistSeen() {
    try { readStorage?.setItem(readStorageKey, JSON.stringify([...seenScopes].map(([scope, ids]) => [scope, [...ids]]))); }
    catch { /* Keep the bounded in-memory preferences when browser storage is full. */ }
  }
  function mergeMentionHead(result) {
    const fresh = result.mentions, ids = new Set(fresh.map(event => event.id));
    if (!result.next_before_id) return fresh;
    const boundary = fresh.at(-1), cutoff = Date.parse(boundary?.created_at ?? "");
    const overlaps = latest.flatMap((event, index) => ids.has(event.id) ? [index] : []);
    const overlapEnd = overlaps.length ? Math.max(...overlaps) : -1;
    return [...fresh, ...inboxEntries.filter(event => {
      if (ids.has(event.id)) return false;
      // A full first page may push legitimate old entries below its window.
      // Prune only omissions proven to lie in the freshly authoritative window.
      const time = Date.parse(event.created_at ?? "");
      if (Number.isFinite(time) && Number.isFinite(cutoff)) {
        if (time > cutoff) return false;
        if (time < cutoff) return true;
        if (event.session_id === boundary.session_id && event.sequence >= boundary.sequence) return false;
      }
      const oldHeadIndex = latest.findIndex(old => old.id === event.id);
      return oldHeadIndex < 0 || overlapEnd < 0 || oldHeadIndex > overlapEnd;
    })];
  }
  function loadEarlierUnread() {
    if (initialized && nextBeforeId && !pageLoading && !unreadEntries().length) void refresh({ append: true });
  }
  function readVisible() {
    const context = getContext(), region = el("timeline-region");
    useSeenScope(context);
    if (!context.userId || !context.projectId || !context.sessionId || !region?.getBoundingClientRect
      || document.visibilityState === "hidden" || document.querySelector?.("dialog[open]")
      || region.getClientRects?.().length === 0 || region.closest?.("[hidden], [inert]")) return;
    const bounds = region.getBoundingClientRect(), view = document.defaultView;
    const clip = { top: Math.max(0, bounds.top), left: Math.max(0, bounds.left),
      right: Math.min(bounds.right, view?.innerWidth ?? bounds.right),
      bottom: Math.min(bounds.bottom, view?.innerHeight ?? bounds.bottom) };
    if (clip.bottom <= clip.top || clip.right <= clip.left) return;
    let changed = false;
    for (const event of context.events ?? []) {
      if (seen.has(event.id) || event.deleted || event.contentUnavailable
        || !event.payload?.mentions?.some(mention => mention?.user_id === context.userId)) continue;
      const card = el(`message-${event.id}`);
      if (!card || !region.contains?.(card) || card.getClientRects?.().length === 0
        || card.closest?.("[hidden], [inert]")) continue;
      const rect = card.getBoundingClientRect();
      const height = Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top);
      const width = Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left);
      if (rect.height > 0 && rect.width > 0 && height >= Math.min(48, rect.height) && width >= Math.min(80, rect.width)) {
        if (document.elementFromPoint) {
          const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
          const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
          const points = [[(left + right) / 2, (top + bottom) / 2], [left + 8, top + 8], [right - 8, bottom - 8]];
          if (!points.some(([x, y]) => card.contains(document.elementFromPoint(x, y)))) continue;
        }
        rememberSeen(event.id); changed = true;
      }
    }
    if (changed) persistSeen();
    renderMentionControl();
    if (changed) loadEarlierUnread();
  }
  async function jumpUnread() {
    if (jumpRequest?.identity === identity()) return;
    const context = getContext(), request = { identity: identity(context) };
    const event = unreadEntries().at(-1);
    if (!event || !context.projectId || !context.userId) return;
    jumpRequest = request; renderMentionControl(); announce(t("Locating mention…"));
    try {
      if (getContext().sessionId !== event.session_id) await selectSession(event.session_id);
      if (request.identity !== identity()) return;
      if (getContext().sessionId !== event.session_id) throw new Error("Session not opened");
      const located = await revealEvent(event.id, event.sequence);
      if (request.identity !== identity() || getContext().sessionId !== event.session_id) return;
      const source = getContext().events?.find(item => item.id === event.id);
      if (source?.deleted || source?.contentUnavailable) {
        inboxEntries = inboxEntries.filter(item => item.id !== event.id);
        throw new Error("Mention no longer available");
      }
      if (located === false) throw new Error("Mention not found");
      readVisible();
    } catch (error) {
      if (request.identity === identity()) {
        if (error?.status === 403 || error?.status === 404) inboxEntries = inboxEntries.filter(item => item.id !== event.id);
        announce(t("Unable to locate this message."));
      }
    } finally {
      if (jumpRequest === request) { jumpRequest = null; renderMentionControl(); }
    }
  }
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
    el("composer-quote").hidden = true; latest = []; inboxEntries = []; inboxIdentity = ""; paginated = false; pageLoading = false; nextBeforeId = null;
    el("mentions-count").textContent = ""; el("mentions-list").replaceChildren(); renderMentionControl();
    if (dialog.open) dialog.close();
  }
  function invalidateContent() {
    generation++; refreshSequence++;
    latest = []; inboxEntries = []; inboxIdentity = ""; paginated = false; pageLoading = false; nextBeforeId = null; initialized = false;
    el("mentions-count").textContent = ""; el("mentions-list").replaceChildren(); renderMentionControl();
    el("mentions-more").hidden = true; el("mentions-empty").hidden = false;
    if (quote) el("composer-quote-text").textContent = t("Refreshing history…");
  }
  function reconcileContent() {
    if (!quote) return;
    const source = getContext().events?.find(event => event.id === quote.id);
    if (!source || source.deleted) { quote = null; el("composer-quote").hidden = true; }
    else if (!source.contentUnavailable) el("composer-quote-text").textContent = `${source.actor.username}: ${messageExcerpt(source) || t("Message")}`;
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
    const context = getContext(), stamp = generation, request = ++refreshSequence;
    if (!context.projectId || !context.userId) return;
    useSeenScope(context);
    if (inboxIdentity && inboxIdentity !== identity(context)) {
      latest = []; inboxEntries = []; paginated = false; nextBeforeId = null; initialized = false;
    }
    const cursor = append ? nextBeforeId : undefined;
    let completed = false;
    pageLoading = true;
    if (append) el("mentions-more").disabled = true;
    try {
      const result = await api.listProjectMentions(context.projectId, cursor);
      if (request !== refreshSequence || stamp !== generation || identity() !== identity(context)) return;
      if (!append && initialized && result.mentions.some((event) => !seen.has(event.id) && !latest.some((old) => old.id === event.id))) {
        announce(t("You have a new mention."));
      }
      initialized = true;
      if (append || !paginated || !result.next_before_id) nextBeforeId = result.next_before_id;
      inboxEntries = append ? [...inboxEntries, ...result.mentions.filter((event) => !inboxEntries.some((old) => old.id === event.id))]
        : mergeMentionHead(result);
      if (!append) latest = result.mentions;
      inboxIdentity = identity(context);
      if (append) paginated = true;
      completed = true;
      renderMentionControl();
      if (dialog.open) {
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
              if (getContext().userId === context.userId && identity() === identity(context) && getContext().sessionId === event.session_id) {
                const located = await revealEvent(event.id, event.sequence);
                if (located === false) throw new Error("Mention not found");
                if (identity() === identity(context)) readVisible();
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
      if (request === refreshSequence && stamp === generation) {
        pageLoading = false; el("mentions-more").disabled = false;
        if (completed) loadEarlierUnread();
      }
    }
  }
  function openInbox() {
    refreshSequence++; inboxEntries = []; paginated = false; pageLoading = false; nextBeforeId = null;
    el("mentions-list").replaceChildren(); el("mentions-list").scrollTop = 0;
    dialog.showModal(); el("mentions-error").textContent = ""; void refresh();
  }
  el("mentions-button").addEventListener("click", () => void jumpUnread());
  el("mentions-close").addEventListener("click", () => dialog.close());
  el("mentions-more").addEventListener("click", () => void refresh({ append: true }));
  dialog.addEventListener("close", () => (el("mentions-button").hidden ? input : el("mentions-button")).focus({ preventScroll: true }));
  renderMentionControl();
  function actions(event) {
    const row = document.createElement("div"); row.className = "message-actions";
    if (event.deleted || event.contentUnavailable) return row;
    const currentEvent = () => getContext().events ? getContext().events.find(item => item.id === event.id) : event;
    row.append(icon("Copy message", "M8 8h12v12H8zM4 16V4h12", async () => {
      try {
        const source = currentEvent();
        if (!source || source.deleted || source.contentUnavailable) return;
        const text = messageText(source);
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(text); announce(t("Copied to clipboard."));
      } catch { announce(t("Copy failed. Select the message text to copy it.")); }
    }));
    if (getContext().writable && event.visibility !== "owner_only") row.append(icon("Quote message", "M9 6 3 12l6 6M3 12h10a7 7 0 0 1 7 7", () => {
      const source = currentEvent();
      if (!getContext().writable || !source || source.deleted || source.contentUnavailable) return;
      quote = { id: source.id, sessionId: getContext().sessionId };
      el("composer-quote-text").textContent = `${source.actor.username}: ${messageExcerpt(source) || t("Message")}`;
      el("composer-quote").hidden = false; input.focus();
    }));
    const deletion = deletionAction?.(event);
    if (deletion) row.append(deletion);
    return row;
  }
  function quoted(event, events) {
    if (!["human_chat", "agent_request"].includes(event.type) || !event.replyTo) return null;
    const target = events.find((item) => item.id === event.replyTo);
    const button = document.createElement("button"); button.type = "button"; button.className = "quoted-message";
    button.textContent = target?.deleted ? t("Original message deleted") : target?.contentUnavailable ? t("Refreshing history…")
      : target ? `${target.actor.username}: ${messageExcerpt(target) || t("Message")}` : t("Original message unavailable");
    button.disabled = !target || Boolean(target.deleted || target.contentUnavailable);
    button.addEventListener("click", () => { if (!button.disabled) revealEvent(target.id, target.sequence); });
    return button;
  }
  return { reset, refresh, actions, quoted, invalidateContent, reconcileContent, readVisible, jumpUnread, openInbox,
    metadata: () => ({ replyTo: quote?.sessionId === getContext().sessionId
      && (!getContext().events || getContext().events.some(event => event.id === quote.id && !event.deleted && !event.contentUnavailable)) ? quote.id : null,
      mentions: reconcileMentions(previous, input.value, mentions).slice(0, 32) }),
    sent: () => { quote = null; mentions = []; previous = input.value; el("composer-quote").hidden = true; picker.hidden = true; },
  };
}
