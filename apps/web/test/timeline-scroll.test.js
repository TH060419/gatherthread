import test from "node:test";
import assert from "node:assert/strict";

import {
  captureTimelineScroll,
  isTimelineAtBottom,
  scrollTimelineToBottom,
  settleTimelineScroll,
} from "../src/timeline-scroll.js";

function timelineRegion({ scrollHeight = 1_000, scrollTop = 500, clientHeight = 400 } = {}) {
  const scrollCalls = [];
  return {
    scrollHeight,
    scrollTop,
    clientHeight,
    scrollCalls,
    scrollTo(options) {
      scrollCalls.push(options);
    },
  };
}

test("timeline does not auto-follow when a refresh adds no event", () => {
  const region = timelineRegion({ scrollTop: 590 });
  const snapshot = captureTimelineScroll(region, { automatic: true, followNewEvents: false });
  region.scrollTop = 0;
  let scheduled = false;
  settleTimelineScroll(region, snapshot, () => { scheduled = true; });
  assert.equal(region.scrollTop, 590);
  assert.equal(scheduled, false);
  assert.deepEqual(region.scrollCalls, []);
});

test("timeline follows an appended event only from the true bottom edge", () => {
  const region = timelineRegion({ scrollTop: 576 });
  const snapshot = captureTimelineScroll(region, { automatic: true, followNewEvents: true });
  region.scrollHeight = 1_200;
  const frames = [];
  settleTimelineScroll(region, snapshot, (callback) => frames.push(callback));
  assert.equal(region.scrollTop, 576);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(region.scrollCalls, [{ top: 1_200, behavior: "smooth" }]);

  const reading = timelineRegion({ scrollTop: 500 });
  const readingSnapshot = captureTimelineScroll(reading, { automatic: true, followNewEvents: true });
  settleTimelineScroll(reading, readingSnapshot, () => assert.fail("reader position must not schedule auto-follow"));
  assert.deepEqual(reading.scrollCalls, []);
});

test("the back-to-bottom control hides at the bottom and appears once the reader leaves it", () => {
  assert.equal(isTimelineAtBottom(timelineRegion({ scrollTop: 600 })), true);
  assert.equal(isTimelineAtBottom(timelineRegion({ scrollTop: 200 })), false);
});

test("the bottom tolerance keeps the control from flickering at the edge", () => {
  // Twenty-four pixels short of the end is still the end, so the control does
  // not blink in and out while the reader sits at the newest event.
  assert.equal(isTimelineAtBottom(timelineRegion({ scrollTop: 576 })), true);
  assert.equal(isTimelineAtBottom(timelineRegion({ scrollTop: 575 })), false);
});

test("a timeline with nothing to scroll is treated as being at the bottom", () => {
  assert.equal(isTimelineAtBottom(timelineRegion({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })), true);
});

test("activating the control returns the reader to the newest event", () => {
  const region = timelineRegion({ scrollTop: 0 });
  scrollTimelineToBottom(region);
  assert.deepEqual(region.scrollCalls, [{ top: 1_000, behavior: "smooth" }]);
});

test("a queued auto-follow is cancelled when the reader scrolls before the frame", () => {
  const region = timelineRegion({ scrollTop: 576 });
  const snapshot = captureTimelineScroll(region, { automatic: true, followNewEvents: true });
  const frames = [];
  settleTimelineScroll(region, snapshot, (callback) => frames.push(callback));
  region.scrollTop = 420;
  frames[0]();
  assert.deepEqual(region.scrollCalls, []);
});

test("summary/original reflow preserves the visible source anchor instead of a stale pixel position", () => {
  const region = timelineRegion({ scrollTop: 500 });
  region.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
  const card = (ids, top, height) => ({ dataset: { historyAnchor: ids },
    getBoundingClientRect: () => ({ top: top - region.scrollTop + 100, bottom: top - region.scrollTop + 100 + height }) });
  let cards = [card("old", 0, 50), card("a b", 480, 400)];
  region.querySelectorAll = () => cards;
  const snapshot = captureTimelineScroll(region, { automatic: false, followNewEvents: false, preserveAnchor: true });
  // Expanding history above the reader changes its height by 1000px.
  cards = [card("old", 0, 1050), card("a", 1480, 250), card("b", 1730, 150)];
  settleTimelineScroll(region, snapshot, () => assert.fail("display switching must not follow the bottom"));
  assert.equal(region.scrollTop, 1500);
  const originals = captureTimelineScroll(region, { automatic: false, followNewEvents: false, preserveAnchor: true });
  cards = [card("old", 0, 50), card("a b", 480, 400)];
  settleTimelineScroll(region, originals, () => assert.fail("display switching must not follow the bottom"));
  assert.equal(region.scrollTop, 500);
  assert.deepEqual(region.scrollCalls, []);
});
