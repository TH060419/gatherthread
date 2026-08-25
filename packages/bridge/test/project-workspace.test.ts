import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureProjectWorkspace, sanitizeProjectWorkspaceName } from "../src/project-workspace.js";

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
