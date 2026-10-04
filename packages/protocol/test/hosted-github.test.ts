import assert from "node:assert/strict";
import test from "node:test";
import { HostedGithubAuthorizationSchema, HostedGithubStatusSchema, HostedGithubConnectionSchema,
  HostedGithubDisconnectionSchema, HostedGithubTaskSchema, HostedGithubTaskSummarySchema, HostedGithubTaskListSchema,
  HostedGithubChangeSchema } from "../src/hosted-github.js";

const summary = { id: `gh-task-${"a".repeat(32)}`, session_id: "session", profile_id: "coding", resumable: false,
  state: "running", repository: "owner/project", base_branch: "main", base_sha: null, revision: null,
  error_code: null, pull_request_url: null, expires_at: 1_800_000_000_000 };
const detail = { ...summary, answer: null, changes: [] };
const status = { enabled: true, connected: true, login: "fixture", binding: { repository: "owner/project", base_branch: "main" },
  installation_url: "https://github.com/apps/fixture/installations/new" };
const change = { path: "src/index.ts", before_base64: null, after_base64: "", before_executable: null, after_executable: false };

test("hosted GitHub public responses are strict and exclude private storage fields", () => {
  const values = [[HostedGithubStatusSchema, { enabled: false }], [HostedGithubStatusSchema, status],
    [HostedGithubAuthorizationSchema, { authorization_url: `https://github.com/login/oauth/authorize?state=${"a".repeat(43)}` }],
    [HostedGithubConnectionSchema, { connected: true, login: "fixture" }], [HostedGithubDisconnectionSchema, { connected: false }],
    [HostedGithubTaskSummarySchema, summary], [HostedGithubTaskSchema, detail], [HostedGithubTaskListSchema, { tasks: [summary] }]] as const;
  for (const [schema, value] of values) {
    assert.ok(schema.safeParse(value).success);
    for (const key of ["credentials", "verifier", "generation", "input_fingerprint", "initial_files", "starting_files", "device_id"]) {
      assert.equal(schema.safeParse({ ...value, [key]: "private-fixture" }).success, false, key);
    }
  }
  assert.equal(HostedGithubTaskListSchema.safeParse({ tasks: [detail] }).success, false);
  assert.equal(HostedGithubStatusSchema.safeParse({ ...status, binding: { ...status.binding, revision: "private" } }).success, false);
  assert.equal(HostedGithubStatusSchema.safeParse({ ...status, connected: false }).success, false);
});

test("hosted GitHub rejects invalid URLs, enum values and wire identifiers", () => {
  for (const authorization_url of ["https://attacker.invalid/login/oauth/authorize", "http://github.com/login/oauth/authorize",
    `https://github.com/login/oauth/authorize?state=${"a".repeat(43)}&access_token=private`,
    `https://github.com/login/oauth/authorize?state=${"a".repeat(43)}#private`, "https://github.com/login/oauth/authorize?state=short"]) {
    assert.equal(HostedGithubAuthorizationSchema.safeParse({ authorization_url }).success, false);
  }
  for (const patch of [{ id: "task" }, { profile_id: "a/b" }, { state: "unknown" }, { base_sha: "g".repeat(40) },
    { revision: "a".repeat(40) }, { expires_at: -1 }, { expires_at: 1.5 }, { error_code: "private message" },
    { pull_request_url: "https://github.com/owner/project/pull/1?token=secret" }, { resumable: true }]) {
    assert.equal(HostedGithubTaskSchema.safeParse({ ...detail, ...patch }).success, false);
  }
  assert.ok(HostedGithubTaskSchema.safeParse({ ...detail, state: "failed", error_code: "github_access", resumable: true }).success);
  assert.ok(HostedGithubTaskSchema.safeParse({ ...detail, state: "completed", revision: "b".repeat(64),
    pull_request_url: "https://github.com/owner/project/pull/1" }).success);
});

test("hosted GitHub changes enforce safe paths, base64, modes and private source bounds", () => {
  assert.ok(HostedGithubChangeSchema.safeParse(change).success);
  for (const patch of [{ path: "../secret" }, { path: ".env" }, { after_base64: "!!==" }, { after_base64: "abc" },
    { after_executable: null }, { after_base64: null }]) assert.equal(HostedGithubChangeSchema.safeParse({ ...change, ...patch }).success, false);
  const twoMiB = Buffer.alloc(2 * 1024 * 1024).toString("base64");
  assert.ok(HostedGithubChangeSchema.safeParse({ ...change, after_base64: twoMiB }).success);
  assert.equal(HostedGithubChangeSchema.safeParse({ ...change, after_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }).success, false);
  const four = Array.from({ length: 4 }, (_, i) => ({ ...change, path: `src/${i}.ts`, after_base64: twoMiB }));
  assert.ok(HostedGithubTaskSchema.safeParse({ ...detail, changes: four }).success);
  assert.equal(HostedGithubTaskSchema.safeParse({ ...detail, changes: [...four, { ...change, path: "src/extra.ts", after_base64: "YQ==" }] }).success, false);
  assert.equal(HostedGithubTaskSchema.safeParse({ ...detail, changes: [change, change] }).success, false);
  assert.equal(HostedGithubTaskSchema.safeParse({ ...detail, answer: "a".repeat(14001) }).success, false);
  assert.equal(HostedGithubTaskSchema.safeParse({ ...detail, changes: Array.from({ length: 1001 }, (_, i) => ({ ...change, path: `src/${i}.ts` })) }).success, false);
  assert.ok(HostedGithubTaskListSchema.safeParse({ tasks: Array(10).fill(summary) }).success);
  assert.equal(HostedGithubTaskListSchema.safeParse({ tasks: Array(11).fill(summary) }).success, false);
});
