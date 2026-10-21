import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileBranchesResultSchema, FileTreeResultSchema, FileContentResultSchema, FileHistoryResultSchema,
  FileChangesResultSchema, FileMutationResultSchema, type FileOperation } from "@gatherthread/protocol";
import { CodeRepository } from "../src/code-repository.js";
import { startCollaborationServer } from "../src/server.js";
import { browserSessionFixture } from "./auth-fixtures.js";

const write = (path: string, content: string): FileOperation => ({ type: "write", path, content_base64: Buffer.from(content).toString("base64") });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-files-http-"));
  const databasePath = join(directory, "state.sqlite"), browserOrigin = "https://files-client.test";
  const running = await startCollaborationServer({ databasePath, authTokenPepper: "files-http-test-pepper-not-a-credential", allowedOrigins: [browserOrigin] });
  const owner = running.database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" });
  const member = running.database.createIdentity({ display_name: "Member", device_name: "Member" });
  const viewer = running.database.createIdentity({ display_name: "Viewer", device_name: "Viewer" });
  const outsider = running.database.createIdentity({ display_name: "Outsider", device_name: "Outsider" });
  const project = running.service.createProject(owner.actor, { title: "HTTP files", idempotency_key: "files-http-project" });
  for (const [identity, role] of [[member, "participant"], [viewer, "viewer"]] as const) {
    const invitation = running.service.createProjectInvitation(owner.actor, project.id, { role, ttl: "1h" });
    running.service.claimInvitationForActor(identity.actor, invitation.invite_token);
  }
  const repository = new CodeRepository(running.database, `${databasePath}.code`);
  const initial = repository.enable(owner.actor, project.id, { idempotency_key: "files-http-enable" }).commit;
  const base = `/v1/projects/${project.id}/files`;
  const request = async (token: string | null, endpoint: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`${running.origin}${endpoint.startsWith("/") ? endpoint : `${base}/${endpoint}`}`, { method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { data?: unknown; error?: { code: string; message: string } } };
  };
  const input = (branch: string, commit: string, operations: FileOperation[], key: string) => ({ provider: "gt-cloud", branch_id: branch,
    base_commit: commit, operations, message: "HTTP file change", idempotency_key: key });
  return { running, browserOrigin, owner, member, viewer, outsider, project, repository, initial, request, input,
    async close() { await running.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("HTTP file routes return strict metadata and binary schemas and replay original manager operations", async () => {
  const f = await fixture();
  try {
    const selection = FileBranchesResultSchema.parse((await f.request(f.member.token, "branches?provider=gt-cloud")).body.data);
    assert.equal(selection.default_branch_id, "own");
    assert.equal(FileTreeResultSchema.parse((await f.request(f.member.token, "tree?provider=gt-cloud&branch_id=own")).body.data).can_write, true);
    const binary = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 254]);
    const firstRequest = f.input("own", f.initial, [write("src/a.ts", "let a = 1;\n"),
      { type: "write", path: "paper.pdf", content_base64: binary.toString("base64") }], "http-files-first");
    const firstResponse = await f.request(f.member.token, "mutations", "POST", firstRequest);
    assert.equal(firstResponse.status, 200);
    const first = FileMutationResultSchema.parse(firstResponse.body.data);
    const file = FileContentResultSchema.parse((await f.request(f.viewer.token, `content?provider=gt-cloud&branch_id=${first.branch_id}&path=paper.pdf`)).body.data);
    assert.deepEqual(Buffer.from(file.content_base64, "base64"), binary);
    const input = f.input(first.branch_id, first.commit, [{ type: "copy", path: "src", destination: "copied" },
      { type: "move", path: "src", destination: "renamed" }, { type: "delete", path: "paper.pdf" }, write("new.txt", "new")], "http-files-manage");
    const saved = FileMutationResultSchema.parse((await f.request(f.member.token, "mutations", "POST", input)).body.data);
    const tree = FileTreeResultSchema.parse((await f.request(f.viewer.token, `tree?provider=gt-cloud&branch_id=${saved.branch_id}`)).body.data);
    assert.equal(tree.can_write, false);
    assert.deepEqual(tree.entries.map((entry) => entry.path), ["copied/a.ts", "new.txt", "renamed/a.ts"]);
    const changes = FileChangesResultSchema.parse((await f.request(f.viewer.token, `changes?provider=gt-cloud&branch_id=${saved.branch_id}`)).body.data);
    assert.equal(changes.base_commit, first.commit);
    assert.deepEqual(changes.files, [{ path: "copied/a.ts", status: "added" }, { path: "new.txt", status: "added" },
      { path: "paper.pdf", status: "deleted" }, { path: "renamed/a.ts", status: "added" }, { path: "src/a.ts", status: "deleted" }]);
    const history = FileHistoryResultSchema.parse((await f.request(f.viewer.token, `history?provider=gt-cloud&branch_id=${saved.branch_id}&limit=1`)).body.data);
    assert.equal(history.commits[0]?.id, saved.commit); assert.equal(history.next_cursor, saved.commit);
    const page = FileHistoryResultSchema.parse((await f.request(f.viewer.token, `history?provider=gt-cloud&branch_id=${saved.branch_id}&cursor=${history.next_cursor}&limit=2`)).body.data);
    assert.deepEqual(page.commits.map((entry) => entry.id), [first.commit, f.initial]);
    const later = FileMutationResultSchema.parse((await f.request(f.member.token, "mutations", "POST",
      f.input(saved.branch_id, saved.commit, [write("new.txt", "changed")], "http-files-later"))).body.data);
    assert.deepEqual(FileMutationResultSchema.parse((await f.request(f.member.token, "mutations", "POST", input)).body.data), saved);
    assert.equal(FileTreeResultSchema.parse((await f.request(f.member.token, `tree?provider=gt-cloud&branch_id=${saved.branch_id}`)).body.data).commit, later.commit);
    assert.equal((await f.request(f.member.token, "mutations", "POST", { ...input, operations: [{ type: "delete", path: "new.txt" }] })).body.error?.code, "idempotency_conflict");
    assert.equal((await f.request(f.member.token, "mutations", "POST", f.input(saved.branch_id, saved.commit, [write("new.txt", "stale")], "http-files-stale"))).body.error?.code, "code_stale_head");
  } finally { await f.close(); }
});

