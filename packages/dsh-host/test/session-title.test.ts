import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_SESSION_TITLE_MAX_BYTES,
  managedDshSessionTitle,
} from "../src/session-title.js";

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

test("a managed DSH Session title carries the GatherThread marker and its mode", () => {
  assert.equal(
    managedDshSessionTitle({ id: "session-1", name: "产品讨论", mode: "multi" }),
    "产品讨论 · 共序 · MULTI",
  );
  assert.equal(
    managedDshSessionTitle({ id: "session-2", name: "Personal notes", mode: "solo" }),
    "Personal notes · 共序 · SOLO",
  );
});

test("a managed DSH Session title falls back to the Session id when it has no name", () => {
  assert.equal(
    managedDshSessionTitle({ id: "session-3", mode: "multi" }),
    "session-3 · 共序 · MULTI",
  );
});

test("a long Session name is clipped so the whole title fits the DSH byte budget", () => {
  const longName = "这是一个非常长的会话名称用于验证按字节截断不会超出DSH的上限并且后缀必须完整保留".repeat(3);
  const title = managedDshSessionTitle({ id: "session-4", name: longName, mode: "multi" });
  assert.ok(
    byteLength(title) <= DSH_SESSION_TITLE_MAX_BYTES,
    `title must fit ${String(DSH_SESSION_TITLE_MAX_BYTES)} UTF-8 bytes, got ${String(byteLength(title))}`,
  );
  assert.ok(byteLength(longName) > DSH_SESSION_TITLE_MAX_BYTES, "the fixture must actually need clipping");
});

test("clipping keeps the marker intact and never splits a code point", () => {
  // A name made of astral-plane characters would be corrupted by byte slicing;
  // the marker must still survive.
  const emojiName = "🧵".repeat(60);
  const title = managedDshSessionTitle({ id: "session-5", name: emojiName, mode: "solo" });
  assert.ok(title.endsWith(" · 共序 · SOLO"), `marker must survive clipping, got ${title}`);
  assert.ok(byteLength(title) <= DSH_SESSION_TITLE_MAX_BYTES);
  assert.equal(title.includes("�"), false, "clipping must not produce a replacement character");
  assert.equal(Buffer.from(title, "utf8").toString("utf8"), title, "the title must round-trip through UTF-8");
});

test("an unexpected Session mode degrades to the bare marker instead of throwing", () => {
  // This module is the first place the DSH side reads `mode`; a malformed cloud
  // payload must not turn into a connector-fatal error.
  const title = managedDshSessionTitle({
    id: "session-7",
    name: "Shared analysis",
    mode: "unexpected" as unknown as "multi",
  });
  assert.equal(title, "Shared analysis · 共序");
});

test("the marker survives a name that alone would exceed the budget", () => {
  const title = managedDshSessionTitle({ id: "session-6", name: "x".repeat(500), mode: "multi" });
  assert.ok(title.endsWith(" · 共序 · MULTI"));
  assert.ok(byteLength(title) <= DSH_SESSION_TITLE_MAX_BYTES);
  assert.ok(title.startsWith("x"), "some of the name is kept so the Session stays identifiable");
});
