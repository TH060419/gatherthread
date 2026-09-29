import assert from "node:assert/strict";
import test from "node:test";
import { connectGitHubAccount, type GitHubAuthCommand } from "../src/github-auth.js";

test("GitHub browser login starts only when this device lacks a persistent login", async () => {
  const calls: string[][] = [];
  const command: GitHubAuthCommand = async (args) => {
    calls.push([...args]);
    return calls.length !== 1;
  };
  await connectGitHubAccount(command);
  assert.deepEqual(calls, [
    ["auth", "status", "--hostname", "github.com"],
    ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"],
    ["auth", "status", "--hostname", "github.com"],
  ]);
  calls.length = 0;
  await connectGitHubAccount(async (args) => { calls.push([...args]); return true; });
  assert.equal(calls.length, 1);
});

test("cancelled GitHub browser login cannot claim a connected device", async () => {
  await assert.rejects(connectGitHubAccount(async () => false), { code: "github_auth_failed" });
});
