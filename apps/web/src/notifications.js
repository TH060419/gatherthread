export const INITIAL_CONNECTION_NOTICE_STATE = Object.freeze({
  sessionId: null,
  liveSeen: false,
  outageNotified: false,
});

const CONNECTION_LOSS_PHASES = new Set(["offline", "blocked"]);

export function advanceConnectionNotice(previous, snapshot, enabled) {
  const sessionId = snapshot?.sessionId ?? null;
  const sameSession = previous?.sessionId === sessionId;
  const priorLiveSeen = sameSession ? Boolean(previous?.liveSeen) : false;
  const priorOutageNotified = sameSession ? Boolean(previous?.outageNotified) : false;

  if (!enabled || !sessionId) {
    return {
      state: {
        sessionId,
        liveSeen: Boolean(enabled && sessionId && snapshot?.phase === "live"),
        outageNotified: false,
      },
      notify: false,
    };
  }

  if (snapshot?.phase === "live") {
    return {
      state: { sessionId, liveSeen: true, outageNotified: false },
      notify: false,
    };
  }

  const notify = priorLiveSeen
    && !priorOutageNotified
    && CONNECTION_LOSS_PHASES.has(snapshot?.phase);
  return {
    state: {
      sessionId,
      liveSeen: priorLiveSeen,
      outageNotified: priorOutageNotified || notify,
    },
    notify,
  };
}

export function notificationPermissionNeeded(notifications) {
  return Boolean(notifications?.agentCompleted || notifications?.connectionLost);
}
