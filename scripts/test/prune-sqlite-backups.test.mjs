import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve(import.meta.dirname, "../prune-sqlite-backups.sh");
const oldTime = new Date(Date.now() - 17 * 24 * 60 * 60 * 1000);

function old(path) { utimesSync(path, oldTime, oldTime); }

test("backup retention prunes old SQLite and Git companions together but preserves young and incomplete backups",
  { skip: process.platform === "win32" ? "The ECS retention script requires POSIX sh" : false }, () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-prune-test-"));
  const make = (stem, { age = "old", incomplete = false } = {}) => {
    const db = join(directory, `${stem}.db`);
    writeFileSync(db, "sqlite backup");
    writeFileSync(`${db}.sha256`, "digest");
    mkdirSync(`${db}.code`);
    writeFileSync(join(`${db}.code`, "object"), "git object");
    if (incomplete) writeFileSync(`${db}.incomplete`, "operator review");
    if (age === "old") {
      old(db); old(`${db}.sha256`); old(join(`${db}.code`, "object")); old(`${db}.code`);
    }
    return db;
  };
  try {
    const expired = make("collaboration-20260901T010101Z-100");
    const young = make("collaboration-20260923T010101Z-101", { age: "young" });
    const incomplete = make("collaboration-20260901T010101Z-102", { incomplete: true });
    const orphan = make("collaboration-20260901T010101Z-103");
    rmSync(orphan);
    const unrelated = join(directory, "not-a-gatherthread-backup.db");
    writeFileSync(unrelated, "keep");
    old(unrelated);
    const run = spawnSync(script, [directory], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(`${expired}.sha256`), false);
    assert.equal(existsSync(`${expired}.code`), false);
    assert.equal(existsSync(`${orphan}.code`), false);
    assert.equal(existsSync(young), true);
    assert.equal(existsSync(`${young}.code`), true);
    assert.equal(existsSync(incomplete), true);
    assert.equal(existsSync(`${incomplete}.code`), true);
    assert.equal(existsSync(unrelated), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
