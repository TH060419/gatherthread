import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationDatabase, type Actor } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { HostedGithub } from "../src/hosted-github.js";
import { GithubFileWorkspace } from "../src/github-file-workspace.js";
import { ApiError } from "../src/errors.js";
import type { FileMutationInput } from "@gatherthread/protocol";

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const b64 = (value: string) => Buffer.from(value).toString("base64");
const hasCode = (...codes: string[]) => (error: unknown) => error instanceof ApiError && codes.includes(error.code);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; };
interface RemoteEntry { path: string; mode: string; type: string; sha: string; size?: number }
interface RemoteCommit { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; commit: { message: string; author: { name: string; date: string } } }

async function fixture(baseBranch = "main") {
  const directory = mkdtempSync(join(tmpdir(), "gt-github-files-"));
  const database = new CollaborationDatabase(join(directory, "state.sqlite"), { authTokenPepper: "browser-github-file-fixture-pepper" });
  const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Owner", device_name: "Browser" }).actor;
  const member = database.createIdentity({ display_name: "Member", device_name: "Browser" }).actor;
  const project = service.createProject(actor, { title: "Files", idempotency_key: "github-files-project" });
  const invitation = service.createProjectInvitation(actor, project.id, { role: "participant", ttl: "1h" });
  service.claimInvitationForActor(member, invitation.invite_token);
  const blobs = new Map<string, string>(), trees = new Map<string, RemoteEntry[]>(), commits = new Map<string, RemoteCommit>(), refs = new Map<string, string>();
  const addBlob = (content: string) => { const id = sha(`blob:${content}`); blobs.set(id, content); return id; };
  const initial = [
    { path: "src/a.txt", mode: "100644", type: "blob", sha: addBlob(b64("alpha\n")), size: 6 },
    { path: "README.md", mode: "100644", type: "blob", sha: addBlob(b64("readme\n")), size: 7 },
    { path: "figure.pdf", mode: "100644", type: "blob", sha: addBlob(Buffer.from([37, 80, 68, 70, 0, 255]).toString("base64")), size: 6 },
    { path: ".env", mode: "100644", type: "blob", sha: addBlob(b64("PRIVATE_ENV\n")), size: 12 },
    { path: ".github/workflows/build.yml", mode: "100644", type: "blob", sha: addBlob(b64("workflow\n")), size: 9 },
    { path: "dist/generated.js", mode: "100644", type: "blob", sha: addBlob(b64("generated\n")), size: 10 },
    { path: "link", mode: "120000", type: "blob", sha: addBlob(b64(".env")), size: 4 },
    { path: "submodule", mode: "160000", type: "commit", sha: sha("submodule") },
  ];
  const treeId = sha(JSON.stringify(initial)); trees.set(treeId, initial);
  const base = sha("base");
  const addCommit = (id: string, tree = treeId, parents: string[] = [], message = "Initial") => {
    commits.set(id, { sha: id, tree: { sha: tree }, parents: parents.map(sha => ({ sha })),
      commit: { message, author: { name: "Fixture", date: "2026-10-18T00:00:00Z" } } }); return id;
  };
  addCommit(base); refs.set(baseBranch, base);
  const isAncestor = (start: string, end: string): boolean => start === end || (commits.get(end)?.parents ?? []).some(parent => isAncestor(start, parent.sha));
  const calls: Array<{ path: string; method: string; body: any; authorization?: string }> = [];
  let before: ((path: string, method: string, body: any) => Promise<void> | void) | undefined;
  let after: ((path: string, method: string, body: any) => Promise<void> | void) | undefined;
  let canPush = true, truncated = false;
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url)), path = decodeURIComponent(parsed.pathname), method = init?.method ?? "GET";
    assert.equal(parsed.protocol, "https:"); assert.ok(["api.github.com", "github.com"].includes(parsed.hostname));
    assert.equal(init?.redirect, "error");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: path + parsed.search, method, body, authorization: String((init?.headers as Record<string, string>)?.authorization ?? "") });
    await before?.(path, method, body);
    let result: any;
    if (path === "/login/oauth/access_token") result = { access_token: `ghu_${randomUUID()}`, refresh_token: `ghr_${randomUUID()}`, expires_in: 28800, refresh_token_expires_in: 100000, scope: "" };
    else if (path === "/user") result = { login: "fixture-user" };
    else if (path === "/repos/owner/project") result = { id: 123, full_name: "owner/project", permissions: { pull: true, push: canPush } };
    else if (path === `/repos/owner/project/branches/${baseBranch}`) result = { commit: { sha: refs.get(baseBranch) } };
    else if (path.includes("/git/matching-refs/heads/")) {
      const prefix = path.split("/git/matching-refs/heads/")[1]!;
      result = [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, id]) => ({ ref: `refs/heads/${ref}`, object: { type: "commit", sha: id } }));
    } else if (path.includes("/git/commits/") && method === "GET") result = commits.get(path.split("/").at(-1)!);
    else if (path.includes("/git/trees/") && method === "GET") result = { truncated, tree: trees.get(path.split("/").at(-1)!) };
    else if (path.includes("/git/blobs/") && method === "GET") result = { encoding: "base64", content: blobs.get(path.split("/").at(-1)!) };
    else if (path.endsWith("/git/blobs") && method === "POST") result = { sha: addBlob(body.content) };
    else if (path.endsWith("/git/trees") && method === "POST") {
      const next = new Map(trees.get(body.base_tree)!.map(entry => [entry.path, { ...entry }]));
      for (const entry of body.tree) {
        if (entry.sha === null) next.delete(entry.path);
        else next.set(entry.path, { ...entry, size: Buffer.from(blobs.get(entry.sha)!, "base64").length });
      }
      const entries = [...next.values()].sort((a, b) => a.path.localeCompare(b.path)), id = sha(JSON.stringify(entries));
      trees.set(id, entries); result = { sha: id };
    } else if (path.endsWith("/git/commits") && method === "POST") result = { sha: addCommit(sha(JSON.stringify(body)), body.tree, body.parents, body.message) };
    else if (path.endsWith("/git/refs") && method === "POST") {
      const branch = body.ref.slice(11);
      if (refs.has(branch)) return new Response("{}", { status: 422 });
      refs.set(branch, body.sha); result = { ref: body.ref, object: { sha: body.sha } };
    } else if (path.includes("/git/refs/heads/") && method === "PATCH") {
      assert.equal(body.force, false);
      const branch = path.split("/git/refs/heads/")[1]!, old = refs.get(branch)!;
      if (!isAncestor(old, body.sha)) return new Response("{}", { status: 422 });
      refs.set(branch, body.sha); result = { ref: `refs/heads/${branch}`, object: { sha: body.sha } };
    } else if (path.includes("/compare/")) {
      const [start, end] = path.split("/compare/")[1]!.split("...") as [string, string];
      result = { status: start === end ? "identical" : isAncestor(start, end) ? "ahead" : "diverged", base_commit: { sha: start }, merge_base_commit: { sha: isAncestor(start, end) ? start : base } };
    } else if (path.endsWith("/commits")) {
      const listed: RemoteCommit[] = [], queue = [parsed.searchParams.get("sha")!], seen = new Set<string>();
      while (queue.length) { const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id); const c = commits.get(id)!; listed.push(c); queue.push(...c.parents.map(parent => parent.sha)); }
      const page = Number(parsed.searchParams.get("page") ?? 1); result = listed.slice((page - 1) * 100, page * 100);
    } else throw new Error(`Unexpected fixture request: ${method} ${path}`);
    await after?.(path, method, body);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  };
  const options: HostedAgentOptions = { endpoints: [{ id: "fixture", profileId: "coding", label: "Fixture", provider: "openai-compatible", model: "fixture",
    baseUrl: "https://model.example/v1", apiToken: "fixture-only", quotaGroup: "fixture", dailyRuns: 10, maxConcurrent: 1 }],
    image: `sha256:${"a".repeat(64)}`, userDailyRuns: 10, globalDailyRuns: 10, maxConcurrent: 1, runContainer: async () => { throw new Error("Browser file operations cannot start a container"); } };
  const agent = new HostedAgent(service, new CodeRepository(database, join(directory, "code")), options);
  const github = new HostedGithub(service, agent, options, { clientId: "fixture", clientSecret: "fixture", appSlug: "fixture",
    encryptionKey: Buffer.alloc(32, 7).toString("base64"), callbackUrl: "https://gt.example/v1/hosted-github/callback", fetch: fetcher });
  const connect = async (who: Actor) => {
    const state = new URL(github.authorize(who).authorization_url).searchParams.get("state")!;
    await github.complete(who, { state, code: "fixture" });
    await github.bind(who, project.id, { repository: "owner/project", base_branch: baseBranch });
  };
  await connect(actor); await connect(member);
  const configured = service.setProjectGitHub(actor, project.id, { repository: "owner/project", base_branch: baseBranch, enabled: true, expected_revision: null });
  const files = new GithubFileWorkspace(service, github), branch = configured.branch, memberBranch = service.getProjectGitHub(member, project.id).branch;
  calls.length = 0;
  return { directory, database, service, actor, member, project, github, agent, files, refs, trees, blobs, commits, calls, base, branch, memberBranch,
    revision: configured.connection!.revision, addBlob, addCommit, treeId,
    before: (hook?: typeof before) => { before = hook; }, after: (hook?: typeof after) => { after = hook; },
    canPush: (value: boolean) => { canPush = value; }, truncate: (value: boolean) => { truncated = value; },
    close: async () => { await github.close(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const mutation = (base: string, operations: FileMutationInput["operations"], id = "browser-file-save"): FileMutationInput => ({
  provider: "github", branch_id: "own", base_commit: base, operations, message: "Edit project files", idempotency_key: id,
});

test("GitHub browser exposes only base/current-member branches and safe metadata; selected binary content remains exact", async () => {
  const f = await fixture();
  try {
    f.refs.set(f.memberBranch, f.base); f.refs.set("other-private", f.base);
    const branches = await f.files.branches(f.actor, f.project.id, { provider: "github" });
    assert.deepEqual(branches.branches.map(branch => branch.id).sort(), ["main", f.memberBranch, "own"].sort());
    assert.equal(branches.connection_revision, f.revision); assert.equal(branches.branches.find(branch => branch.id === "main")!.can_write, false);
    const tree = await f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: "own" });
    assert.deepEqual(tree.entries.map(entry => entry.path).sort(), ["README.md", "figure.pdf", "src/a.txt"].sort());
    assert.equal(f.calls.some(call => call.path.includes("/git/blobs/")), false);
    assert.doesNotMatch(JSON.stringify(tree), /PRIVATE_ENV|\/git\/|submodule|100644/);
    const pdf = await f.files.content(f.actor, f.project.id, { provider: "github", branch_id: "main", path: "figure.pdf" });
    assert.deepEqual(Buffer.from(pdf.content_base64, "base64"), Buffer.from([37, 80, 68, 70, 0, 255]));
    const history = await f.files.history(f.actor, f.project.id, { provider: "github", branch_id: "main", limit: 1 });
    assert.equal(history.commits[0]!.id, f.base);
    const changes = await f.files.changes(f.actor, f.project.id, { provider: "github", branch_id: "main" });
    assert.equal(changes.base_commit, null); assert.equal(changes.files.length, 3);
  } finally { await f.close(); }
});

test("GitHub browser applies metadata copy/move/delete only to own ref, preserves hidden entries and replays original intent", async () => {
  const f = await fixture();
  try {
    const input = mutation(f.base, [{ type: "copy", path: "src", destination: "copied" }, { type: "move", path: "copied/a.txt", destination: "moved.txt" },
      { type: "delete", path: "README.md" }, { type: "write", path: "new.txt", content_base64: b64("EXACT_NEW_SOURCE"), executable: true }]);
    const result = await f.files.mutate(f.actor, f.project.id, input);
    assert.equal(result.branch_id, f.branch); assert.equal(f.refs.get(f.branch), result.commit); assert.equal(f.refs.get("main"), f.base);
    const tree = f.trees.get(f.commits.get(result.commit)!.tree.sha)!;
    assert.ok(tree.some(entry => entry.path === ".env")); assert.ok(tree.some(entry => entry.path === "link")); assert.ok(tree.some(entry => entry.path === "submodule"));
    assert.ok(tree.some(entry => entry.path === "moved.txt")); assert.ok(!tree.some(entry => entry.path === "README.md"));
    const writes = f.calls.filter(call => call.method !== "GET").length;
    const reopened = new GithubFileWorkspace(f.service, f.github), retried = await reopened.mutate(f.actor, f.project.id, input);
    assert.equal(retried.commit, result.commit); assert.equal(retried.replayed, true); assert.equal(f.calls.filter(call => call.method !== "GET").length, writes);
    assert.doesNotMatch(JSON.stringify(f.database.sqlite.prepare("SELECT * FROM github_file_mutation_receipts").all()), /EXACT_NEW_SOURCE|content_base64|operations/);
    await assert.rejects(f.files.mutate(f.actor, f.project.id, { ...input, message: "Changed input" }), hasCode("idempotency_conflict"));
    await assert.rejects(f.files.mutate(f.actor, f.project.id, { ...input, branch_id: "main", idempotency_key: "cannot-write-main" }), hasCode("file_read_only"));
    await assert.rejects(f.files.mutate(f.actor, f.project.id, { ...input, branch_id: f.memberBranch, idempotency_key: "cannot-write-peer" }), hasCode("file_read_only"));
    assert.equal(f.calls.some(call => call.path.includes("/git/blobs/") && call.method === "GET"), false);
  } finally { await f.close(); }
});

test("unknown GitHub commit/ref acknowledgements reconcile deterministically without reapplying a move", async () => {
  const f = await fixture();
  try {
    let failCommit = true;
    f.after((path, method) => { if (failCommit && path.endsWith("/git/commits") && method === "POST") { failCommit = false; throw new Error("Unknown commit acknowledgement"); } });
    const input = mutation(f.base, [{ type: "move", path: "src/a.txt", destination: "moved.txt" }], "unknown-ack-move");
    await assert.rejects(f.files.mutate(f.actor, f.project.id, input), /Unknown commit acknowledgement/u);
    assert.equal(f.refs.has(f.branch), false); const commits = f.commits.size;
    let failRef = true;
    f.after((path, method) => { if (failRef && path.endsWith("/git/refs") && method === "POST") { failRef = false; throw new Error("Unknown ref acknowledgement"); } });
    const result = await new GithubFileWorkspace(f.service, f.github).mutate(f.actor, f.project.id, input);
    assert.equal(f.commits.size, commits); assert.equal(f.refs.get(f.branch), result.commit);
    assert.equal((await f.files.mutate(f.actor, f.project.id, input)).replayed, true);
    assert.equal(f.calls.filter(call => call.path.endsWith("/git/refs") && call.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("GitHub own-ref guard refuses generic, protected, forced and read-capability writes before dispatch", async () => {
  const f = await fixture();
  try {
    const guard = await f.github.repositoryGuard(f.actor, f.project.id, true), before = f.calls.length;
    for (const [path, method, body] of [
      ["/repos/owner/project/git/refs/heads/main", "PATCH", { sha: f.base, force: false }],
      [`/repos/owner/project/git/refs/heads/${encodeURIComponent(f.branch)}`, "PATCH", { sha: f.base, force: true }],
      ["/repos/owner/project/git/refs", "POST", { ref: `refs/heads/${f.memberBranch}`, sha: f.base }],
      ["/repos/owner/project/issues", "POST", { title: "Unrelated" }],
    ] as const) await assert.rejects(guard.request(path, method, body), hasCode("file_read_only"));
    assert.equal(f.calls.length, before);
    const read = await f.github.repositoryGuard(f.actor, f.project.id);
    await assert.rejects(read.request("/repos/owner/project/git/blobs", "POST", { content: "", encoding: "base64" }), hasCode("file_read_only"));
  } finally { await f.close(); }
});

for (const change of ["authorization", "binding", "project", "device", "member", "browser-session"] as const) {
  test(`GitHub file acquisition fences ${change} revocation after an awaited response`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    let requestCurrent = true;
    try {
      const files = new GithubFileWorkspace(f.service, f.github, () => { if (!requestCurrent) throw new ApiError(401, "unauthorized", "Browser session expired"); });
      f.after(async (path, method) => { if (path.includes("/git/trees/") && method === "GET") { entered.resolve(); await release.promise; } });
      const pending = files.content(f.member, f.project.id, { provider: "github", branch_id: "main", path: "src/a.txt" });
      await entered.promise;
      switch (change) {
        case "authorization": f.github.authorize(f.member); break;
        case "binding": f.database.sqlite.prepare("UPDATE hosted_github_bindings SET revision='replaced' WHERE user_id=?").run(f.member.user_id); break;
        case "project": f.service.setProjectGitHub(f.actor, f.project.id, { repository: "owner/project", base_branch: "main", enabled: false, expected_revision: f.revision }); break;
        case "device": f.database.revokeDevice(f.member, f.member.device_id); break;
        case "member": f.service.removeProjectMembership(f.actor, f.project.id, f.member.user_id); break;
        case "browser-session": requestCurrent = false; break;
      }
      release.resolve(); await assert.rejects(pending, error => error instanceof ApiError);
      assert.equal(f.calls.some(call => call.path.includes("/git/blobs/")), false);
    } finally { release.resolve(); await f.close(); }
  });
}

test("GitHub browser never borrows another member's account/binding; viewers retain read access only", async () => {
  const f = await fixture();
  try {
    f.github.disconnect(f.member);
    const before = f.calls.length;
    await assert.rejects(f.files.tree(f.member, f.project.id, { provider: "github", branch_id: "main" }), hasCode("github_connection_required"));
    assert.equal(f.calls.length, before);
    f.service.setProjectMembership(f.actor, f.project.id, f.member.user_id, "viewer");
    f.service.setProjectMembership(f.actor, f.project.id, f.member.user_id, "participant");
    const state = new URL(f.github.authorize(f.member).authorization_url).searchParams.get("state")!;
    await f.github.complete(f.member, { state, code: "fixture" }); await f.github.bind(f.member, f.project.id, { repository: "owner/project", base_branch: "main" });
    f.service.setProjectMembership(f.actor, f.project.id, f.member.user_id, "viewer");
    assert.equal((await f.files.tree(f.member, f.project.id, { provider: "github", branch_id: "own" })).can_write, false);
    await assert.rejects(f.files.mutate(f.member, f.project.id, mutation(f.base, [{ type: "delete", path: "README.md" }])), hasCode("file_read_only"));
    f.canPush(false);
    await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, [{ type: "delete", path: "README.md" }])), hasCode("github_access"));
  } finally { await f.close(); }
});

test("GitHub browser rejects stale/divergent writes, hidden paths, overwrite collisions and unreachable object IDs", async () => {
  const f = await fixture();
  try {
    for (const operations of [
      [{ type: "write", path: ".github/workflows/new.yml", content_base64: b64("unsafe") }],
      [{ type: "copy", path: "src/a.txt", destination: "README.md" }],
      [{ type: "write", path: "readme.MD", content_base64: b64("alias") }],
      [{ type: "move", path: ".github", destination: "moved" }],
      [{ type: "delete", path: "link" }],
    ] as FileMutationInput["operations"][]) await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, operations, `invalid-${sha(JSON.stringify(operations))}`)), error => error instanceof ApiError);
    assert.equal(f.calls.some(call => call.method !== "GET"), false);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM github_file_mutation_receipts").get()!.n, 0);
    const outsider = f.addCommit(sha("unreachable"));
    await assert.rejects(f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: "main", commit: outsider }), hasCode("file_commit_unavailable"));
    f.refs.set(f.branch, f.addCommit(sha("advance"), f.treeId, [f.base]));
    await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, [{ type: "delete", path: "README.md" }], "stale-head-save")), hasCode("file_head_changed"));
    const initial = f.refs.get(f.branch)!;
    f.before((path, method) => { if (path.includes("/git/refs/heads/") && method === "PATCH") f.refs.set(f.branch, f.addCommit(sha("external-sibling"), f.treeId, [initial])); });
    await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(initial, [{ type: "delete", path: "README.md" }], "divergent-race-save")), error => error instanceof ApiError);
    assert.equal(f.refs.get(f.branch), sha("external-sibling")); assert.equal(f.refs.get("main"), f.base);
    assert.ok(f.calls.filter(call => call.method === "PATCH").every(call => call.body.force === false));
  } finally { await f.close(); }
});

