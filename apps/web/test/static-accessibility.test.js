import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));

test("the shell exposes landmarks, labelled forms, status regions, and separate send controls", async () => {
  const html = await readFile(htmlPath, "utf8");
  for (const requirement of [
    'class="skip-link"',
    '<nav class="session-rail"',
    'id="main-content"',
    '<aside id="member-panel"',
    'aria-live="polite"',
    'for="token"',
    'id="send-chat-button"',
    'id="send-agent-button"',
  ]) {
    assert.match(html, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
