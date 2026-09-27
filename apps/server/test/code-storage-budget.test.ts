import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeStorageBudget, CODE_PROJECT_DISK_BYTES, CODE_TOTAL_DISK_BYTES } from "../src/code-storage-budget.js";
import { ApiError } from "../src/errors.js";

const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gatherthread-budget-"));
  const repository = join(root, "project.git");
  mkdirSync(repository);
  return { root, repository, close() { rmSync(root, { recursive: true, force: true }); } };
}

test("disk reservations avoid request-time rescans and include failed writes until periodic reconciliation", () => {
  const f = fixture();
  try {
    let now = 0;
    const budget = new CodeStorageBudget(f.root, { clock: () => now, scanIntervalMilliseconds: 1000 });
    budget.reserve(f.repository, CODE_PROJECT_DISK_BYTES / 2);
    // A rolled-back caller does not release a reservation: Git objects may survive.
    // Directory stat.size differs by filesystem/OS; exceed the cap even when
    // Windows reports zero bytes for the empty repository directory.
    assert.throws(() => budget.reserve(f.repository, CODE_PROJECT_DISK_BYTES / 2 + 1), code("code_storage_quota_exceeded"));
    // A new entry is not read until the timed reconciliation (no hot full-tree walk).
    mkdirSync(join(f.root, "other.git"));
    writeFileSync(join(f.root, "other.git", "orphan"), "x");
    // Cross the limit by a byte even on Windows, where directory stat.size
    // can be zero rather than the positive value reported by APFS/ext4.
    truncateSync(join(f.root, "other.git", "orphan"), CODE_PROJECT_DISK_BYTES + 1);
    assert.doesNotThrow(() => budget.reserve(f.repository, 1));
    now = 1000;
    assert.throws(() => budget.reserve(f.repository, 1), code("code_storage_quota_exceeded"));
  } finally { f.close(); }
});

test("cold storage check counts orphan objects and deleted-project directories without relying on database rows", () => {
  const f = fixture();
  try {
    // Sparse files exercise accounting without consuming a GiB of test disk.
    for (let index = 0; index < 5; index++) {
      const path = join(f.root, `deleted-${index}.git`);
      mkdirSync(path);
      writeFileSync(join(path, "unreferenced"), "x");
      truncateSync(join(path, "unreferenced"), Math.ceil(CODE_TOTAL_DISK_BYTES / 5));
    }
    assert.throws(() => new CodeStorageBudget(f.root).reserve(f.repository, 1), code("code_storage_quota_exceeded"));
  } finally { f.close(); }
});

test("scan entry budget fails closed once, rather than repeatedly traversing storage on every request", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 4; index++) writeFileSync(join(f.repository, `${index}`), "x");
    const budget = new CodeStorageBudget(f.root, { maxEntries: 3 });
    let failure: unknown;
    assert.throws(() => budget.reserve(f.repository, 1), (error) => { failure = error; return code("code_storage_check_required")(error); });
    rmSync(f.repository, { recursive: true });
    assert.throws(() => budget.reserve(f.repository, 1), (error) => error === failure);
    assert.doesNotThrow(() => new CodeStorageBudget(f.root).reserve(f.repository, 1));
    assert.throws(() => new CodeStorageBudget(f.root, { maxMilliseconds: -1 }).reserve(f.repository, 1), code("code_storage_check_required"));
  } finally { f.close(); }
});

test("successful bounded reconciliation reclaims only conservative excess, retaining real failed-write files", () => {
  const f = fixture();
  try {
    let now = 0;
    const budget = new CodeStorageBudget(f.root, { clock: () => now, scanIntervalMilliseconds: 1000 });
    budget.reserve(f.repository, CODE_PROJECT_DISK_BYTES - 1024 * 1024);
    writeFileSync(join(f.repository, "failed-object"), "x");
    truncateSync(join(f.repository, "failed-object"), 1024 * 1024);
    now = 1000;
    assert.doesNotThrow(() => budget.reserve(f.repository, 1024 * 1024));
    assert.throws(() => budget.reserve(f.repository, CODE_PROJECT_DISK_BYTES - 1024 * 1024), code("code_storage_quota_exceeded"));
  } finally { f.close(); }
});