test("a shared GitHub base named own remains separately selectable and read-only", async () => {
  const f = await fixture("own");
  try {
    const branches = await f.files.branches(f.actor, f.project.id, { provider: "github" });
    assert.equal(new Set(branches.branches.map(branch => branch.id)).size, branches.branches.length);
    const shared = branches.branches.find(branch => branch.user_id === null)!;
    assert.equal(shared.name, "own"); assert.equal(shared.id, "base:own"); assert.equal(shared.can_write, false);
    const saved = await f.files.mutate(f.actor, f.project.id, mutation(f.base, [{ type: "write", path: "personal.txt", content_base64: b64("personal") }]));
    const base = await f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: shared.id });
    const own = await f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: "own" });
    assert.equal(base.head_commit, f.base); assert.equal(base.can_write, false);
    assert.equal(base.entries.some(entry => entry.path === "personal.txt"), false);
    assert.equal(own.head_commit, saved.commit); assert.equal(own.can_write, true);
    await assert.rejects(f.files.mutate(f.actor, f.project.id, { ...mutation(f.base, [{ type: "delete", path: "README.md" }]), branch_id: shared.id }), hasCode("file_read_only"));
    assert.equal(f.refs.get("own"), f.base);
  } finally { await f.close(); }
});

for (const type of ["copy", "move"] as const) {
  test(`GitHub folder ${type} rejects protected or overlong expanded destinations before any write`, async () => {
    const f = await fixture();
    try {
      const initial = f.trees.get(f.treeId)!;
      f.trees.set(f.treeId, initial.filter(entry => !entry.path.startsWith(".github/")));
      f.trees.get(f.treeId)!.push({ path: "src/workflows/run.yml", mode: "100644", type: "blob", sha: f.addBlob(b64("workflow")), size: 8 });
      await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, [{ type, path: "src", destination: ".github" }], `protected-folder-${type}`)), hasCode("file_unsupported"));
      f.trees.get(f.treeId)!.push({ path: `src/${"a".repeat(250)}/${"b".repeat(240)}`, mode: "100644", type: "blob", sha: f.addBlob(""), size: 0 });
      await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, [{ type, path: "src", destination: "newdirname" }], `overlong-folder-${type}`)), hasCode("file_unsupported"));
      assert.equal(f.calls.some(call => call.method !== "GET"), false);
      assert.equal(f.refs.has(f.branch), false);
      assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM github_file_mutation_receipts").get()!.n, 0);
    } finally { await f.close(); }
  });
}

