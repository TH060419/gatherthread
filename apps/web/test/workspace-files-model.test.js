import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFilePath, portablePathKey, validateFileDestination, buildFileTree, flattenFileTree,
  fileContextKey, canEditFileBranch, textToBase64, decodeFileContent, describeFileContent,
  validateFileImport, validateFileWriteOperations,
} from "../src/workspace-files-model.js";

test("file paths preserve valid names and reject traversal, private state and portable aliases", () => {
  for (const path of ["src/main.js", "资料/README.md", ".env.example", "docs/.gitkeep", "my file.txt"]) assert.equal(normalizeFilePath(path), path);
  for (const path of ["", "/etc/passwd", "../a", "a/../b", "a//b", "a\\b", "a\u0000b", "a/.", "a. ", ".git/config", ".codex/config.toml", ".env", "a/.env.local", "NUL.txt", "a/COM1", "secret.pem", "id_ed25519.pub", "A~1.txt", "a/\ud800", ".gatherthread-state/x", ".g\u200cit/config"]) {
    assert.throws(() => normalizeFilePath(path), /files.pathInvalid/u, path);
  }
  assert.equal(portablePathKey("É/FILE"), portablePathKey("E\u0301/file"));
});

test("destinations refuse collisions, file-folder overlap and self-descendant moves", () => {
  const entries = [{ path: "src/a.js" }, { path: "README.md" }];
  assert.equal(validateFileDestination("src/b.js", entries), "src/b.js");
  for (const destination of ["SRC/a.js", "src", "README.md/nested", "readme.MD"]) assert.throws(() => validateFileDestination(destination, entries), /files.pathExists/u);
  assert.throws(() => validateFileDestination("src/nested", entries, { source: "src", isDirectory: true }), /files.pathInsideSource/u);
});

test("file tree derives folders and search retains matching ancestors", () => {
  const tree = buildFileTree([{ path: "z.txt" }, { path: "src/lib/b.js" }, { path: "src/a.js" }, { path: "../unsafe" }, { path: "z.txt" }]);
  assert.deepEqual(tree.children.map((entry) => entry.path), ["src", "z.txt"]);
  assert.deepEqual(flattenFileTree(tree).map((row) => row.path), ["src", "z.txt"]);
  assert.deepEqual(flattenFileTree(tree, new Set(["src"])).map((row) => [row.path, row.depth]), [["src", 0], ["src/lib", 1], ["src/a.js", 1], ["z.txt", 0]]);
  assert.deepEqual(flattenFileTree(tree, new Set(), "B.JS").map((row) => row.path), ["src", "src/lib", "src/lib/b.js"]);
});

test("write capability is confined to the actor's current personal branch", () => {
  const context = { canWrite: true, userId: "alice" };
  assert.equal(canEditFileBranch(context, { id: "own", can_write: true }), true);
  assert.equal(canEditFileBranch(context, { id: "alice-branch", user_id: "alice", can_write: true }), true);
  for (const branch of [{ id: "main", user_id: "alice", can_write: true }, { id: "bob-branch", user_id: "bob", can_write: true }, { id: "alice-branch", user_id: "alice", can_write: false }]) assert.equal(canEditFileBranch(context, branch), false);
  assert.equal(canEditFileBranch(context, { id: "own", can_write: true }, true), false);
  assert.equal(canEditFileBranch({ ...context, canWrite: false }, { id: "own", can_write: true }), false);
  assert.notEqual(fileContextKey({ scope: "a", userId: "alice", projectId: "one" }), fileContextKey({ scope: "a", userId: "bob", projectId: "one" }));
});

test("UTF-8 buffers roundtrip exactly, binary formats are sniffed, SVG is never active image content", () => {
  const text = "中文\nconst emoji = '🦊';\r\n";
  const bytes = decodeFileContent({ content_base64: textToBase64(text), size: new TextEncoder().encode(text).length });
  assert.deepEqual(describeFileContent("README.md", bytes), { kind: "markdown", text, mime: "text/plain;charset=utf-8" });
  assert.equal(describeFileContent("fake.png", new TextEncoder().encode("<svg onload='evil()'/>" )).kind, "text");
  assert.equal(describeFileContent("x.bin", Uint8Array.from([0, 1, 2])).kind, "binary");
  assert.equal(describeFileContent("x.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])).kind, "image");
  assert.equal(describeFileContent("x.pdf", new TextEncoder().encode("%PDF-1.7")).kind, "pdf");
  assert.throws(() => decodeFileContent({ content_base64: "not base64" }), /files.contentInvalid/u);
  assert.throws(() => decodeFileContent({ content_base64: "YQ==", size: 2 }), /files.contentInvalid/u);
});

test("multi-MiB base64 validation stays linear and supports the browser boundary", () => {
  const text = "x".repeat(2 * 1024 * 1024); const encoded = textToBase64(text);
  assert.equal(decodeFileContent({ content_base64: encoded, size: text.length }).length, text.length);
  for (const invalid of ["=AAA", "A===", "AAAA=AAA", "AAAA\nAAA", "AAA", "===="]) assert.throws(() => decodeFileContent({ content_base64: invalid }), /files.contentInvalid/u);
});

test("import preflight matches provider, operation and aggregate protocol limits", () => {
  const MiB = 1024 * 1024;
  assert.doesNotThrow(() => validateFileImport([{ size: 2 * MiB }], "gt-cloud"));
  assert.throws(() => validateFileImport([{ size: 2 * MiB + 1 }], "gt-cloud"), /files.cloudFileLimit/u);
  assert.doesNotThrow(() => validateFileImport([{ size: 8 * MiB }], "github"));
  assert.throws(() => validateFileImport([{ size: 8 * MiB + 1 }], "github"), /files.githubFileLimit/u);
  assert.throws(() => validateFileImport([{ size: 6 * MiB }, { size: 3 * MiB }], "github"), /files.writeBatchLimit/u);
  assert.throws(() => validateFileImport(Array.from({ length: 101 }, () => ({ size: 0 })), "gt-cloud"), /files.operationLimit/u);
  assert.throws(() => validateFileWriteOperations(Array.from({ length: 101 }, () => ({ type: "delete", path: "a" })), "gt-cloud"), /files.operationLimit/u);
});
