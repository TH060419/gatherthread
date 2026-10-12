import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translateUiText } from "../src/i18n.js";
import { agentContextUpdateReason } from "../src/domain.js";
test("workspace wires deletion into message actions and history revision cache invalidation", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(source, /mountMessageDeletion/);
  assert.match(source, /deletionAction:\s*messageDeletion\.action/);
  assert.match(source, /messageActions\.invalidateContent\(/);
  assert.match(source, /messageActions\.reconcileContent\(/);
  assert.match(source, /contentRevision:\s*state\.sync\.contentRevision/);
  assert.match(source, /event\.deleted\.reason === "author"[\s\S]*?"Message deleted" : "Unavailable because its source was deleted"/);
  assert.match(source, /async function selectSession[\s\S]*?messageDeletion\.reset\(\)/);
});
test("a pre-deletion runtime works unchanged, while a legacy connector cannot continue after deletion", () => {
  const old = { status: "online", contextDeletionVersion: 0 };
  assert.equal(agentContextUpdateReason(old, 0), "");
  assert.equal(agentContextUpdateReason({ ...old, contextDeletionVersion: 1 }, 1), "");
  assert.equal(agentContextUpdateReason(old, 1), "Update and reconnect your Agent connector before continuing.");
  assert.notEqual(translateUiText(agentContextUpdateReason(old, 1), "zh-CN"), agentContextUpdateReason(old, 1));
});
test("deletion labels and privacy confirmation are bilingual", () => {
  for (const text of ["Delete my message", "Message deleted", "Unavailable because its source was deleted", "Original message deleted", "Refreshing history…",
    "Delete this message? It will be excluded from future GatherThread Agent context. Existing independent local or provider copies are not erased.",
    "Delete this request, its linked replies and work? It will be excluded from future GatherThread Agent context. Existing independent local or provider copies are not erased."]) {
    assert.notEqual(translateUiText(text, "zh-CN"), text);
  }
});