test("GitHub sequential copies enforce intermediate file and byte budgets before later cleanup", async () => {
  const f = await fixture();
  try {
    f.trees.get(f.treeId)!.push({ path: "a/x", mode: "100644", type: "blob", sha: f.addBlob(""), size: 0 });
    const operations: FileMutationInput["operations"] = [];
    for (let index = 0; index < 13; index++) operations.push({ type: "copy", path: "a", destination: `b${index}` }, { type: "copy", path: `b${index}`, destination: `a/n${index}` });
    operations.push({ type: "delete", path: "a" });
    for (let index = 0; index < 13; index++) operations.push({ type: "delete", path: `b${index}` });
    await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, operations, "intermediate-file-budget")), hasCode("github_source_limit"));
    f.trees.get(f.treeId)!.find(entry => entry.path === "a/x")!.size = 64 * 1024 * 1024;
    await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(f.base, [
      { type: "copy", path: "a", destination: "large-copy" }, { type: "delete", path: "large-copy" },
    ], "intermediate-byte-budget")), hasCode("github_source_limit"));
    assert.equal(f.calls.some(call => call.method !== "GET"), false);
    assert.equal(f.refs.has(f.branch), false);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM github_file_mutation_receipts").get()!.n, 0);
  } finally { await f.close(); }
});

