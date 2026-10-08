import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CodeFile } from "@gatherthread/protocol";
import type { CodeRepository } from "../../src/code-repository.js";
import { CollaborationDatabase } from "../../src/database.js";
import { HostedAgent, type HostedAgentOptions } from "../../src/hosted-agent.js";
import { HostedRepositoryRunner } from "../../src/hosted-repository-runner.js";
import { CollaborationService } from "../../src/service.js";

const [mask, scenario, outcome, directory] = process.argv.slice(2);
assert.ok(mask && ["0022", "0077", "0027"].includes(mask));
assert.ok(scenario && ["trial-empty", "trial-code", "repository"].includes(scenario));
assert.ok(outcome && ["success", "failure"].includes(outcome));
assert.ok(directory);
assert.equal(resolve(tmpdir()), resolve(directory));
assert.notEqual(process.platform, "win32");

const file = (path: string, content: string, executable = false): CodeFile => ({
  path, content_base64: Buffer.from(content).toString("base64"), executable,
});
const files = [
  file("src/shared/deep/normal.txt", "permission fixture source\n"),
  file("src/shared/deep/run.sh", "#!/bin/sh\nexit 0\n", true),
  file("src/shared/other/deeper/second.txt", "shared ancestor fixture\n"),
  file("package.json", '{"name":"permission-fixture","version":"1.0.0","private":true}'),
  file("package-lock.json", '{"name":"permission-fixture","lockfileVersion":3,"packages":{"":{"name":"permission-fixture","version":"1.0.0"}}}'),
];
const sourceDirectories = ["src", "src/shared", "src/shared/deep", "src/shared/other", "src/shared/other/deeper"];
const endpoint = {
  id: "fixture", profileId: "fixture", label: "Fixture", provider: "openai-compatible" as const,
  model: "fixture", baseUrl: "https://fixture.invalid/v1", apiToken: "fixture-only-unused-key",
  quotaGroup: "fixture", dailyRuns: 4, maxConcurrent: 1,
};
const answer = "Fixture completed without executing a container or calling any provider.";
const containerFailure = new Error("fixture_container_failed");
let providerCalls = 0;
const parentBefore = lstatSync(directory);
assert.equal(parentBefore.mode & 0o777, 0o700);

type Entry = { path: string; info: Stats; content?: Buffer };
type Mount = { source: string; destination: string; readonly: boolean; info: Stats };
type Observation = { args: string[]; mounts: Mount[]; root: Entry; inputs: Entry[]; controls: Entry[] };
const observations: Observation[] = [];
const socketConnections: string[] = [];
let activeRunsDuringContainer: number | undefined;
let database: CollaborationDatabase | undefined;

async function localSocketConnect(path: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const socket = connect({ path });
    socket.once("error", reject);
    socket.once("connect", () => { socket.end(); });
    socket.once("close", (hadError) => { if (!hadError) accept(); });
  });
  socketConnections.push(path);
}

const options: HostedAgentOptions = {
  endpoints: [endpoint], image: `fixture/unused@sha256:${"b".repeat(64)}`,
  userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, userMaxConcurrent: 1,
  userMinIntervalSeconds: 30,
  fetch: async () => { providerCalls += 1; throw new Error("No provider or npm request permitted in this fixture"); },
  runContainer: async (args) => {
    const mounts = args.filter((arg) => arg.startsWith("type=bind,src=")).map((arg): Mount => {
      const matched = /^type=bind,src=(.*),dst=([^,]+)(,readonly)?$/u.exec(arg);
      assert.ok(matched?.[1] && matched[2], "expected a direct bind mount");
      return { source: matched[1], destination: matched[2], readonly: Boolean(matched[3]), info: lstatSync(matched[1]) };
    });
    const input = mounts.find((mount) => mount.destination === "/input");
    const control = mounts.find((mount) => mount.destination === "/run/gatherthread");
    assert.ok(input && control);
    const root = dirname(input.source);
    const inputs: Entry[] = [{ path: input.source, info: input.info }];
    if (scenario !== "trial-empty") {
      for (const path of sourceDirectories) inputs.push({ path, info: lstatSync(join(input.source, path)) });
      for (const source of files) inputs.push({ path: source.path, info: lstatSync(join(input.source, source.path)),
        content: readFileSync(join(input.source, source.path)) });
    }
    const controls = ["opencode.json", "prompt.txt"].map((path): Entry => ({
      path, info: lstatSync(join(control.source, path)), content: readFileSync(join(control.source, path)),
    }));
    // Assertions below run after request() returns: it catches container callback errors.
    observations.push({ args: [...args], mounts, root: { path: root, info: lstatSync(root) }, inputs, controls });
    activeRunsDuringContainer = database?.hostedActiveRuns();
    for (const mount of mounts.filter((item) => item.info.isSocket())) await localSocketConnect(mount.source);
    if (outcome === "failure") throw containerFailure;
    return JSON.stringify({ answer, files: scenario === "trial-empty" ? [] : files, save_error: null });
  },
};

