import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("Personal API is a peer settings entry immediately after General, not a composer key form", () => {
  assert.match(html, /href="#settings-general">General<\/a>\s*<a href="#settings-personal-api">Personal API<\/a>/);
  assert.match(html, /<section id="settings-personal-api" class="settings-section"/);
  for (const id of ["cloud-api-provider", "cloud-api-label", "cloud-api-model", "cloud-api-key", "cloud-api-save", "cloud-api-delete"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="cloud-api-key"[^>]*type="password"[^>]*autocomplete="off"/);
  assert.doesNotMatch(html, /<form[^>]*cloud-api/);
  assert.match(html, /Your provider bills your own usage/);
});

test("account-private settings clears on workspace reset, close and reloads cloud choices after a write", () => {
  assert.match(main, /mountPersonalCloudApi/);
  assert.match(main, /personalCloudApi\.clear\(\)/);
  assert.match(main, /personalCloudApi\.load\(\)/);
  assert.match(main, /personalCloudApi\.refreshLanguage\(\)/);
});