test("GitHub browser fails closed on truncated trees, secret contents, oversized selected files and target mismatches", async () => {
  const f = await fixture();
  try {
    f.truncate(true);
    await assert.rejects(f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: "main" }), hasCode("github_source_limit"));
    f.truncate(false);
    const tree = f.trees.get(f.treeId)!;
    tree.push({ path: "secret.txt", mode: "100644", type: "blob", sha: f.addBlob(b64(`ghp_${"x".repeat(30)}`)), size: 34 });
    await assert.rejects(f.files.content(f.actor, f.project.id, { provider: "github", branch_id: "main", path: "secret.txt" }), hasCode("file_secret"));
    tree.push({ path: "large.pdf", mode: "100644", type: "blob", sha: sha("large"), size: 8 * 1024 * 1024 + 1 });
    const before = f.calls.filter(call => call.path.includes("/git/blobs/")).length;
    await assert.rejects(f.files.content(f.actor, f.project.id, { provider: "github", branch_id: "main", path: "large.pdf" }), hasCode("github_source_limit"));
    assert.equal(f.calls.filter(call => call.path.includes("/git/blobs/")).length, before);
    f.database.sqlite.prepare("UPDATE hosted_github_bindings SET repository='other/repository' WHERE user_id=?").run(f.actor.user_id);
    await assert.rejects(f.files.branches(f.actor, f.project.id, { provider: "github" }), hasCode("github_connection_required"));
  } finally { await f.close(); }
});

