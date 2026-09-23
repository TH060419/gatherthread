const NOTICE_KEY = "gatherthread.code-notice.v1";

export function codeNoticeStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function hasSeenCodeNotice(storage) {
  try { return storage?.getItem?.(NOTICE_KEY) === "seen"; } catch { return false; }
}

export function markCodeNoticeSeen(storage) {
  try { storage?.setItem?.(NOTICE_KEY, "seen"); } catch { /* The notice will be shown next time. */ }
}
