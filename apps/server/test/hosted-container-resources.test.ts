import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, hostedContainerMemoryMiB, runDocker, type HostedAgentOptions } from "../src/hosted-agent.js";
import { hostedDockerEnvironment, stopInterruptedHostedContainers } from "../src/hosted-agent-recovery.js";
import { HostedRepositoryRunner } from "../src/hosted-repository-runner.js";
import type { CodeFile } from "@gatherthread/protocol";

const unixTest = process.platform === "win32" ? test.skip : test;
const options: HostedAgentOptions = { image: `sha256:${"a".repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20,
  maxConcurrent: 1, endpoints: [{ id: "fixture", profileId: "fixture", label: "Fixture", provider: "openai-compatible",
    model: "fixture", baseUrl: "https://fixture.invalid/v1", apiToken: "fixture-only-model-key", quotaGroup: "fixture",
    dailyRuns: 20, maxConcurrent: 1 }] };
const file = (path: string, content: string): CodeFile => ({ path, content_base64: Buffer.from(content).toString("base64"), executable: false });
const files = [file("package.json", '{"name":"fixture","version":"1.0.0"}'),
  file("package-lock.json", '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}')];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gt-resources-"));
  const db = new CollaborationDatabase(join(directory, "db"), { authTokenPepper: "resource-fixture-private-pepper" });
  const service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Fixture" }).actor;
  const session = service.createSession(actor, { session_id: "resource-fixture", idempotency_key: "resource-create",
    title: "Fixture", mode: "solo" }).session;
  return { directory, db, service, actor, session, code: new CodeRepository(db, join(directory, "code")),
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("direct runner options reject invalid memory and preserve original default ceilings", () => {
  const f = fixture();
  try {
    assert.equal(hostedContainerMemoryMiB("trial"), 768);
    assert.equal(hostedContainerMemoryMiB("repository"), 2048);
    for (const value of [0, 255, 512.5, NaN, Infinity, 9007199254740992]) {
      assert.throws(() => new HostedAgent(f.service, f.code, { ...options, memoryMiB: value }), /memory/);
      assert.throws(() => new HostedAgent(f.service, f.code, { ...options, repositoryMemoryMiB: value }), /memory/);
      assert.throws(() => new HostedRepositoryRunner({ ...options, repositoryMemoryMiB: value }), /memory/);
    }
    assert.throws(() => new HostedAgent(f.service, f.code, { ...options, memoryMiB: 769 }), /memory/);
    assert.throws(() => new HostedRepositoryRunner({ ...options, repositoryMemoryMiB: 2049 }), /memory/);
    assert.throws(() => hostedContainerMemoryMiB("trial", null as unknown as number), /memory/);
  } finally { f.close(); }
});

unixTest("trial reduction sets RAM and combined RAM/swap equally, retaining isolation", async () => {
  const f = fixture();
  try {
    const agent = new HostedAgent(f.service, f.code, { ...options, memoryMiB: 512, repositoryMemoryMiB: 256,
      runContainer: async (args) => {
        assert.equal(args[args.indexOf("--memory") + 1], "512m");
        assert.equal(args[args.indexOf("--memory-swap") + 1], "512m");
        for (const argument of ["none", "--read-only", "ALL", "no-new-privileges", "10001:10001"]) assert.ok(args.includes(argument));
        assert.equal(args[args.indexOf("--pids-limit") + 1], "128");
        assert.equal(args[args.indexOf("--cpus") + 1], "1");
        return JSON.stringify({ answer: "Fixture completed", files: [], save_error: null });
      } });
    const result = await agent.request(f.actor, f.session.id, { profile_id: "fixture", content: "Fixture",
      include_code: false, idempotency_key: "low-memory-trial" });
    assert.equal((result.response_event?.payload as { status: string }).status, "completed");
  } finally { f.close(); }
});

unixTest("repository reduction uses its independent cap and retains source/network boundaries", async () => {
  const runner = new HostedRepositoryRunner({ ...options, memoryMiB: 256, repositoryMemoryMiB: 512,
    runContainer: async (args, timeout) => {
      assert.equal(args[args.indexOf("--memory") + 1], "512m");
      assert.equal(args[args.indexOf("--memory-swap") + 1], "512m");
      assert.equal(args[args.indexOf("--cpus") + 1], "2");
      assert.equal(args[args.indexOf("--pids-limit") + 1], "256");
      assert.equal(timeout, 900_000);
      for (const argument of ["none", "--read-only", "ALL", "no-new-privileges", "10001:10001"]) assert.ok(args.includes(argument));
      assert.ok(args.some((arg) => arg.endsWith("dst=/input,readonly")));
      assert.ok(args.some((arg) => arg.endsWith("dst=/run/npm.sock")));
      assert.ok(!args.join(" ").includes(options.endpoints[0]!.apiToken));
      return JSON.stringify({ answer: "Fixture completed", files, save_error: null });
    } });
  assert.deepEqual((await runner.run(files, "Fixture", options.endpoints[0]!, () => undefined)).files, files);
});

unixTest("low-memory container failure never saves a partial answer or reports success", async () => {
  const f = fixture();
  try {
    const agent = new HostedAgent(f.service, f.code, { ...options, memoryMiB: 512,
      runContainer: async () => { throw new Error("container_failed"); } });
    const result = await agent.request(f.actor, f.session.id, { profile_id: "fixture", content: "Fixture",
      include_code: false, idempotency_key: "low-memory-failure" });
    assert.equal((result.response_event?.payload as { status: string }).status, "failed");
    assert.equal(f.db.hostedActiveRuns(), 0);
    assert.equal(f.db.sqlite.prepare("SELECT status FROM hosted_agent_runs").get()!.status, "failed");
    const runner = new HostedRepositoryRunner({ ...options, repositoryMemoryMiB: 512,
      runContainer: async () => { throw new Error("container_failed"); } });
    await assert.rejects(runner.run(files, "Fixture", options.endpoints[0]!, () => undefined), /container_failed/);
  } finally { f.close(); }
});

test("Docker CLI env permits only a pinned local daemon and excludes API credentials", () => {
  const environment = { PATH: "/fixture/bin", HOME: "/fixture/home", DOCKER_HOST: "unix:///run/user/1001/docker.sock",
    GATHERTHREAD_SILICONFLOW_API_KEY: "fixture-model-secret", GATHERTHREAD_HOSTED_GITHUB_CLIENT_SECRET: "fixture-app-secret",
    GITHUB_TOKEN: "fixture-github-secret", HTTPS_PROXY: "https://private-proxy.invalid" };
  assert.deepEqual(hostedDockerEnvironment(environment), { PATH: "/fixture/bin", HOME: "/fixture/home",
    DOCKER_HOST: "unix:///run/user/1001/docker.sock" });
  assert.equal(hostedDockerEnvironment({}).DOCKER_HOST, "unix:///var/run/docker.sock");
  for (const host of ["tcp://localhost:2375", "ssh://runner", "unix://relative", "unix:///", "unix:///run/docker.sock?x=1",
    "unix:///run/docker.sock\n"]) assert.throws(() => hostedDockerEnvironment({ DOCKER_HOST: host }), /Unix socket/);
  for (const name of ["DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG"]) {
    assert.throws(() => hostedDockerEnvironment({ [name]: "fixture" }), /unsupported/);
  }
});

unixTest("actual Docker client invocations use the same local daemon for readiness, execution and cleanup", async () => {
  const f = fixture();
  const capture = join(f.directory, "calls.jsonl"), marker = join(f.directory, "present"), binary = join(f.directory, "docker");
  const home = join(f.directory, "home");
  mkdirSync(join(home, ".docker"), { recursive: true });
  writeFileSync(join(home, ".docker", "config.json"), JSON.stringify({ currentContext: "unreviewed-remote",
    credsStore: "unreviewed-helper", proxies: { default: { httpsProxy: "https://fixture-private-proxy.invalid" } } }));
  writeFileSync(marker, "gt-hosted-aaaaaaaaaaaaaaaa");
  writeFileSync(binary, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2), config = process.env.DOCKER_CONFIG;
const entries = fs.readdirSync(config), mode = fs.statSync(config).mode & 0o777;
if (entries.length || mode !== 0o700 || config === process.env.HOME + '/.docker') process.exit(1);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, env: process.env, entries, mode}) + '\\n');
if (args[0] === 'ps' && fs.existsSync(${JSON.stringify(marker)})) process.stdout.write(fs.readFileSync(${JSON.stringify(marker)}));
if (args[0] === 'rm') fs.unlinkSync(${JSON.stringify(marker)});
if (args.includes('--fixture-exit137')) process.exit(137);
if (args[0] === 'run') process.stdout.write(JSON.stringify({answer:'Fixture completed',files:[],save_error:null}));\n`);
  chmodSync(binary, 0o755);
  const names = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG",
    "GATHERTHREAD_SILICONFLOW_API_KEY", "GATHERTHREAD_HOSTED_GITHUB_CLIENT_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.PATH = `${f.directory}:${saved.PATH ?? "/usr/bin:/bin"}`;
    process.env.HOME = home;
    process.env.DOCKER_HOST = "unix:///run/user/1001/docker.sock";
    process.env.GATHERTHREAD_SILICONFLOW_API_KEY = "fixture-model-secret";
    process.env.GATHERTHREAD_HOSTED_GITHUB_CLIENT_SECRET = "fixture-app-secret";
    stopInterruptedHostedContainers();
    const agent = new HostedAgent(f.service, f.code, { ...options, memoryMiB: 512 });
    const result = await agent.request(f.actor, f.session.id, { profile_id: "fixture", content: "Fixture",
      include_code: false, idempotency_key: "same-daemon-trial" });
    assert.equal((result.response_event?.payload as { status: string }).status, "completed");
    await assert.rejects(runDocker(["run", "--fixture-exit137"], 5_000), /container_failed/);
    const calls = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      args: string[]; env: Record<string, string>; entries: string[]; mode: number });
    for (const command of ["ps", "rm", "info", "image", "run"]) assert.ok(calls.some((call) => call.args[0] === command));
    assert.ok(calls.every((call) => call.env.DOCKER_HOST === "unix:///run/user/1001/docker.sock"));
    // macOS injects this locale key into native child processes independently of env.
    for (const call of calls) assert.deepEqual(Object.keys(call.env).filter((name) =>
      process.platform !== "darwin" || name !== "__CF_USER_TEXT_ENCODING").sort(), ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG"].sort());
    assert.ok(calls.every((call) => call.entries.length === 0 && call.mode === 0o700));
    assert.ok(calls.every((call) => !existsSync(call.env.DOCKER_CONFIG!)));
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    f.close();
  }
});