test("GitHub browser accepts the exact 8 MiB binary boundary and over 1000 metadata entries without loading other blobs", async () => {
  const f = await fixture();
  try {
    const data = Buffer.alloc(8 * 1024 * 1024, 0), encoded = data.toString("base64");
    const result = await f.files.mutate(f.actor, f.project.id, mutation(f.base, [{ type: "write", path: "large.pdf", content_base64: encoded }], "exact-eight-mib"));
    const content = await f.files.content(f.actor, f.project.id, { provider: "github", branch_id: result.branch_id, path: "large.pdf" });
    assert.equal(content.size, data.length); assert.equal(content.content_base64, encoded);
    const entries = f.trees.get(f.treeId)!;
    for (let index = 0; index < 1100; index++) entries.push({ path: `many/${index}.txt`, mode: "100644", type: "blob", sha: f.addBlob(""), size: 0 });
    const before = f.calls.filter(call => call.path.includes("/git/blobs/")).length;
    const tree = await f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: "main" });
    assert.equal(tree.entries.length, 1103); assert.equal(f.calls.filter(call => call.path.includes("/git/blobs/")).length, before);
  } finally { await f.close(); }
});

test("GitHub file writes stop after revocation during blob creation and do not advance any ref", async () => {
  const f = await fixture();
  try {
    f.after((path, method) => { if (path.endsWith("/git/blobs") && method === "POST") f.service.setProjectMembership(f.actor, f.project.id, f.member.user_id, "viewer"); });
    await assert.rejects(f.files.mutate(f.member, f.project.id, mutation(f.base, [{ type: "write", path: "new.txt", content_base64: b64("source") }], "revoke-during-blob")), hasCode("file_read_only"));
    assert.equal(f.refs.has(f.memberBranch), false);
    assert.equal(f.calls.some(call => call.method === "POST" && !call.path.endsWith("/git/blobs")), false);
  } finally { await f.close(); }
});

