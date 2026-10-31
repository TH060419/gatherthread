import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, link, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DshWorkspaceInputSchema } from "@gatherthread/protocol";
import { DshWorkspaceFiles, cloudFileAction } from "../src/workspace-files.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "gt-workspace-files-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new DshWorkspaceFiles(directory, () => false);
  return { files, directory, write: (name: string, text: string | Buffer) => writeFile(path.join(directory, name), text) };
}
test("local comparison detects edits/additions/deletion without using private DSH history", async t => {
  const f = await fixture(t);
  await f.write("a.ts", "before"); await f.write("deleted.txt", "old"); await f.files.capture("request-a");
  await f.write("a.ts", "after"); await f.write("new.txt", "new"); await rm(path.join(f.directory, "deleted.txt"));
  const value = await f.files.changes(); assert.equal(value.requestId, "request-a");
  assert.deepEqual(value.files.sort((a,b) => a.path.localeCompare(b.path)), [
    { path: "a.ts", status: "modified" }, { path: "deleted.txt", status: "deleted" }, { path: "new.txt", status: "added" },
  ]);
  assert.deepEqual(await f.files.diff("a.ts"), { kind: "diff", path: "a.ts", before: "before", after: "after" });
  assert.deepEqual(await f.files.diff("deleted.txt"), { kind: "diff", path: "deleted.txt", before: "old", after: "" });
});
test("local file reader excludes private paths, links, generated folders and invalid text", async t => {
  const f = await fixture(t);
  await f.write("visible.txt", "public"); await f.write(".env", "fixture");
  await mkdir(path.join(f.directory, "node_modules")); await f.write("node_modules/hidden.txt", "hidden");
  await symlink(path.join(f.directory, "visible.txt"), path.join(f.directory, "alias.txt"));
  await f.write("hard-a.txt", "hard"); await link(path.join(f.directory, "hard-a.txt"), path.join(f.directory, "hard-b.txt"));
  await f.write("binary.bin", Buffer.from([0, 255, 1])); await f.write("large.txt", "x".repeat(65537));
  const tree = await f.files.tree();
  assert.deepEqual(tree.entries.map(e => e.path), ["binary.bin", "large.txt", "visible.txt"]);
  for (const name of ["../escape", "/etc/passwd", ".env", "alias.txt", "hard-a.txt", "node_modules/hidden.txt"]) await assert.rejects(f.files.read(name));
  await assert.rejects(f.files.read("binary.bin"), /workspace_file_binary/);
  await assert.rejects(f.files.read("large.txt"), /workspace_file_large/);
  assert.equal((await f.files.read("visible.txt")).text, "public");
});
test("partial snapshots never call an unobserved file added or deleted", async t => {
  const f = await fixture(t);
  await f.write("unknown.txt", "x".repeat(65537)); await f.write("known.txt", "a"); await f.files.capture();
  await f.write("unknown.txt", "now small"); await f.write("known.txt", "b");
  const value = await f.files.changes(); assert.equal(value.incomplete, true);
  assert.deepEqual(value.files, [{ path: "known.txt", status: "modified" }]);
  await assert.rejects(f.files.diff("unknown.txt"), /workspace_file_baseline/);
  await f.write("known.txt", "x".repeat(65537));
  assert.deepEqual((await f.files.changes()).files, []);
});
test("disconnect invalidates an in-flight capture and failed capture clears an old baseline", async t => {
  const f = await fixture(t); await f.write("a.txt", "a"); await f.files.capture();
  const capture = f.files.capture("new-request"); f.files.clear();
  await assert.rejects(capture, /workspace_file_changed/);
  assert.equal((await f.files.changes()).baseline, null);
  await f.files.capture(); await rm(f.directory, { recursive: true });
  await assert.rejects(f.files.capture()); assert.equal((await f.files.changes()).baseline, null);
});
const commit = "a".repeat(40), selection = { provider: "gt-cloud" as const, branch_id: "branch-a" };
const options = { apiUrl: "https://files.example/v1", projectId: "project-a", token: "fixture-private-token", signal: new AbortController().signal };
test("cloud files use the grant origin and validate the exact provider/branch/commit/path", async () => {
  let calls = 0;
  const request = { operation: "content" as const, input: { ...selection, commit, path: "a.txt" } };
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls++;
    assert.equal(url.origin, "https://files.example"); assert.equal(url.pathname, "/v1/projects/project-a/files/content");
    assert.equal(url.searchParams.get("commit"), commit); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-private-token");
    return Response.json({ data: { ...selection, commit, path: "a.txt", content_base64: Buffer.from("你好").toString("base64"), size: 6 } });
  }) as typeof fetch;
  const result = await cloudFileAction(request, { ...options, fetch: transport });
  assert.deepEqual(result, { kind: "text", path: "a.txt", text: "你好" }); assert.equal(calls, 1);
  for (const altered of [{ provider: "github" }, { branch_id: "branch-b" }, { commit: "b".repeat(40) }, { path: "b.txt" }, { size: 2 }]) {
    await assert.rejects(cloudFileAction(request, { ...options, fetch: (async () => Response.json({ data: { ...selection, commit, path: "a.txt", content_base64: "YQ==", size: 1, ...altered } })) as typeof fetch }), /workspace_invalid_response/);
  }
});
test("cloud errors are bounded actionable codes, not private server diagnostics", async () => {
  for (const [status, code] of [[409, "conflict"], [403, "forbidden"], [503, "not_configured"], [500, "unavailable"]] as const) {
    await assert.rejects(cloudFileAction({ operation: "branches", provider: "gt-cloud" }, { ...options,
      fetch: (async () => Response.json({ error: { message: "PRIVATE-DETAILS" } }, { status })) as typeof fetch }), error => {
        assert.match(String(error), new RegExp(`workspace_file_${code}`)); assert.doesNotMatch(String(error), /PRIVATE/); return true;
      });
  }
});
test("cloud saves preserve immutable idempotency and bound the native write contract", async () => {
  const input = { ...selection, base_commit: commit, operations: [{ type: "write" as const, path: "a.txt", content_base64: "YQ==" }], message: "Update a.txt", idempotency_key: "fixed-attempt" };
  const bodies: unknown[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ data: { ...selection, commit: "b".repeat(40) } }); }) as typeof fetch;
  await cloudFileAction({ operation: "save", input }, { ...options, fetch: fetcher });
  await cloudFileAction({ operation: "save", input }, { ...options, fetch: fetcher }); assert.deepEqual(bodies[0], bodies[1]);
  const envelope = { action: "files", connectionId: "c", projectId: "p", sessionId: "s", request: { operation: "save", input } };
  assert.equal(DshWorkspaceInputSchema.safeParse(envelope).success, true);
  for (const operations of [[...input.operations, ...input.operations], [{ type: "delete", path: "a.txt" }], [{ type: "write", path: "a.txt", content_base64: Buffer.alloc(65537).toString("base64") }]]) {
    assert.equal(DshWorkspaceInputSchema.safeParse({ ...envelope, request: { operation: "save", input: { ...input, operations } } }).success, false);
  }
});

test("history accepts its own response contract, which has commits rather than a commit field", async () => {
  const value = { ...selection, commits: [{ id: commit, parent_ids: [], message: 'Initial', author_name: 'Fixture', created_at: '2026-10-29T12:00:00Z' }] };
  assert.deepEqual(await cloudFileAction({ operation: 'history', input: { ...selection, commit, limit: 20 } }, { ...options,
    fetch: (async () => Response.json({ data: value })) as typeof fetch }), { kind: 'history', value });
});

test("aborted execution capture cannot publish a stale baseline", async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.files.capture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.files.capture('cancelled-request', abort.signal));
  assert.equal((await f.files.changes()).baseline, null);
});
