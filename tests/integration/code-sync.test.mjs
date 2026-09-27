import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { HttpCollaborationClient, ProjectCodeSync } from "../../packages/bridge/dist/src/index.js";
import { processCodeSyncControlJobs } from "../../packages/bridge/dist/src/codex-connect.js";

async function request(origin, path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload.data;
}

test("real HTTP Git checkpoints support two collaborators, cross-device conflict safety and lost-workspace recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gatherthread-code-stack-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "stack.sqlite") }, 0);
  try {
    const owner = running.database.bootstrapIdentity({ user_id: "alice", display_name: "Alice", device_id: "alice-codex", device_name: "Codex laptop" });
    const projectId = "code-collaboration";
    const codePath = `/v1/projects/${projectId}/code`;
    await request(running.origin, "/v1/projects", {
      method: "POST", token: owner.token,
      body: { project_id: projectId, idempotency_key: "create-code-collaboration", title: "Collaborative source" },
    });
    await request(running.origin, `/v1/projects/${projectId}/sessions`, {
      method: "POST", token: owner.token,
      body: { session_id: "code-session", idempotency_key: "create-code-session", title: "Shared coding task", mode: "multi" },
    });
    const invitation = await request(running.origin, `/v1/projects/${projectId}/invitations`, {
      method: "POST", token: owner.token, body: { role: "participant", ttl: "1h" },
    });
    const participant = await request(running.origin, "/v1/invitations/claim", {
      method: "POST", body: { invite_token: invitation.invite_token, user_id: "bob", display_name: "Bob", device_id: "bob-dsh", device_name: "DSH desktop" },
    });
    const secondDevice = running.database.createDevice("alice", "Second laptop", "alice-second");
    const managers = {};
    const workspaces = {};
    for (const [name, actorId, token] of [["alice", "alice", owner.token], ["alice-second", "alice", secondDevice.token], ["bob", "bob", participant.token]]) {
      const workspacePath = join(directory, name);
      await mkdir(workspacePath);
      workspaces[name] = workspacePath;
      managers[name] = new ProjectCodeSync({ apiUrl: running.origin, token, projectId, actorId, workspacePath, stateRoot: join(directory, `${name}-private`) });
    }
    await request(running.origin, `${codePath}/enable`, { method: "POST", token: owner.token, body: { idempotency_key: "enable-code-collaboration" } });
    await writeFile(join(workspaces.alice, "README.md"), "Shared project source\n");
    await writeFile(join(workspaces.alice, ".gitignore"), ".env\nnode_modules/\n");
    await writeFile(join(workspaces.alice, ".env"), "LOCAL_ONLY=fixture\n");
    const initial = await managers.alice.upload();
    assert.equal(initial.local_changes, 0);
    assert.equal(initial.automatic_upload, false);

    const reviewAndMerge = async (token, operationName) => {
      const status = await request(running.origin, codePath, { token });
      const own = status.branches.find((branch) => branch.id === status.own_branch_id);
      assert.ok(own);
      await request(running.origin, `${codePath}/review`, {
        method: "POST", token, body: { head_commit: own.head_commit, idempotency_key: `${operationName}-review` },
      });
      const current = await request(running.origin, codePath, { token: owner.token });
      return request(running.origin, `${codePath}/merge`, {
        method: "POST", token: owner.token,
        body: { branch_id: own.id, expected_main_commit: current.repository.main_commit, expected_head_commit: own.head_commit, idempotency_key: `${operationName}-merge` },
      });
    };
    await reviewAndMerge(owner.token, "initial-source");
    await managers.bob.download();
    await managers["alice-second"].download();
    assert.equal(await readFile(join(workspaces.bob, "README.md"), "utf8"), "Shared project source\n");
    await assert.rejects(readFile(join(workspaces.bob, ".env")), { code: "ENOENT" });
    assert.equal((await managers.bob.status()).branch_id, null, "reading main must not create a write branch");

    // Codex and DSH are deliberately irrelevant to the branch identity and file format.
    await writeFile(join(workspaces.alice, "alice.ts"), "export const alice = true;\n");
    const aliceWork = await managers.alice.upload();
    await writeFile(join(workspaces.bob, "bob.ts"), "export const bob = true;\n");
    const bobWork = await managers.bob.upload();
    assert.notEqual(aliceWork.branch_id, bobWork.branch_id);
    await reviewAndMerge(owner.token, "alice-work");
    await reviewAndMerge(participant.token, "bob-work");

    for (const [name, token] of [["alice", owner.token], ["bob", participant.token]]) {
      const status = await request(running.origin, codePath, { token });
      const own = status.branches.find((branch) => branch.id === status.own_branch_id);
      await request(running.origin, `${codePath}/update`, {
        method: "POST", token,
        body: { base_commit: own.head_commit, expected_main_commit: status.repository.main_commit, idempotency_key: `${name}-bring-main` },
      });
      await managers[name].download();
      assert.equal(await readFile(join(workspaces[name], "alice.ts"), "utf8"), "export const alice = true;\n");
      assert.equal(await readFile(join(workspaces[name], "bob.ts"), "utf8"), "export const bob = true;\n");
    }
    await writeFile(join(workspaces["alice-second"], "stale.txt"), "offline second-device work");
    await assert.rejects(managers["alice-second"].upload(), { code: "code_sync_conflict" });
    assert.equal(await readFile(join(workspaces["alice-second"], "stale.txt"), "utf8"), "offline second-device work");

    // Browser job -> exact connector runtime -> the same real HTTP code service.
    const api = new HttpCollaborationClient({ baseUrl: `${running.origin}/v1`, bearerToken: owner.token });
    const runtime = await api.registerRuntime({
      runtimeId: "code-codex-runtime", sessionId: "code-session", deviceId: "alice-codex",
      harness: "codex", provider: "openai", model: "test-model", localSessionId: "local-code-test", captureFidelity: "harness_transcript", purpose: "execution",
    });
    const beforeEvents = await api.readEvents("code-session", 0, 100);
    const job = await api.createSnapshotRequest("code-session", "code_sync_status", runtime.id);
    await processCodeSyncControlJobs({ api, managed: new Map([["code-session", { bridge: { runtime } }]]), codeSync: managers.alice, busy: false });
    const completed = await api.getSnapshotRequest(job.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.kind, "code_sync_status");
    assert.equal(completed.result.local_changes, 0);
    assert.ok(!JSON.stringify(completed).includes(directory));
    assert.equal((await api.readEvents("code-session", 0, 100)).nextSequence, beforeEvents.nextSequence, "code jobs must not append conversation content");

    // An interrupted multi-file write is never mistaken for a new code checkpoint.
    const bindingPath = join(directory, "alice-private", "binding.json");
    const binding = JSON.parse(await readFile(bindingPath, "utf8"));
    binding.interrupted_download = true;
    await writeFile(bindingPath, JSON.stringify(binding));
    const headBefore = (await managers.alice.status()).cloud_commit;
    await assert.rejects(managers.alice.upload(), { code: "code_sync_recovery_required" });
    assert.equal((await managers.alice.status()).cloud_commit, headBefore);

    // Entire source directory loss: restore into a new directory; never auto-rebind DSH.
    await rename(workspaces.bob, join(directory, "bob-source-backup"));
    const recovered = await managers.bob.recover();
    assert.ok(recovered.recovery_directory?.startsWith("bob-recovered-"));
    assert.equal(await readFile(join(directory, recovered.recovery_directory, "bob.ts"), "utf8"), "export const bob = true;\n");
    assert.equal(await readFile(join(directory, recovered.recovery_directory, "alice.ts"), "utf8"), "export const alice = true;\n");
    await assert.rejects(readFile(join(workspaces.bob, "bob.ts")), { code: "ENOENT" });
    const recoveryHome = join(directory, "recovery-cli-home");
    await mkdir(recoveryHome);
    const cliRecovery = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../packages/bridge/dist/src/codex-connect-bin.js", import.meta.url)),
      "--url", running.origin, "--project", projectId, "--workspace", workspaces.bob,
      "--recover-code", "--codex-command", "/codex-is-not-installed-for-this-test",
    ], { env: { ...process.env, HOME: recoveryHome, USERPROFILE: recoveryHome, GATHERTHREAD_TOKEN: participant.token }, timeout: 30_000 });
    assert.match(cliRecovery.stdout, /Recovered cloud code:/u);
    assert.ok(!cliRecovery.stdout.includes(participant.token));
    assert.ok(!cliRecovery.stdout.includes("App Server ready"));
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});