try {
  // Prepare unrelated SQLite/account fixtures before applying the child-only umask.
  if (scenario !== "repository") {
    database = new CollaborationDatabase(join(directory, "fixture.sqlite"), { authTokenPepper: "mount-fixture-only-pepper" });
    const actor = database.bootstrapIdentity({ display_name: "Fixture", device_name: "Fixture" }).actor;
    const service = new CollaborationService(database);
    const session = service.createSession(actor, { session_id: "permission-fixture", idempotency_key: "permission-fixture",
      mode: "solo", title: "Permission fixture" }).session;
    let snapshots = 0;
    const repository = {
      status: () => { snapshots += 1; return { own_branch_id: "main" }; },
      snapshot: () => ({ snapshot: { commit: "fixture-commit", files } }),
      checkpoint: () => { throw new Error("Unchanged fixture must not create a code checkpoint"); },
    } as unknown as CodeRepository;
    process.umask(Number.parseInt(mask, 8));
    const result = await new HostedAgent(service, repository, options).request(actor, session.id, {
      profile_id: "fixture", content: "Permission fixture only", include_code: scenario === "trial-code",
      idempotency_key: "permission-fixture-run",
    });
    assert.equal(result.replayed, false);
    assert.equal(result.response_event?.type, "agent_response");
    const payload = result.response_event?.payload as { status: string; content: string };
    assert.equal(payload.status, outcome === "success" ? "completed" : "failed");
    if (outcome === "success") assert.equal(payload.content, answer);
    assert.equal(snapshots, scenario === "trial-code" ? 1 : 0, "no-code requests must not read project source");
    assert.equal(activeRunsDuringContainer, 1, "a running trial keeps its reserved slot");
    assert.equal(database.hostedActiveRuns(), 0, "successful and failed runners must release their slot after cleanup");
  } else {
    process.umask(Number.parseInt(mask, 8));
    const runner = new HostedRepositoryRunner(options);
    if (outcome === "failure") {
      await assert.rejects(runner.run(files, "Permission fixture only", endpoint, () => {
        throw new Error("Fixture must not report a provider outage");
      }), (error: unknown) => error === containerFailure);
    } else {
      const result = await runner.run(files, "Permission fixture only", endpoint, () => {
        throw new Error("Fixture must not report a provider outage");
      });
      assert.deepEqual(result, { answer, files });
    }
  }

  assert.equal(observations.length, 1, "the real runner must reach its fake container callback");
  assert.equal(providerCalls, 0, "neither model nor npm provider may be called");
  const record = observations[0]!;
  const parentAfter = lstatSync(directory);
  assert.equal(parentAfter.mode, parentBefore.mode, "runner must not relax its private parent");
  assert.equal(parentAfter.ino, parentBefore.ino);
  assert.equal(parentAfter.dev, parentBefore.dev);
  assert.equal(dirname(record.root.path), directory);
  assert.ok(record.root.info.isDirectory());
  assert.equal(record.root.info.mode & 0o777, 0o700, "host job root stays private");
  assert.equal(record.args[record.args.indexOf("--user") + 1], "10001:10001");
  for (const required of ["--read-only", "--network", "none", "--cap-drop", "ALL", "no-new-privileges"]) {
    assert.ok(record.args.includes(required), `container isolation missing ${required}`);
  }
  assert.ok(!record.args.join(" ").includes(endpoint.apiToken), "provider credential must never enter container arguments");
  const expectedMounts = scenario === "repository"
    ? ["/input", "/run/gatherthread", "/run/model.sock", "/run/npm.sock"]
    : ["/input", "/run/gatherthread", "/run/model.sock"];
  assert.deepEqual(record.mounts.map((mount) => mount.destination), expectedMounts);
  for (const mount of record.mounts) {
    assert.equal(existsSync(mount.source), false, "runner cleanup removes all bind sources including sockets");
  }
  assert.equal(existsSync(record.root.path), false, "successful and failed runner cleanup removes the private job root");
  assert.ok(readdirSync(directory).every((name) => !name.startsWith("gt-hosted-") && !name.startsWith("gt-repository-")),
    "no job directory survives settlement");
  for (const entry of record.controls) {
    assert.ok(entry.info.isFile());
    assert.equal(entry.info.mode & 0o777, 0o644, `${entry.path} readable control file under ${mask}`);
    assert.equal(entry.info.mode & 0o004, 0o004, "non-owner container needs readable config and prompt");
    assert.ok(entry.content?.length);
    assert.ok(!entry.content.toString("utf8").includes(endpoint.apiToken), "control files must not contain provider credentials");
  }
  for (const mount of record.mounts) {
    assert.equal(dirname(mount.source), record.root.path, "mount only job-local direct children");
    assert.ok(!mount.info.isSymbolicLink(), "mounted source must be a real inode");
    if (mount.destination.endsWith(".sock")) {
      assert.ok(mount.info.isSocket());
      assert.equal(mount.info.mode & 0o777, 0o666, `${mount.destination} connection mode`);
      assert.equal(mount.info.mode & 0o002, 0o002, "non-owner container needs Unix socket write permission to connect");
      assert.ok(socketConnections.includes(mount.source), "job-local proxy must actually accept a socket connection");
    } else {
      assert.ok(mount.info.isDirectory());
      assert.equal(mount.readonly, true, `${mount.destination} must be readonly`);
      assert.equal(mount.info.mode & 0o777, 0o755, `${mount.destination} readonly bind directory mode under ${mask}`);
      assert.equal(mount.info.mode & 0o005, 0o005, "non-owner container needs directory read and search permissions");
    }
  }
  for (const entry of record.inputs) {
    if (entry.info.isDirectory()) {
      assert.equal(entry.info.mode & 0o777, 0o755, `${entry.path} nested readonly input directory under ${mask}`);
      assert.equal(entry.info.mode & 0o005, 0o005, "all intermediate source ancestors must permit non-owner traversal");
    } else {
      const source = files.find((item) => item.path === entry.path)!;
      assert.ok(entry.info.isFile());
      assert.equal(entry.info.mode & 0o777, source.executable ? 0o755 : 0o644, `${entry.path} source file mode`);
      assert.deepEqual(entry.content, Buffer.from(source.content_base64, "base64"), "permission preparation preserves exact source bytes");
    }
  }
  process.stdout.write("hosted mount fixture passed\n");
} finally {
  database?.close();
}
