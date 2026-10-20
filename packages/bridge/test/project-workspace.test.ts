import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureProjectWorkspace, findExistingProjectWorkspaces, sanitizeProjectWorkspaceName } from "../src/project-workspace.js";

test("recovery lookup is read-only and matches exact private project bindings without guessing a current name", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "gt-existing-projects-"));
  const options = { apiUrl: "https://fixture.invalid/v1", projectId: "project-1", homeDirectory };
  assert.deepEqual(await findExistingProjectWorkspaces(options), []);
  await assert.rejects(stat(path.join(homeDirectory, "GatherThread Projects")), /ENOENT/);
  const first = await ensureProjectWorkspace({ ...options, projectName: "Former name" });
  const second = await ensureProjectWorkspace({ ...options, projectName: "Another old name" });
  await ensureProjectWorkspace({ ...options, projectName: "Different project", projectId: "project-2" });
  await ensureProjectWorkspace({ ...options, projectName: "Different server", apiUrl: "https://other.invalid/v1" });
  assert.deepEqual((await findExistingProjectWorkspaces(options)).sort(), (await Promise.all([realpath(first), realpath(second)])).sort());
});

test("recovery lookup rejects linked, malformed, oversized, and nonprivate markers before exposing a mapping", async () => {
  for (const invalid of ["symlink", "hardlink", "malformed", "oversized", ...(process.platform === "win32" ? [] : ["permissions"])]) {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "gt-existing-invalid-"));
    const options = { apiUrl: "https://fixture.invalid/v1", projectId: "project-1", homeDirectory };
    const workspace = await ensureProjectWorkspace({ ...options, projectName: "Old name" });
    const marker = path.join(workspace, ".gatherthread-project.json");
    if (invalid === "symlink") {
      await symlink(workspace, path.join(homeDirectory, "GatherThread Projects", "Linked"), process.platform === "win32" ? "junction" : "dir");
    } else if (invalid === "hardlink") await link(marker, path.join(homeDirectory, "linked-marker"));
    else if (invalid === "malformed") await writeFile(marker, "{");
    else if (invalid === "oversized") await truncate(marker, 4097);
    else await chmod(marker, 0o644);
    await assert.rejects(findExistingProjectWorkspaces(options), /symbolic|private|invalid|bounded/);
  }
});

test("recovery workspace discovery stops after its fixed directory-entry bound", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "gt-existing-bounded-"));
  const root = path.join(homeDirectory, "GatherThread Projects"); await mkdir(root, { mode: 0o700 });
  for (let index = 0; index < 129; index++) await mkdir(path.join(root, `entry-${index}`), { mode: 0o700 });
  await assert.rejects(findExistingProjectWorkspaces({ homeDirectory, apiUrl: "https://fixture.invalid/v1", projectId: "project-1" }), /exceeds its bound/);
});

test("project workspace names are portable and cannot escape the fixed root", () => {
  assert.equal(sanitizeProjectWorkspaceName("../../CON:<bad>|name?. "), "CON-bad-name");
  assert.equal(sanitizeProjectWorkspaceName("CON.txt"), "_CON.txt");
  assert.equal(sanitizeProjectWorkspaceName(".."), "GatherThread Project");
  assert.equal(sanitizeProjectWorkspaceName("  Project\tAtlas  "), "Project-Atlas");
  assert.ok(Buffer.byteLength(sanitizeProjectWorkspaceName("界".repeat(100))) <= 120);
});

test("project workspace creation writes a private marker and reconnects idempotently", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "gatherthread-project-home-"));
  const options = {
    apiUrl: "https://collab.example/v1",
    projectId: "project-1",
    projectName: "Project Atlas",
    homeDirectory,
  };
  const first = await ensureProjectWorkspace(options);
  const second = await ensureProjectWorkspace(options);
  assert.equal(first, path.join(homeDirectory, "GatherThread Projects", "Project Atlas"));
  assert.equal(second, first);
  const markerPath = path.join(first, ".gatherthread-project.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.projectId, "project-1");
  assert.equal(marker.apiUrl, "https://collab.example/v1");
  if (process.platform !== "win32") {
    assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
  }
});

test("project workspace rejects symlinks, unmanaged non-empty directories, and marker mismatches", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "gatherthread-project-reject-"));
  const root = path.join(homeDirectory, "GatherThread Projects");
  await mkdir(root);
  const external = await mkdtemp(path.join(tmpdir(), "gatherthread-project-external-"));
  await symlink(external, path.join(root, "Linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(ensureProjectWorkspace({
    apiUrl: "https://collab.example/v1", projectId: "linked", projectName: "Linked", homeDirectory,
  }), /symbolic link/);

  const unmanaged = path.join(root, "Occupied");
  await mkdir(unmanaged);
  await writeFile(path.join(unmanaged, "user.txt"), "keep me");
  await assert.rejects(ensureProjectWorkspace({
    apiUrl: "https://collab.example/v1", projectId: "occupied", projectName: "Occupied", homeDirectory,
  }), /non-empty directory/);

  if (process.platform !== "win32") {
    const markerLinkDirectory = path.join(root, "Marker link");
    await mkdir(markerLinkDirectory);
    const externalMarker = path.join(external, "marker.json");
    await writeFile(externalMarker, JSON.stringify({
      version: 1, apiUrl: "https://collab.example/v1", projectId: "linked-marker", projectName: "Marker link",
    }));
    await symlink(externalMarker, path.join(markerLinkDirectory, ".gatherthread-project.json"), "file");
    await assert.rejects(ensureProjectWorkspace({
      apiUrl: "https://collab.example/v1", projectId: "linked-marker", projectName: "Marker link", homeDirectory,
    }), /regular file, not a symlink/);
  }

  const managed = await ensureProjectWorkspace({
    apiUrl: "https://collab.example/v1", projectId: "project-1", projectName: "Managed", homeDirectory,
  });
  await assert.rejects(ensureProjectWorkspace({
    apiUrl: "https://other.example/v1", projectId: "project-1", projectName: "Managed", homeDirectory,
  }), /different GatherThread project or server/);
  await assert.rejects(ensureProjectWorkspace({
    apiUrl: "https://collab.example/v1", projectId: "project-2", projectName: "Managed", homeDirectory,
  }), /different GatherThread project or server/);
  assert.equal(await readFile(path.join(unmanaged, "user.txt"), "utf8"), "keep me");
  assert.ok(managed.startsWith(root));
});