test("GitHub selected member branch access stops before the next request if its owner leaves", async () => {
  const f = await fixture();
  try {
    f.refs.set(f.memberBranch, f.base);
    let armed = true;
    f.after((path, method) => { if (armed && path.includes("/git/commits/") && method === "GET") {
      armed = false; f.service.removeProjectMembership(f.actor, f.project.id, f.member.user_id);
    } });
    await assert.rejects(f.files.tree(f.actor, f.project.id, { provider: "github", branch_id: f.memberBranch }), hasCode("file_branch_unavailable"));
    assert.equal(f.calls.some(call => call.path.includes("/git/trees/")), false);
  } finally { await f.close(); }
});

test("a role downgrade while reading updates can_write without removing authorized viewer reads", async () => {
  const f = await fixture();
  try {
    f.after((path, method) => { if (path.includes("/git/trees/") && method === "GET") f.service.setProjectMembership(f.actor, f.project.id, f.member.user_id, "viewer"); });
    const result = await f.files.tree(f.member, f.project.id, { provider: "github", branch_id: "own" });
    assert.equal(result.can_write, false); assert.equal(result.entries.length, 3);
  } finally { await f.close(); }
});

test("existing own-branch updates use non-force parents and local concurrent saves cannot overwrite each other", async () => {
  const f = await fixture();
  try {
    const firstInput = mutation(f.base, [{ type: "write", path: "one.txt", content_base64: b64("one") }], "first-browser-save");
    const first = await f.files.mutate(f.actor, f.project.id, firstInput);
    const results = await Promise.allSettled([
      f.files.mutate(f.actor, f.project.id, mutation(first.commit, [{ type: "write", path: "two.txt", content_base64: b64("two") }], "second-browser-save")),
      f.files.mutate(f.actor, f.project.id, mutation(first.commit, [{ type: "write", path: "three.txt", content_base64: b64("three") }], "parallel-browser-save")),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && hasCode("file_head_changed")(result.reason)).length, 1);
    const current = f.refs.get(f.branch)!;
    assert.equal(f.commits.get(current)!.parents[0]!.sha, first.commit);
    assert.ok(f.calls.filter(call => call.method === "PATCH").every(call => call.body.force === false));
    const writes = f.calls.filter(call => call.method !== "GET").length;
    assert.equal((await f.files.mutate(f.actor, f.project.id, firstInput)).commit, first.commit);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, writes);
  } finally { await f.close(); }
});

test("browser receipt metadata is bounded without expiring accepted idempotency keys or charging source storage", async () => {
  const f = await fixture();
  try {
    const input = mutation(f.base, [{ type: "delete", path: "README.md" }], "retained-browser-save");
    const saved = await f.files.mutate(f.actor, f.project.id, input);
    f.database.sqlite.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<9999)
      INSERT INTO github_file_mutation_receipts SELECT ?,?,'bounded-key-'||n,'fingerprint',123,'binding','connection',0,?, ?,NULL,?,NULL FROM numbers`)
      .run(f.actor.user_id, f.project.id, f.branch, f.base, new Date().toISOString());
    const writes = f.calls.filter(call => call.method !== "GET").length;
    await assert.rejects(f.files.mutate(f.actor, f.project.id, mutation(saved.commit, [{ type: "write", path: "later.txt", content_base64: b64("later") }], "over-receipt-limit")), hasCode("file_receipt_limit"));
    assert.equal(f.calls.filter(call => call.method !== "GET").length, writes);
    assert.equal((await f.files.mutate(f.actor, f.project.id, input)).commit, saved.commit);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM github_file_mutation_receipts").get()!.n, 10000);
  } finally { await f.close(); }
});
