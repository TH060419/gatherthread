import { normalizeReplayPage } from "./domain.js?v=20261012-content-1";

const PHASE_DETAIL = {
  idle: "Choose a session to begin.",
  connecting: "Opening the live channel…",
  replaying: "Replaying committed history…",
  live: "Live and caught up.",
  recovering: "A sequence gap was found. Recovering from the event log…",
  offline: "The live connection was lost. Your draft is safe.",
  blocked: "History could not be made contiguous.",
};

export class SessionSync {
  constructor(api, { pageSize = 100, reconnectDelay = 1200 } = {}) {
    this.api = api;
    this.pageSize = pageSize;
    this.reconnectDelay = reconnectDelay;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.generation = (this.generation ?? 0) + 1;
    this.sessionId = null;
    this.phase = "idle";
    this.cursor = 0;
    this.events = [];
    this.contentRevision = 0;
    this.contentRefreshing = false;
    this.revisionEpoch = (this.revisionEpoch ?? 0) + 1;
    this.contentRefreshPromise = null;
    this.contentRefreshHead = 0;
    this.eventIds = new Set();
    this.buffer = new Map();
    this.socket?.close?.();
    this.socket = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      phase: this.phase,
      detail: PHASE_DETAIL[this.phase],
      cursor: this.cursor,
      events: [...this.events],
      contentRevision: this.contentRevision,
      contentRefreshing: this.contentRefreshing,
      bufferedCount: this.buffer.size,
    };
  }

  async connect(sessionId) {
    this.reset();
    this.sessionId = sessionId;
    const generation = this.generation;
    this.#setPhase("connecting");
    try {
      await this.#recover(generation, "replaying");
      if (!this.#isCurrent(generation)) return;
      await this.#openSocket(generation);
    } catch (error) {
      if (this.#isCurrent(generation)) this.#setPhase("blocked", error);
    }
  }

  async retry() {
    if (!this.sessionId) return;
    const generation = this.generation;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close?.();
    this.socket = null;
    this.#setPhase("connecting");
    try {
      await this.#recover(generation, "replaying");
      if (this.#isCurrent(generation)) await this.#openSocket(generation);
    } catch (error) {
      if (this.#isCurrent(generation)) this.#setPhase("blocked", error);
    }
  }

  disconnect() {
    this.reset();
    this.#emit();
  }

  /** Deletion receipts and socket controls invalidate every older read/cache. */
  async invalidateContent(receipt) {
    const revision = Number(receipt.contentRevision ?? receipt.content_revision ?? receipt.event?.payload?.content_revision);
    if (!this.sessionId || receipt.event?.sessionId !== this.sessionId || !Number.isSafeInteger(revision)
      || revision < this.contentRevision) return;
    if (revision === this.contentRevision && this.contentRefreshing) return this.contentRefreshPromise;
    if (revision === this.contentRevision && this.eventIds.has(receipt.event.id)) return;
    this.contentRevision = revision;
    this.revisionEpoch++;
    this.contentRefreshHead = Math.max(this.contentRefreshHead, this.cursor,
      Number.isSafeInteger(receipt.event?.sequence) ? receipt.event.sequence : 0);
    // The receipt's affected IDs are deliberately bounded. Until authoritative
    // replay finishes, no cached body, quote, tool or summary may be trusted.
    this.events = this.events.map(event => ({ ...event, payload: { content: "" }, provenance: null, contentUnavailable: true }));
    this.eventIds.clear();
    this.buffer.clear();
    this.cursor = 0;
    this.contentRefreshing = true;
    const generation = this.generation;
    const refresh = this.#recover(generation, "recovering").catch(error => {
      if (this.#isCurrent(generation)) this.#setPhase("blocked", error);
    });
    this.contentRefreshPromise = refresh;
    await refresh;
    if (this.contentRefreshPromise === refresh) this.contentRefreshPromise = null;
  }

  async #openSocket(generation) {
    const socket = await this.api.openRealtime({
      sessionId: this.sessionId,
      afterSequence: this.cursor,
      onEvent: (event) => this.#onSocketEvent(event, generation),
      onCursor: (cursor) => this.#onSocketCursor(cursor, generation),
      onState: (state) => this.#onSocketState(state, generation),
    });
    if (!this.#isCurrent(generation)) {
      socket.close?.();
      return;
    }
    this.socket = socket;
    if (this.phase !== "recovering") this.#setPhase("live");
  }

  #onSocketState(state, generation) {
    if (!this.#isCurrent(generation)) return;
    if (state === "live") {
      if (this.phase !== "recovering") this.#setPhase("live");
      return;
    }
    if (state === "offline") {
      this.#setPhase("offline");
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.retry(), this.reconnectDelay);
    }
  }

  #onSocketEvent(event, generation) {
    if (!this.#isCurrent(generation) || event.sessionId !== this.sessionId) return;
    const revision = Number(event.contentRevision ?? event.content_revision ?? event.payload?.content_revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < this.contentRevision) return;
    if (this.contentRefreshing && Number.isSafeInteger(event.sequence)) this.contentRefreshHead = Math.max(this.contentRefreshHead, event.sequence);
    if (revision > this.contentRevision || (event.type === "message_deleted" && !this.eventIds.has(event.id))) {
      void this.invalidateContent({ contentRevision: revision, event });
      return;
    }
    if (this.contentRefreshing) {
      // Keep only the head, never a body which may belong to a deleted snapshot.
      return;
    }
    if (event.sequence <= this.cursor || this.eventIds.has(event.id)) return;
    if (event.sequence === this.cursor + 1) {
      this.#apply(event);
      this.#drainBuffer();
      return;
    }

    this.buffer.set(event.sequence, event);
    if (this.phase !== "recovering") {
      this.#recover(generation, "recovering").catch((error) => {
        if (this.#isCurrent(generation)) this.#setPhase("blocked", error);
      });
    } else {
      this.#emit();
    }
  }

  #onSocketCursor(cursor, generation) {
    if (!this.#isCurrent(generation) || !Number.isSafeInteger(cursor) || cursor <= this.cursor) return;
    if (this.contentRefreshing) {
      this.contentRefreshHead = Math.max(this.contentRefreshHead, cursor);
      return;
    }
    this.cursor = cursor;
    this.#drainBuffer();
  }

  async #recover(generation, phase) {
    const epoch = this.revisionEpoch;
    const replacing = this.contentRefreshing;
    const replacement = [];
    const replacementIds = new Set();
    let replayCursor = this.cursor;
    this.#setPhase(phase);
    let hasMore = true;
    while (hasMore && this.#isCurrent(generation)) {
      const cursorBeforePage = replacing ? replayCursor : this.cursor;
      let rawPage;
      try {
        rawPage = await this.api.replayEvents(this.sessionId, {
          afterSequence: cursorBeforePage,
          limit: this.pageSize,
        });
      } catch (error) {
        if (!this.#isCurrent(generation) || epoch !== this.revisionEpoch) return;
        throw error;
      }
      if (!this.#isCurrent(generation) || epoch !== this.revisionEpoch) return;
      const page = normalizeReplayPage(rawPage);
      if (page.contentRevision < this.contentRevision) throw new Error("History changed. Retry to refresh the current messages.");
      if (page.contentRevision > this.contentRevision) {
        await this.invalidateContent({ contentRevision: page.contentRevision,
          event: { id: `revision-${page.contentRevision}`, sessionId: this.sessionId } });
        return;
      }
      let previousSequence = cursorBeforePage;
      for (const event of page.events) {
        if (event.sequence <= cursorBeforePage || (replacing ? replacementIds : this.eventIds).has(event.id)) continue;
        if (event.sequence <= previousSequence) {
          throw new Error("Replay events were not strictly ordered.");
        }
        const currentEvent = { ...event, contentRevision: page.contentRevision };
        if (replacing) { replacement.push(currentEvent); replacementIds.add(event.id); }
        else this.#apply(currentEvent, false);
        previousSequence = event.sequence;
      }
      if (replacing) replayCursor = Math.max(replayCursor, page.nextAfterSequence);
      else this.cursor = Math.max(this.cursor, page.nextAfterSequence);
      // A socket event can arrive after this page's HTTP snapshot was captured.
      // Authoritatively catch up to its sequence before atomically becoming live.
      hasMore = page.hasMore || (replacing && replayCursor < this.contentRefreshHead);
      if (hasMore && (replacing ? replayCursor : this.cursor) <= cursorBeforePage) {
        throw new Error("Replay cursor did not advance.");
      }
    }
    if (!this.#isCurrent(generation) || epoch !== this.revisionEpoch) return;
    if (replacing) {
      this.events = replacement;
      this.eventIds = replacementIds;
      this.cursor = replayCursor;
      this.contentRefreshing = false;
      this.contentRefreshHead = 0;
    }
    this.#drainBuffer(false);
    if (this.#isCurrent(generation)) this.#setPhase(this.buffer.size ? "blocked" : "live");
  }

  #drainBuffer(emit = true) {
    for (const sequence of this.buffer.keys()) {
      if (sequence <= this.cursor) this.buffer.delete(sequence);
    }
    while (this.buffer.has(this.cursor + 1)) {
      const event = this.buffer.get(this.cursor + 1);
      this.buffer.delete(this.cursor + 1);
      this.#apply(event, false);
    }
    if (emit) this.#emit();
  }

  #apply(event, emit = true) {
    this.events.push(event);
    this.eventIds.add(event.id);
    this.cursor = event.sequence;
    if (emit) this.#emit();
  }

  #setPhase(phase, error) {
    this.phase = phase;
    this.error = error;
    this.#emit();
  }

  #isCurrent(generation) {
    return generation === this.generation && Boolean(this.sessionId);
  }

  #emit() {
    const snapshot = this.snapshot();
    if (this.error) snapshot.error = this.error;
    for (const listener of this.listeners) listener(snapshot);
  }
}
