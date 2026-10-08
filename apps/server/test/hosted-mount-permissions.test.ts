import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/hosted-mount-permissions.js", import.meta.url));

for (const mask of ["0022", "0077", "0027"] as const) {
  for (const scenario of ["trial-empty", "trial-code", "repository"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      test(`${scenario} readonly mounts and ${outcome} cleanup under child umask ${mask}`, {
        skip: process.platform === "win32" ? "POSIX inode permissions and Unix-domain sockets" : false,
        timeout: 15_000,
      }, () => {
        // Keep Unix socket paths short on macOS. Only this mkdtemp fixture is removed.
        const directory = mkdtempSync(join("/tmp", "gt-mnt-"));
        chmodSync(directory, 0o700);
        const parentUmask = process.umask();
        try {
          const result = spawnSync(process.execPath, [fixture, mask, scenario, outcome, directory], {
            // Do not inherit provider credentials or change this test process's umask.
            env: { PATH: process.env.PATH ?? "", TMPDIR: directory },
            encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
          });
          assert.equal(process.umask(), parentUmask, "child isolation must preserve the test runner's umask");
          assert.ifError(result.error);
          assert.equal(result.signal, null, result.stderr);
          assert.equal(result.status, 0, result.stderr || result.stdout);
          assert.match(result.stdout, /^hosted mount fixture passed\n$/u);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
}
