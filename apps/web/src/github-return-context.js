// Non-secret, single-use navigation hints. OAuth state/code and credentials are
// never stored here, and this data never grants access or changes membership.
const KEY = "gatherthread.github.return.v1";
const MAX_AGE_MS = 10 * 60_000;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(value);

export function rememberGithubReturn(storage, context, now = Date.now()) {
  try {
    storage?.removeItem(KEY);
    if (!identifier(context?.userId) || !identifier(context?.projectId)
      || context.sessionId != null && !identifier(context.sessionId)) return;
    storage?.setItem(KEY, JSON.stringify({ user_id: context.userId, project_id: context.projectId,
      session_id: context.sessionId ?? null, created_at: now }));
  } catch { /* Storage may be disabled. Sign-in itself remains available. */ }
}

export function consumeGithubReturn(storage, userId, now = Date.now()) {
  try {
    const raw = storage?.getItem(KEY);
    storage?.removeItem(KEY);
    if (!raw || raw.length > 600) return null;
    const value = JSON.parse(raw);
    if (!value || value.user_id !== userId || !identifier(value.project_id)
      || value.session_id !== null && !identifier(value.session_id)
      || !Number.isSafeInteger(value.created_at) || value.created_at > now || now - value.created_at > MAX_AGE_MS
      || Object.keys(value).some(key => !["user_id", "project_id", "session_id", "created_at"].includes(key))) return null;
    return { projectId: value.project_id, sessionId: value.session_id };
  } catch { return null; }
}
