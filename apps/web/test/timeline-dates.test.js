import test from "node:test";
import assert from "node:assert/strict";

import { calendarDayKey, formatFullTimestamp, formatTimelineDay } from "../src/timeline-dates.js";

const localDay = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour);

test("timeline labels follow local calendar days across midnight", () => {
  const now = localDay(2026, 9, 27, 0);
  assert.equal(formatTimelineDay(localDay(2026, 9, 27, 0), "zh-CN", now), "今天");
  assert.equal(formatTimelineDay(localDay(2026, 9, 26, 23), "zh-CN", now), "昨天");
  assert.equal(formatTimelineDay(localDay(2026, 9, 25), "zh-CN", now), "星期五");
  assert.equal(formatTimelineDay(localDay(2026, 9, 20), "zh-CN", now), "9月20日");
  assert.equal(formatTimelineDay(localDay(2025, 12, 31), "zh-CN", now), "2025年12月31日");
});

test("English labels and full timestamps use the selected language", () => {
  const now = localDay(2026, 9, 27);
  assert.equal(formatTimelineDay(localDay(2026, 9, 27), "en", now), "Today");
  assert.equal(formatTimelineDay(localDay(2026, 9, 26), "en", now), "Yesterday");
  assert.equal(formatTimelineDay(localDay(2026, 9, 25), "en", now), "Friday");
  assert.equal(formatTimelineDay(localDay(2026, 9, 20), "en", now), "Sep 20");
  assert.equal(formatTimelineDay(localDay(2025, 12, 31), "en", now), "Dec 31, 2025");
  assert.match(formatFullTimestamp(localDay(2026, 9, 27), "zh-CN"), /2026年9月27日/);
  assert.match(formatFullTimestamp(localDay(2026, 9, 27), "en"), /September 27, 2026/);
});

test("day keys use local dates and malformed timestamps add no divider", () => {
  assert.equal(calendarDayKey(localDay(2026, 9, 27, 23)), "2026-09-27");
  assert.equal(calendarDayKey("not a date"), null);
  assert.equal(formatTimelineDay("not a date", "zh-CN"), null);
  assert.equal(formatFullTimestamp("not a date", "zh-CN"), null);
});
