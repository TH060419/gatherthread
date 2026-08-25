import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCodexConnectArgs } from "../src/codex-connect.js";

const execFileAsync = promisify(execFile);

test("Codex connector accepts a private HTTPS origin and applies safe defaults", () => {
  const parsed = parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--workspace", ".",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.apiUrl, "https://host.tailnet.ts.net/v1");
  assert.equal(parsed.model, "gpt-5.6-sol");
  assert.equal(parsed.sandbox, "workspace-write");
  assert.equal(parsed.shareToolEvents, true);
});

test("Codex connector rejects public plaintext URLs and unsafe sandbox modes", () => {
  assert.throws(() => parseCodexConnectArgs([
    "--url", "http://example.com",
  ]), /must use HTTPS/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://example.com",
    "--sandbox", "danger-full-access",
  ]), /read-only or workspace-write/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://user:secret@example.com",
  ]), /cannot contain credentials/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://example.com",
    "--model", "--dangerously-treated-as-an-option",
  ]), /requires a value/);
});

test("Codex connector direct entry point runs on native filesystem paths", async () => {
  const entryPoint = fileURLToPath(new URL("../src/codex-connect.js", import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [entryPoint, "--help"]);
  assert.match(stdout, /GatherThread Codex connector/);
  assert.equal(stderr, "");
});
