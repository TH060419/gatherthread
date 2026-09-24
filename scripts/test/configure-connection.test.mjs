import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  configureConnectionEnvironment,
  parseConnectionArguments,
  validateLanOrigin,
  validateTailscaleOrigin,
} from "../configure-connection.mjs";

const EXAMPLE = `NODE_ENV=development
GATHERTHREAD_SERVER_HOST=127.0.0.1
GATHERTHREAD_SERVER_PORT=18787
GATHERTHREAD_DATABASE_PATH=.local/collaboration.sqlite
GATHERTHREAD_PUBLIC_BASE_URL=http://127.0.0.1:18787
GATHERTHREAD_ALLOWED_ORIGINS=
GATHERTHREAD_AUTH_TOKEN_PEPPER=
GATHERTHREAD_TLS_TERMINATED_BY_PROXY=false
GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false
`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gatherthread-connection-"));
  await writeFile(join(directory, ".env.example"), EXAMPLE);
  return directory;
}

test("local connection creates a private environment from the example", async () => {
  const directory = await fixture();
  const result = await configureConnectionEnvironment({ cwd: directory, mode: "local" });
  const contents = await readFile(result.envPath, "utf8");
  assert.match(contents, /^NODE_ENV=development$/m);
  assert.match(contents, /^GATHERTHREAD_PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:18787$/m);
  assert.match(contents, /^GATHERTHREAD_TLS_TERMINATED_BY_PROXY=false$/m);
  if (process.platform !== "win32") assert.equal((await stat(result.envPath)).mode & 0o777, 0o600);
});

test("local connection falls back to the high default port when the template omits it", async () => {
  const directory = await fixture();
  await writeFile(join(directory, ".env.example"), EXAMPLE.replace("GATHERTHREAD_SERVER_PORT=18787\n", ""));
  const result = await configureConnectionEnvironment({ cwd: directory, mode: "local" });
  const contents = await readFile(result.envPath, "utf8");
  assert.equal(result.serverPort, 18787);
  assert.match(contents, /^GATHERTHREAD_PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:18787$/m);
});

test("LAN connection preserves credentials and storage while narrowing origins", async () => {
  const directory = await fixture();
  await writeFile(join(directory, ".env"), EXAMPLE
    .replace("GATHERTHREAD_AUTH_TOKEN_PEPPER=", `GATHERTHREAD_AUTH_TOKEN_PEPPER=${"a".repeat(64)}`)
    .replace("GATHERTHREAD_ALLOWED_ORIGINS=", "GATHERTHREAD_ALLOWED_ORIGINS=https://old.example"), { mode: 0o600 });
  await configureConnectionEnvironment({
    cwd: directory,
    mode: "lan",
    rawUrl: "https://192.168.50.20:8443",
  });
  const contents = await readFile(join(directory, ".env"), "utf8");
  assert.match(contents, /^NODE_ENV=production$/m);
  assert.match(contents, /^GATHERTHREAD_PUBLIC_BASE_URL=https:\/\/192\.168\.50\.20:8443$/m);
  assert.match(contents, new RegExp(`^GATHERTHREAD_AUTH_TOKEN_PEPPER=${"a".repeat(64)}$`, "m"));
  assert.match(contents, /^GATHERTHREAD_DATABASE_PATH=\.local\/collaboration\.sqlite$/m);
  assert.match(contents, /^GATHERTHREAD_ALLOWED_ORIGINS=$/m);
});

test("Tailscale connection accepts only an exact standard ts.net HTTPS origin", () => {
  assert.equal(validateTailscaleOrigin("https://host.example-tailnet.ts.net").origin, "https://host.example-tailnet.ts.net");
  assert.throws(() => validateTailscaleOrigin("https://token@host.example-tailnet.ts.net"), /without credentials/);
  assert.throws(() => validateTailscaleOrigin("https://example.com"), /ts\.net/);
  assert.deepEqual(
    parseConnectionArguments(["tailscale", "--url", "https://host.example-tailnet.ts.net"]),
    { mode: "tailscale", rawUrl: "https://host.example-tailnet.ts.net" },
  );
});

test("LAN connection refuses public names and privileged or implicit ports", () => {
  assert.equal(validateLanOrigin("https://gatherthread.home.arpa:8443").origin, "https://gatherthread.home.arpa:8443");
  assert.equal(validateLanOrigin("https://10.20.30.40:9443").origin, "https://10.20.30.40:9443");
  assert.throws(() => validateLanOrigin("https://example.com:8443"), /RFC1918/);
  assert.throws(() => validateLanOrigin("https://192.168.1.20"), /include an unprivileged/);
});
