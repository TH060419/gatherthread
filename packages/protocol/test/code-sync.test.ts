import assert from "node:assert/strict";
import test from "node:test";
import { CodeFilesSchema, containsCodeSyncSecret, isCodeSyncPathAllowed } from "../src/code-sync.js";

test("portable code paths reject filesystem aliases of private state and Windows devices", () => {
  for (const path of [
    "git~1/config", "src/GIT~2/config", "CODEX~1/auth.json", "GATHER~1/state.json",
    ".git\u200c/config", ".co\u200ddex/auth.json", ".env\ufeff", ".gatherthread\u200f/state",
    "src/COM¹.txt", "LPT²", "lpt³.log", "CONIN$", "CONOUT$.txt",
  ]) assert.equal(isCodeSyncPathAllowed(path), false, path);
  for (const path of ["src/解析器.ts", "src/🚀.ts", "src/👩‍🔬.ts", ".gitignore", ".gitattributes", "file~backup.ts"]) {
    assert.equal(isCodeSyncPathAllowed(path), true, path);
  }
  assert.equal(CodeFilesSchema.safeParse([
    { path: "src/file.ts", content_base64: "eA==", executable: false },
    { path: "src/file\u200c.ts", content_base64: "eQ==", executable: false },
  ]).success, false, "names that alias on HFS cannot coexist");
});

test("code secret detection includes encrypted private keys and retains harmless source placeholders", () => {
  assert.equal(containsCodeSyncSecret(["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" ")), true);
  assert.equal(containsCodeSyncSecret("export const token = process.env.API_TOKEN;\nAPI_KEY=your-key"), false);
});
