const BOTTOM_TOLERANCE_PX = 24;
const USER_SCROLL_TOLERANCE_PX = 1;

export function captureTimelineScroll(region, { automatic, followNewEvents }) {
  const scrollTop = region.scrollTop;
  const remaining = Math.max(0, region.scrollHeight - scrollTop - region.clientHeight);
  return Object.freeze({
    scrollTop,
    follow: Boolean(automatic && followNewEvents && remaining <= BOTTOM_TOLERANCE_PX),
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
