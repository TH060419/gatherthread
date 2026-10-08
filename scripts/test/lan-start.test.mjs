import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  caddyInstallHint,
  lanOrigin,
  parseLanStartArguments,
  privateLanAddresses,
} from "../lan-start.mjs";

const execFileAsync = promisify(execFile);
const INITIALIZE = `
import { initializeIfNeeded } from ${JSON.stringify(new URL("../lan-start.mjs", import.meta.url).href)};
if (process.stdin.isTTY || process.stdout.isTTY) throw new Error("initialization test requires a non-interactive process");
await initializeIfNeeded(".env");
`;

async function initializationFixture(t, { databasePath = ".local/collaboration.sqlite", pepper = "", databaseExists = false, initExitCode = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gatherthread-lan-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = join(directory, ".env");
  await writeFile(envPath, `GATHERTHREAD_DATABASE_PATH="${databasePath}"\nGATHERTHREAD_AUTH_TOKEN_PEPPER=${pepper}\n`, { mode: 0o600 });
  const npmPath = join(directory, "npm-fixture.mjs");
  await writeFile(npmPath, `process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = ${initExitCode};\n`);
  if (databaseExists) {
    await mkdir(dirname(join(directory, databasePath)), { recursive: true });
    await writeFile(join(directory, databasePath), "existing database fixture");
  }
  return { directory, envPath, npmPath };
}

function initializeFixture({ directory, npmPath }) {
  return execFileAsync(process.execPath, ["--input-type=module", "--eval", INITIALIZE], {
    cwd: directory,
    env: { ...process.env, npm_execpath: npmPath },
    timeout: 10_000,
  });
}

test("LAN one-command startup discovers only usable private interfaces", () => {
  assert.deepEqual(privateLanAddresses({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.50.20", family: "IPv4", internal: false }],
    bridge0: [{ address: "10.10.0.2", family: 4, internal: false }],
    public0: [{ address: "203.0.113.8", family: "IPv4", internal: false }],
    link0: [{ address: "fe80::1", family: "IPv6", internal: false }],
  }), [
    { interfaceName: "bridge0", address: "10.10.0.2", family: 4 },
    { interfaceName: "en0", address: "192.168.50.20", family: 4 },
  ]);
});

test("LAN one-command arguments stay explicit and bounded", () => {
  assert.deepEqual(parseLanStartArguments([
    "--address", "192.168.50.20",
    "--port", "9443",
  ]), {
    address: "192.168.50.20",
    port: 9443,
  });
  assert.deepEqual(parseLanStartArguments([]), { address: undefined, port: 8443 });
  assert.equal(lanOrigin("192.168.50.20", 9443), "https://192.168.50.20:9443");
  assert.equal(lanOrigin("fd00::20", 8443), "https://[fd00::20]:8443");
  assert.throws(() => parseLanStartArguments(["--address", "8.8.8.8"]), /private IP/);
  assert.throws(() => parseLanStartArguments(["--port", "443"]), /1024 to 65535/);
});

test("LAN startup explicitly refuses retired account arguments", () => {
  for (const option of ["--display-name", "--device-name"]) {
    assert.throws(() => parseLanStartArguments([option, "Example"]), /no longer supported.*creates no account/);
    assert.throws(() => parseLanStartArguments([option]), /no longer supported/);
  }
});

test("new LAN database initializes without a terminal or account arguments", async (t) => {
  const fixture = await initializationFixture(t);
  const contents = await readFile(fixture.envPath, "utf8");
  const result = await initializeFixture(fixture);
  assert.equal(result.stdout, JSON.stringify(["run", "owner-host:init"]));
  assert.equal(result.stderr, "");
  assert.equal(await readFile(fixture.envPath, "utf8"), contents);
});

test("existing LAN database keeps its pepper and skips initialization", async (t) => {
  const fixture = await initializationFixture(t, {
    databasePath: "private data/existing.sqlite",
    pepper: "test-pepper-not-a-production-credential",
    databaseExists: true,
  });
  const contents = await readFile(fixture.envPath, "utf8");
  const result = await initializeFixture(fixture);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(await readFile(fixture.envPath, "utf8"), contents);
  assert.equal(await readFile(join(fixture.directory, "private data/existing.sqlite"), "utf8"), "existing database fixture");
});

test("existing LAN database without its pepper fails before initialization", async (t) => {
  const fixture = await initializationFixture(t, { databaseExists: true });
  await assert.rejects(initializeFixture(fixture), (error) => {
    assert.match(error.stderr, /restore its original Pepper/);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("LAN initialization refuses a non-file database path", async (t) => {
  const fixture = await initializationFixture(t);
  await mkdir(join(fixture.directory, ".local/collaboration.sqlite"), { recursive: true });
  await assert.rejects(initializeFixture(fixture), (error) => {
    assert.match(error.stderr, /configured database must be a regular file/);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("LAN initialization propagates environment initialization failures", async (t) => {
  const fixture = await initializationFixture(t, { initExitCode: 7 });
  await assert.rejects(initializeFixture(fixture), (error) => {
    assert.match(error.stderr, /exited with code 7/);
    assert.equal(error.stdout, JSON.stringify(["run", "owner-host:init"]));
    return true;
  });
});

test("missing Caddy guidance is short and platform-specific", () => {
  assert.match(caddyInstallHint("darwin"), /brew install caddy/);
  assert.match(caddyInstallHint("win32"), /choco install caddy/);
  assert.match(caddyInstallHint("linux"), /caddyserver\.com\/docs\/install/);
});
