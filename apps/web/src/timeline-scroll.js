const BOTTOM_TOLERANCE_PX = 24;
const USER_SCROLL_TOLERANCE_PX = 1;

/**
 * Whether the reader is at the newest end of the timeline. Auto-follow and the
 * back-to-bottom control must agree on where "the bottom" is, so both read this
 * one tolerance: a control that disagreed with the follow rule would offer to
 * scroll somewhere the reader already is, or hide when they are not there.
 */
export function isTimelineAtBottom(region) {
  const remaining = region.scrollHeight - region.scrollTop - region.clientHeight;
  return remaining <= BOTTOM_TOLERANCE_PX;
}

/** Bring the newest event back into view, on the reader's explicit request. */
export function scrollTimelineToBottom(region, behavior = "smooth") {
  region.scrollTo({ top: region.scrollHeight, behavior });
}

export function captureTimelineScroll(region, { automatic, followNewEvents }) {
  return Object.freeze({
    scrollTop: region.scrollTop,
    follow: Boolean(automatic && followNewEvents && isTimelineAtBottom(region)),
  });
}

export function settleTimelineScroll(region, snapshot, scheduleFrame = requestAnimationFrame) {
  region.scrollTop = snapshot.scrollTop;
  if (!snapshot.follow) return;
  scheduleFrame(() => {
    if (Math.abs(region.scrollTop - snapshot.scrollTop) > USER_SCROLL_TOLERANCE_PX) return;
    region.scrollTo({ top: region.scrollHeight, behavior: "smooth" });
  });
}