test("HTTP files enforce own-branch writes, viewer roles, archived projects and active devices", async () => {
  const f = await fixture();
  try {
    const input = f.input("own", f.initial, [write("safe.txt", "safe")], "http-access-first");
    const first = FileMutationResultSchema.parse((await f.request(f.member.token, "mutations", "POST", input)).body.data);
    const other = f.input(first.branch_id, first.commit, [write("safe.txt", "other")], "http-access-other");
    assert.equal((await f.request(f.owner.token, "mutations", "POST", other)).status, 403);
    assert.equal((await f.request(f.viewer.token, "mutations", "POST", other)).status, 403);
    assert.equal((await f.request(f.owner.token, "mutations", "POST", f.input("main", f.initial, [write("main.txt", "no")], "http-write-main"))).status, 403);
    assert.equal((await f.request(f.outsider.token, `tree?provider=gt-cloud&branch_id=${first.branch_id}`)).status, 404);
    assert.equal((await f.request(null, "branches?provider=gt-cloud")).status, 401);
    f.running.service.setProjectMembership(f.owner.actor, f.project.id, f.member.actor.user_id, "viewer");
    assert.equal((await f.request(f.member.token, "mutations", "POST", input)).status, 403);
    assert.equal((await f.request(f.member.token, `content?provider=gt-cloud&branch_id=${first.branch_id}&path=safe.txt`)).status, 200);
    f.running.service.setProjectMembership(f.owner.actor, f.project.id, f.member.actor.user_id, "participant");
    f.running.database.sqlite.prepare("UPDATE projects SET state='archived' WHERE id=?").run(f.project.id);
    assert.equal((await f.request(f.member.token, "mutations", "POST", f.input(first.branch_id, first.commit, [write("safe.txt", "archived")], "http-archive-edit"))).status, 403);
    assert.equal(FileTreeResultSchema.parse((await f.request(f.member.token, `tree?provider=gt-cloud&branch_id=${first.branch_id}`)).body.data).can_write, false);
    f.running.service.revokeDevice(f.member.actor, f.member.actor.device_id);
    assert.equal((await f.request(f.member.token, `tree?provider=gt-cloud&branch_id=${first.branch_id}`)).status, 401);
    assert.equal((await f.request(f.member.token, "mutations", "POST", input)).status, 401);
  } finally { await f.close(); }
});

