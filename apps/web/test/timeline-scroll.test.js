import test from "node:test";
import assert from "node:assert/strict";

import { captureTimelineScroll, settleTimelineScroll } from "../src/timeline-scroll.js";

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

test("a queued auto-follow is cancelled when the reader scrolls before the frame", () => {
  const region = timelineRegion({ scrollTop: 576 });
  const snapshot = captureTimelineScroll(region, { automatic: true, followNewEvents: true });
  const frames = [];
  settleTimelineScroll(region, snapshot, (callback) => frames.push(callback));
  region.scrollTop = 420;
  frames[0]();
  assert.deepEqual(region.scrollCalls, []);
});
