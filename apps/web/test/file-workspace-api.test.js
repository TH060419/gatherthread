import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, HttpCollaborationApi } from "../src/api.js";

const head = "a".repeat(40), base = "b".repeat(40), branch = "feature/a b", path = "docs/文 档#1.pdf";
const selected = { provider: "github", branch_id: branch, connection_revision: "revision-one" };
const responses = {
  branches: { provider: "github", branches: [{ id: "main", name: "main", user_id: null, head_commit: head, can_write: false }], default_branch_id: "main", connection_revision: "revision-one" },
  tree: { ...selected, commit: base, head_commit: head, can_write: false, entries: [{ path, size: 3, executable: false }] },
  content: { ...selected, commit: base, path, content_base64: "AAH/", size: 3, executable: false },
  history: { ...selected, commits: [{ id: head, parent_ids: [base], message: "Change", author_name: "Example collaborator", created_at: "2026-10-18T00:00:00Z" }], next_cursor: head },
  changes: { ...selected, base_commit: base, commit: head, files: [{ path, status: "modified" }] },
  mutations: { ...selected, commit: head },
};
const mutation = { provider: "github", branch_id: branch, connection_revision: "revision-one", base_commit: base,
  operations: [{ type: "write", path: "src/main.ts", content_base64: btoa("let a = 1;\n"), executable: false }],
  message: "Save original operation", idempotency_key: "stable-file-save-1" };

async function capture(work, responder = (action) => responses[action]) {
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const action = new URL(url, "https://same-origin.test").pathname.split("/").at(-1);
    return Response.json({ data: structuredClone(responder(action, requests.length)) });
  };
  try { await work(new HttpCollaborationApi(), requests); }
  finally { globalThis.fetch = originalFetch; }
}

test("five file reads encode exact project and query values, retain cookies and keep AbortSignal out of the wire", async () => {
  await capture(async (api, requests) => {
    const project = "project / 中", controller = new AbortController();
    const cases = [
      ["getFileBranches", { provider: "github", connection_revision: "revision-one", signal: controller.signal }, "branches?provider=github&connection_revision=revision-one"],
      ["getFileTree", { ...selected, commit: base, signal: controller.signal, omitted: undefined }, `tree?provider=github&branch_id=feature%2Fa+b&connection_revision=revision-one&commit=${base}`],
      ["getFileContent", { ...selected, commit: base, path, signal: controller.signal }, `content?provider=github&branch_id=feature%2Fa+b&connection_revision=revision-one&commit=${base}&path=docs%2F%E6%96%87+%E6%A1%A3%231.pdf`],
      ["getFileHistory", { ...selected, commit: base, path, cursor: head, limit: 7, signal: controller.signal }, `history?provider=github&branch_id=feature%2Fa+b&connection_revision=revision-one&commit=${base}&path=docs%2F%E6%96%87+%E6%A1%A3%231.pdf&cursor=${head}&limit=7`],
      ["getFileChanges", { ...selected, commit: head, base_commit: base, signal: controller.signal }, `changes?provider=github&branch_id=feature%2Fa+b&connection_revision=revision-one&commit=${head}&base_commit=${base}`],
    ];
    for (const [method, input, query] of cases) {
      const result = await api[method](project, input), request = requests.at(-1);
      assert.deepEqual(result, responses[query.split("?")[0]]);
      assert.equal(request.url, `/v1/projects/project%20%2F%20%E4%B8%AD/files/${query}`);
      assert.equal(request.options.method ?? "GET", "GET");
      assert.equal(request.options.credentials, "include");
      assert.equal(request.options.signal, controller.signal);
      assert.equal(request.options.headers.Authorization, undefined);
      assert.equal(request.options.body, undefined);
      assert.equal(new URL(request.url, "https://same-origin.test").searchParams.has("signal"), false);
      assert.equal(new URL(request.url, "https://same-origin.test").hash, "");
    }
    assert.equal(requests.length, 5);
  });
});

