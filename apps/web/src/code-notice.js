const NOTICE_KEY_PREFIX = "gatherthread.code-notice.v2:";

function noticeKey(deviceId) {
  return typeof deviceId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(deviceId)
    ? `${NOTICE_KEY_PREFIX}${deviceId}` : null;
}

export function codeNoticeStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function hasSeenCodeNotice(storage, deviceId) {
  const key = noticeKey(deviceId);
  if (!key) return false;
  try { return storage?.getItem?.(key) === "seen"; } catch { return false; }
}

export function markCodeNoticeSeen(storage, deviceId) {
  const key = noticeKey(deviceId);
  if (!key) return;
  try { storage?.setItem?.(key, "seen"); } catch { /* The notice will be shown next time. */ }
}
