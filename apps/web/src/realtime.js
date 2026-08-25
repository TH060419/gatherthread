import { normalizeReplayPage } from "./domain.js";

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
    if (!this.#isCurrent(generation) || !Number.isInteger(cursor) || cursor <= this.cursor) return;
    this.cursor = cursor;
    this.#drainBuffer();
  }

  async #recover(generation, phase) {
    this.#setPhase(phase);
    let hasMore = true;
    while (hasMore && this.#isCurrent(generation)) {
      const cursorBeforePage = this.cursor;
      const page = normalizeReplayPage(
        await this.api.replayEvents(this.sessionId, {
          afterSequence: this.cursor,
          limit: this.pageSize,
        }),
      );
      if (!this.#isCurrent(generation)) return;
      let previousSequence = this.cursor;
      for (const event of page.events) {
        if (event.sequence <= this.cursor || this.eventIds.has(event.id)) continue;
        if (event.sequence <= previousSequence) {
          throw new Error("Replay events were not strictly ordered.");
        }
        this.#apply(event, false);
        previousSequence = event.sequence;
      }
      this.cursor = Math.max(this.cursor, page.nextAfterSequence);
      hasMore = page.hasMore;
      if (hasMore && this.cursor <= cursorBeforePage) {
        throw new Error("Replay cursor did not advance.");
      }
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