test("file mutation parses a strict body before dispatch and preserves the exact original retry key and Cookie credentials", async () => {
  await capture(async (api, requests) => {
    const controller = new AbortController();
    const input = { ...mutation, message: "  Save original operation  " };
    await api.mutateFiles("project / one", input, { signal: controller.signal });
    await api.mutateFiles("project / one", input, { signal: controller.signal });
    for (const request of requests) {
      assert.equal(request.url, "/v1/projects/project%20%2F%20one/files/mutations");
      assert.equal(request.options.method, "POST"); assert.equal(request.options.credentials, "include");
      assert.equal(request.options.signal, controller.signal);
      assert.equal(request.options.headers["Content-Type"], "application/json");
      assert.equal(request.options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(request.options.body), mutation);
      assert.equal(request.options.body.includes("signal"), false);
    }
    assert.equal(requests[0].options.body, requests[1].options.body);
    assert.equal(input.message, "  Save original operation  ", "parsing must not mutate the caller's original body");
  });
});

test("every file response refuses unknown or malformed fields with one safe error", async () => {
  const cases = [
    ["getFileBranches", "branches", { provider: "github" }, (value) => ({ ...value, credential: "PRIVATE_RESPONSE_FIXTURE" })],
    ["getFileTree", "tree", selected, (value) => ({ ...value, entries: [{ ...value.entries[0], content_base64: "PRIVATE_RESPONSE_FIXTURE" }] })],
    ["getFileContent", "content", { ...selected, path }, (value) => ({ ...value, content_base64: "not base64!" })],
    ["getFileHistory", "history", selected, (value) => ({ ...value, commits: [{ ...value.commits[0], parent_ids: ["HEAD"] }] })],
    ["getFileChanges", "changes", selected, (value) => ({ ...value, files: [{ path, status: "renamed" }] })],
    ["mutateFiles", "mutations", mutation, (value) => ({ ...value, private_key: "PRIVATE_RESPONSE_FIXTURE" })],
  ];
  for (const [method, action, input, invalidate] of cases) {
    await capture(async (api, requests) => {
      await assert.rejects(api[method]("project", input), (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502); assert.equal(error.code, "invalid_file_response");
        assert.doesNotMatch(error.message, /PRIVATE_RESPONSE_FIXTURE|not base64|HEAD/u);
        return true;
      });
      assert.equal(requests.length, 1);
    }, (received) => { assert.equal(received, action); return invalidate(structuredClone(responses[action])); });
  }
});

test("malformed mutation inputs never reach fetch or silently lose unsupported fields", async () => {
  await capture(async (api, requests) => {
    for (const input of [
      { ...mutation, unexpected: true }, { ...mutation, base_commit: "main~1" },
      { ...mutation, idempotency_key: "short" }, { ...mutation, operations: [] },
      { ...mutation, operations: [{ type: "write", path: "../outside", content_base64: "" }] },
      { ...mutation, operations: [{ type: "move", path: "safe", destination: ".git/config" }] },
      { ...mutation, operations: [{ type: "delete", path: "safe", overwrite: true }] },
      { ...mutation, operations: Array(101).fill({ type: "delete", path: "safe" }) },
    ]) await assert.rejects(api.mutateFiles("project", input));
    assert.equal(requests.length, 0);
  });
});

test("file transport cancellation reaches fetch and keeps AbortSignal out of queries and JSON", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, options) => new Promise((_resolve, reject) => {
    requests.push({ url, options });
    if (options.signal.aborted) reject(options.signal.reason);
    else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  try {
    const api = new HttpCollaborationApi();
    for (const mutate of [false, true]) {
      const controller = new AbortController(), reason = new Error("file-read-scope-ended");
      const pending = mutate ? api.mutateFiles("project", mutation, { signal: controller.signal })
        : api.getFileTree("project", { ...selected, signal: controller.signal });
      controller.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
      const request = requests.at(-1);
      assert.equal(request.options.signal, controller.signal);
      assert.equal(new URL(request.url, "https://same-origin.test").searchParams.has("signal"), false);
      assert.equal(request.options.body?.includes("signal") ?? false, false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("file HTTP errors preserve the server's actionable status and stable code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: "code_stale_head", message: "Cloud code changed." } }, { status: 409 });
  try {
    await assert.rejects(new HttpCollaborationApi().mutateFiles("project", mutation),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "code_stale_head");
  } finally { globalThis.fetch = originalFetch; }
});