test("HTTP history rejects foreign branch commits, arbitrary revspecs and cleared orphan objects", async () => {
  const f = await fixture();
  try {
    const first = FileMutationResultSchema.parse((await f.request(f.member.token, "mutations", "POST",
      f.input("own", f.initial, [write("member.txt", "member")], "http-member-version"))).body.data);
    const other = FileMutationResultSchema.parse((await f.request(f.owner.token, "mutations", "POST",
      f.input("own", f.initial, [write("owner.txt", "owner")], "http-owner-version"))).body.data);
    for (const endpoint of ["tree", "content", "history", "changes"]) {
      const suffix = endpoint === "content" ? "&path=owner.txt" : "";
      assert.equal((await f.request(f.viewer.token, `${endpoint}?provider=gt-cloud&branch_id=${first.branch_id}&commit=${other.commit}${suffix}`)).status, 404);
    }
    assert.equal((await f.request(f.viewer.token, `content?provider=gt-cloud&branch_id=${other.branch_id}&path=owner.txt`)).status, 200);
    assert.equal((await f.request(f.viewer.token, `history?provider=gt-cloud&branch_id=${first.branch_id}&cursor=${other.commit}`)).status, 404);
    assert.equal((await f.request(f.viewer.token, `changes?provider=gt-cloud&branch_id=${first.branch_id}&base_commit=${other.commit}`)).status, 404);
    assert.equal((await f.request(f.viewer.token, `tree?provider=gt-cloud&branch_id=${first.branch_id}&commit=main~1`)).status, 400);
    assert.equal((await f.request(f.viewer.token, `history?provider=gt-cloud&branch_id=${first.branch_id}&limit=101`)).status, 400);
    assert.equal(FileTreeResultSchema.parse((await f.request(f.member.token, `tree?provider=gt-cloud&branch_id=${first.branch_id}&commit=${f.initial}`)).body.data).can_write, false);
    f.repository.clearBranch(f.member.actor, f.project.id, { expected_head_commit: first.commit, idempotency_key: "http-clear-personal" });
    assert.equal((await f.request(f.member.token, `tree?provider=gt-cloud&branch_id=own&commit=${first.commit}`)).status, 404);
    f.repository.clearProject(f.owner.actor, f.project.id, { expected_main_commit: f.initial,
      expected_branches: [{ branch_id: other.branch_id, head_commit: other.commit }], idempotency_key: "http-clear-project" });
    f.repository.enable(f.owner.actor, f.project.id, { idempotency_key: "http-reenable-project" });
    assert.equal((await f.request(f.owner.token, `tree?provider=gt-cloud&branch_id=main&commit=${other.commit}`)).status, 404);
  } finally { await f.close(); }
});

test("HTTP file writes retain Cookie Origin gates and source pause while GitHub stays independently unavailable", async () => {
  const f = await fixture();
  try {
    const opened = browserSessionFixture(f.running, { token: f.owner.token });
    const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
    const input = f.input("own", f.initial, [write("browser.txt", "browser")], "http-cookie-files");
    assert.equal((await f.request(null, "mutations", "POST", input, { cookie })).body.error?.code, "csrf_origin_required");
    assert.equal((await f.request(null, "mutations", "POST", input, { cookie, origin: "https://other.test" })).status, 403);
    const accepted = await f.request(null, "mutations", "POST", input, { cookie, origin: f.browserOrigin });
    assert.equal(accepted.status, 200);
    const first = FileMutationResultSchema.parse(accepted.body.data);
    f.repository.disable(f.owner.actor, f.project.id, { idempotency_key: "http-pause-files" });
    assert.equal((await f.request(f.viewer.token, `tree?provider=gt-cloud&branch_id=${first.branch_id}`)).body.error?.code, "code_not_enabled");
    assert.equal((await f.request(f.owner.token, "branches?provider=github")).body.error?.code, "file_provider_unavailable");
    f.repository.enable(f.owner.actor, f.project.id, { idempotency_key: "http-resume-files" });
    assert.equal((await f.request(null, `content?provider=gt-cloud&branch_id=${first.branch_id}&path=browser.txt`, "GET", undefined, { cookie })).status, 200);
    f.running.service.revokeDevice(f.owner.actor, f.owner.actor.device_id);
    assert.equal((await f.request(null, "mutations", "POST", input, { cookie, origin: f.browserOrigin })).status, 401);
    assert.equal((await f.request(null, "branches?provider=gt-cloud", "GET", undefined, { cookie })).status, 401);
  } finally { await f.close(); }
});

test("HTTP file limits reject unsafe paths, credentials, query ambiguity and oversized bodies without changing heads", async () => {
  const f = await fixture();
  try {
    for (const [index, path] of ["../outside", ".env", ".git/config", "safe\\outside", "A/.co\u200ddex/state"].entries()) {
      assert.equal((await f.request(f.member.token, "mutations", "POST", f.input("own", f.initial, [write(path, "unsafe")], `http-bad-path-${index}`))).status, 400);
    }
    const secret = await f.request(f.member.token, "mutations", "POST", f.input("own", f.initial,
      [write("config.txt", ["-----BEGIN", "PRIVATE KEY-----"].join(" "))], "http-secret-file"));
    assert.equal(secret.status, 400); assert.equal(secret.body.error?.code, "code_secret_detected");
    assert.equal((await f.request(f.member.token, "tree?provider=gt-cloud&branch_id=main&branch_id=own")).status, 422);
    assert.equal((await f.request(f.member.token, "tree?provider=gt-cloud&branch_id=main&extra=yes")).status, 400);
    assert.equal((await f.request(f.member.token, "mutations", "POST", f.input("own", f.initial, Array(101).fill(write("small.txt", "small")), "http-many-operations"))).status, 400);
    assert.equal((await f.request(f.member.token, "mutations", "POST", f.input("own", f.initial,
      [write("oversized.bin", "a".repeat(2 * 1024 * 1024 + 1))], "http-over-file-limit"))).status, 400);
    assert.equal((await f.request(f.member.token, "mutations", "POST", { extra: "a".repeat(12 * 1024 * 1024) })).status, 413);
    assert.equal(f.repository.status(f.member.actor, f.project.id).branches.length, 0);
    const largest = f.input("own", f.initial, [write("maximum.bin", "a".repeat(2 * 1024 * 1024))], "http-largest-valid-file");
    const savedResponse = await f.request(f.member.token, "mutations", "POST", largest);
    assert.equal(savedResponse.status, 200);
    const saved = FileMutationResultSchema.parse(savedResponse.body.data);
    const content = FileContentResultSchema.parse((await f.request(f.viewer.token, `content?provider=gt-cloud&branch_id=${saved.branch_id}&path=maximum.bin`)).body.data);
    assert.equal(Buffer.from(content.content_base64, "base64").length, 2 * 1024 * 1024);
    assert.equal((await f.request(f.owner.token, "/v1/projects", "POST", { title: "a".repeat(300_000), idempotency_key: "http-ordinary-limit" })).status, 413);
  } finally { await f.close(); }
});
