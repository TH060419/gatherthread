import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { DSH_COMPATIBILITY } from "./dsh-compat.js";
import { parseDshHostConfig } from "./config.js";
import {
  assertSameDirectoryChain,
  secureDirectoryChain,
} from "./path-security.js";

const execFileAsync = promisify(execFile);

export const DSH_CONNECTION_OWNER = "gatherthread.dsh-host.connection.v1";
export const DSH_CONNECTION_TOKEN_VARIABLE = "GATHERTHREAD_DSH_TOKEN";
export const DSH_CONNECTION_ID_PATTERN = /^[a-f0-9]{24}$/u;
export const DSH_CONNECTION_MANIFEST = "manifest.json";
export const DSH_CONNECTION_PATCH = "cordis.patch.yml";

const PACKAGE_NAME = "@gatherthread/dsh-host";
const PACKAGE_VERSION = "0.1.0-alpha.6";

export type DshConnectionProfile = "web" | "headless";

export interface DshConnectionInput {
  readonly dshSource: string;
  readonly dshHome: string;
  readonly packageRoot: string;
  readonly profile: DshConnectionProfile;
  readonly apiUrl: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly deviceId: string;
  readonly workspacePath: string;
  readonly provider: string;
  readonly model: string;
  readonly shareToolEvents?: boolean;
}

export interface DshConnectionBindingManifest {
  readonly apiUrl: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly deviceId: string;
  readonly workspacePath: string;
  readonly stateRoot: string;
  readonly provider: string;
  readonly model: string;
  readonly shareToolEvents: boolean;
}

export interface DshConnectionManifest {
  readonly schemaVersion: 1;
  readonly owner: typeof DSH_CONNECTION_OWNER;
  readonly connectionId: string;
  readonly package: {
    readonly name: typeof PACKAGE_NAME;
    readonly version: typeof PACKAGE_VERSION;
    readonly pluginEntry: string;
  };
  readonly deepseekHarness: {
    readonly tag: string;
    readonly version: string;
    readonly commit: string;
  };
  readonly profile: DshConnectionProfile;
  readonly binding: DshConnectionBindingManifest;
  readonly patchFile: typeof DSH_CONNECTION_PATCH;
  readonly patchSha256: string;
}

export interface DshConnectionPlan {
  readonly dshSource: string;
  readonly dshHome: string;
  readonly profileDirectory: string;
  readonly packageRoot: string;
  readonly pluginEntry: string;
  readonly clientEntry: string;
  readonly connectionId: string;
  readonly managedRoot: string;
  readonly connectionDirectory: string;
  readonly removedDirectory: string;
  readonly stateRoot: string;
  readonly patch: string;
  readonly manifest: DshConnectionManifest;
}

export interface DshSourcePreflight {
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly profile: DshConnectionProfile;
  readonly profileExists: boolean;
}

export type DshInstallResult =
  | { readonly status: "installed"; readonly plan: DshConnectionPlan }
  | { readonly status: "already_installed"; readonly plan: DshConnectionPlan }
  | { readonly status: "restored"; readonly plan: DshConnectionPlan };

export type DshConnectionArtifactStatus =
  | {
    readonly status: "installed" | "removed";
    readonly connectionId: string;
    readonly manifest: DshConnectionManifest;
  }
  | { readonly status: "missing"; readonly connectionId: string };

/** Build a deterministic, credential-free profile overlay plan. */
export function createDshConnectionPlan(input: DshConnectionInput): DshConnectionPlan {
  const dshSource = absolutePath(input.dshSource, "dshSource");
  const dshHome = absolutePath(input.dshHome, "dshHome");
  const packageRoot = absolutePath(input.packageRoot, "packageRoot");
  const workspacePath = absolutePath(input.workspacePath, "workspacePath");
  if (input.profile !== "web" && input.profile !== "headless") {
    throw new Error("profile must be web or headless for the pinned DSH integration");
  }
  const projectName = safeText(input.projectName, "projectName", 160);
  const identity = createHash("sha256").update([
    normalizeApiUrl(input.apiUrl),
    input.projectId,
    input.deviceId,
    workspacePath,
    input.profile,
    input.provider,
    input.model,
  ].join("\0")).digest("hex").slice(0, 24);
  const managedRoot = path.join(dshHome, "gatherthread");
  const connectionDirectory = path.join(managedRoot, "connections", identity);
  const removedDirectory = path.join(managedRoot, "removed", identity);
  const stateRoot = path.join(managedRoot, "state", identity);
  const pluginEntry = path.join(packageRoot, "dist", "src", "plugin.js");
  const clientEntry = path.join(packageRoot, "client", "client.js");
  const parsed = parseDshHostConfig({
    enabled: true,
    bindingMode: "project",
    apiUrl: input.apiUrl,
    credentialReference: {
      kind: "environment",
      variable: DSH_CONNECTION_TOKEN_VARIABLE,
    },
    projectId: input.projectId,
    projectName,
    deviceId: input.deviceId,
    workspacePath,
    stateRoot,
    provider: input.provider,
    model: input.model,
    shareToolEvents: input.shareToolEvents === true,
  });
  if (!parsed.enabled || parsed.bindingMode !== "project") {
    throw new Error("Generated DSH project configuration is invalid");
  }
  const binding: DshConnectionBindingManifest = {
    apiUrl: parsed.apiUrl,
    projectId: parsed.projectId,
    projectName: parsed.projectName ?? parsed.projectId,
    deviceId: parsed.deviceId,
    workspacePath: parsed.workspacePath,
    stateRoot: parsed.stateRoot,
    provider: parsed.provider,
    model: parsed.model,
    shareToolEvents: parsed.shareToolEvents,
  };
  const patch = renderConnectionPatch({
    connectionId: identity,
    profile: input.profile,
    pluginEntry,
    binding,
  });
  const manifest: DshConnectionManifest = {
    schemaVersion: 1,
    owner: DSH_CONNECTION_OWNER,
    connectionId: identity,
    package: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      pluginEntry,
    },
    deepseekHarness: {
      tag: DSH_COMPATIBILITY.tag,
      version: DSH_COMPATIBILITY.version,
      commit: DSH_COMPATIBILITY.commit,
    },
    profile: input.profile,
    binding,
    patchFile: DSH_CONNECTION_PATCH,
    patchSha256: sha256(patch),
  };
  return {
    dshSource,
    dshHome,
    profileDirectory: path.join(dshHome, "profiles", input.profile),
    packageRoot,
    pluginEntry,
    clientEntry,
    connectionId: identity,
    managedRoot,
    connectionDirectory,
    removedDirectory,
    stateRoot,
    patch,
    manifest,
  };
}

/** Verify the exact DSH source checkout and the GatherThread client/Host artifacts. */
export async function preflightDshConnection(plan: DshConnectionPlan): Promise<DshSourcePreflight> {
  const sourceReal = await realpath(plan.dshSource);
  if (sourceReal !== plan.dshSource) {
    throw new Error("Pinned DSH source path must not traverse a symbolic link");
  }
  await Promise.all([
    access(path.join(plan.dshSource, "apps", "cli", "src", "bin.ts")),
    access(path.join(plan.dshSource, "tsconfig.json")),
    access(plan.pluginEntry),
    access(plan.clientEntry),
  ]);
  const manifest = JSON.parse(await readFile(
    path.join(plan.dshSource, "apps", "cli", "package.json"),
    "utf8",
  )) as { version?: unknown };
  if (manifest.version !== DSH_COMPATIBILITY.version) {
    throw new Error(
      `Unsupported DeepSeek Harness CLI version; expected ${DSH_COMPATIBILITY.version}`,
    );
  }
  const [head, tags, trackedStatus] = await Promise.all([
    gitOutput(plan.dshSource, ["rev-parse", "HEAD"]),
    gitOutput(plan.dshSource, ["tag", "--points-at", "HEAD"]),
    gitOutput(plan.dshSource, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  if (head !== DSH_COMPATIBILITY.commit) {
    throw new Error(
      `Unsupported DeepSeek Harness commit; expected ${DSH_COMPATIBILITY.commit}`,
    );
  }
  if (!tags.split(/\r?\n/u).includes(DSH_COMPATIBILITY.tag)) {
    throw new Error(`Pinned DeepSeek Harness tag ${DSH_COMPATIBILITY.tag} is absent at HEAD`);
  }
  if (trackedStatus !== "") {
    throw new Error("Pinned DeepSeek Harness checkout has tracked modifications");
  }
  const packageManifest = JSON.parse(await readFile(
    path.join(plan.packageRoot, "package.json"),
    "utf8",
  )) as { name?: unknown; version?: unknown; dsh?: unknown; exports?: unknown };
  if (packageManifest.name !== PACKAGE_NAME || packageManifest.version !== PACKAGE_VERSION) {
    throw new Error("GatherThread DSH package identity does not match the connection plan");
  }
  const client = asObject(asObject(packageManifest.dsh)?.client);
  if (client?.platform !== "web") {
    throw new Error("GatherThread DSH package has no supported web client declaration");
  }
  const exports = asObject(packageManifest.exports);
  if (asObject(exports?.["./client"])?.default !== "./client/client.js") {
    throw new Error("GatherThread DSH package has no supported ./client export");
  }
  await assertSafeProfileTarget(plan);
  return {
    tag: DSH_COMPATIBILITY.tag,
    version: DSH_COMPATIBILITY.version,
    commit: DSH_COMPATIBILITY.commit,
    profile: plan.manifest.profile,
    profileExists: await exists(path.join(plan.profileDirectory, "package.json")),
  };
}

/** Refuse profile/home symlink replacement before invoking the official DSH initializer. */
export async function assertSafeProfileTarget(plan: DshConnectionPlan): Promise<void> {
  await secureDirectoryChain(plan.dshHome);
  const home = await optionalLstat(plan.dshHome);
  if (home !== undefined && (home.isSymbolicLink() || !home.isDirectory())) {
    throw new Error("DSH_HOME must be a real directory");
  }
  await secureDirectoryChain(path.dirname(plan.profileDirectory));
  const profile = await optionalLstat(plan.profileDirectory);
  if (profile !== undefined && (profile.isSymbolicLink() || !profile.isDirectory())) {
    throw new Error("Target DSH profile must be a real directory");
  }
  for (const filename of ["package.json", "cordis.patch.yml"]) {
    const artifact = await optionalLstat(path.join(plan.profileDirectory, filename));
    if (artifact !== undefined && (artifact.isSymbolicLink() || !artifact.isFile())) {
      throw new Error(`Target DSH profile ${filename} must be a regular file`);
    }
  }
}

/** Create or restore the exact owned overlay without touching the profile's own files. */
export async function installDshConnection(plan: DshConnectionPlan): Promise<DshInstallResult> {
  await assertSafeProfileTarget(plan);
  if (!await exists(path.join(plan.profileDirectory, "package.json"))) {
    throw new Error("Target DSH profile is not initialized");
  }
  await prepareManagedDirectories(plan);
  const installed = await optionalLstat(plan.connectionDirectory);
  const removed = await optionalLstat(plan.removedDirectory);
  if (installed !== undefined && removed !== undefined) {
    throw new Error("DSH connection has both installed and removed artifacts");
  }
  if (installed !== undefined) {
    await assertArtifactMatchesPlan(plan.connectionDirectory, plan);
    return { status: "already_installed", plan };
  }
  if (removed !== undefined) {
    await assertArtifactMatchesPlan(plan.removedDirectory, plan);
    await guardedRename(
      path.dirname(plan.removedDirectory),
      plan.removedDirectory,
      path.dirname(plan.connectionDirectory),
      plan.connectionDirectory,
    );
    await assertArtifactMatchesPlan(plan.connectionDirectory, plan);
    return { status: "restored", plan };
  }

  const parent = path.dirname(plan.connectionDirectory);
  const staging = path.join(parent, `.staging-${plan.connectionId}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await writePrivateFile(path.join(staging, DSH_CONNECTION_PATCH), plan.patch);
    await writePrivateFile(
      path.join(staging, DSH_CONNECTION_MANIFEST),
      `${JSON.stringify(plan.manifest, null, 2)}\n`,
    );
    await assertArtifactMatchesPlan(staging, plan);
    await guardedRename(parent, staging, parent, plan.connectionDirectory);
    await assertArtifactMatchesPlan(plan.connectionDirectory, plan);
  } catch (error) {
    await cleanupStaging(staging);
    if (await exists(plan.connectionDirectory)) {
      await assertArtifactMatchesPlan(plan.connectionDirectory, plan);
      return { status: "already_installed", plan };
    }
    throw error;
  }
  return { status: "installed", plan };
}

/** Move only a verified GatherThread-owned overlay into its reversible slot. */
export async function removeDshConnection(
  dshHome: string,
  connectionId: string,
): Promise<"removed" | "already_removed"> {
  const paths = connectionPaths(dshHome, connectionId);
  await assertOperationDirectories(paths.managedRoot);
  const installed = await optionalLstat(paths.connectionDirectory);
  const removed = await optionalLstat(paths.removedDirectory);
  if (installed === undefined) {
    if (removed === undefined) throw new Error("GatherThread DSH connection is not installed");
    await readOwnedArtifact(paths.removedDirectory, connectionId);
    return "already_removed";
  }
  if (removed !== undefined) {
    throw new Error("DSH connection has both installed and removed artifacts");
  }
  await readOwnedArtifact(paths.connectionDirectory, connectionId);
  await guardedRename(
    path.dirname(paths.connectionDirectory),
    paths.connectionDirectory,
    path.dirname(paths.removedDirectory),
    paths.removedDirectory,
  );
  await readOwnedArtifact(paths.removedDirectory, connectionId);
  return "removed";
}

/** Restore only a verified GatherThread-owned overlay to its original identity. */
export async function restoreDshConnection(
  dshHome: string,
  connectionId: string,
): Promise<"restored" | "already_installed"> {
  const paths = connectionPaths(dshHome, connectionId);
  await assertOperationDirectories(paths.managedRoot);
  const installed = await optionalLstat(paths.connectionDirectory);
  const removed = await optionalLstat(paths.removedDirectory);
  if (removed === undefined) {
    if (installed === undefined) throw new Error("GatherThread DSH connection has no removable artifact");
    await readOwnedArtifact(paths.connectionDirectory, connectionId);
    return "already_installed";
  }
  if (installed !== undefined) {
    throw new Error("DSH connection has both installed and removed artifacts");
  }
  await readOwnedArtifact(paths.removedDirectory, connectionId);
  await guardedRename(
    path.dirname(paths.removedDirectory),
    paths.removedDirectory,
    path.dirname(paths.connectionDirectory),
    paths.connectionDirectory,
  );
  await readOwnedArtifact(paths.connectionDirectory, connectionId);
  return "restored";
}

/** Read and verify an owned artifact; corrupt/foreign content always rejects. */
export async function inspectDshConnection(
  dshHome: string,
  connectionId: string,
): Promise<DshConnectionArtifactStatus> {
  const paths = connectionPaths(dshHome, connectionId);
  await secureDirectoryChain(paths.managedRoot);
  const installed = await optionalLstat(paths.connectionDirectory);
  const removed = await optionalLstat(paths.removedDirectory);
  if (installed !== undefined && removed !== undefined) {
    throw new Error("DSH connection has both installed and removed artifacts");
  }
  if (installed === undefined && removed === undefined) {
    return { status: "missing", connectionId };
  }
  const location = installed === undefined ? paths.removedDirectory : paths.connectionDirectory;
  return {
    status: installed === undefined ? "removed" : "installed",
    connectionId,
    manifest: await readOwnedArtifact(location, connectionId),
  };
}

/** Resolve an omitted id only when exactly one owned-looking connection exists. */
export async function resolveDshConnectionId(
  dshHome: string,
  requested?: string,
): Promise<string> {
  if (requested !== undefined) return validateConnectionId(requested);
  const root = path.join(absolutePath(dshHome, "dshHome"), "gatherthread");
  await secureDirectoryChain(root);
  const ids = new Set<string>();
  for (const group of ["connections", "removed"]) {
    const directory = path.join(root, group);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (DSH_CONNECTION_ID_PATTERN.test(entry.name)) ids.add(entry.name);
    }
  }
  if (ids.size === 0) throw new Error("No GatherThread DSH connections were found");
  if (ids.size !== 1) throw new Error("Multiple GatherThread DSH connections exist; pass --connection");
  return [...ids][0] as string;
}

/** Build the exact, secret-free DSH process invocation for an installed overlay. */
export function dshLaunchSpec(plan: DshConnectionPlan, port?: number): {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
} {
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65_535)) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  const sourceRequire = createRequire(path.join(plan.dshSource, "package.json"));
  const tsxLoader = pathToFileURL(sourceRequire.resolve("tsx/esm")).href;
  const args = [
    "--import",
    tsxLoader,
    path.join(plan.dshSource, "apps", "cli", "src", "bin.ts"),
    "--profile",
    plan.manifest.profile,
    "--patch",
    path.join(plan.connectionDirectory, DSH_CONNECTION_PATCH),
  ];
  if (plan.manifest.profile === "web") {
    args.push("--host", "127.0.0.1", "--no-open");
    if (port !== undefined) args.push("--port", String(port));
  }
  return { command: process.execPath, args, cwd: plan.manifest.binding.workspacePath };
}

function renderConnectionPatch(input: {
  connectionId: string;
  profile: DshConnectionProfile;
  pluginEntry: string;
  binding: DshConnectionBindingManifest;
}): string {
  const prefix = input.profile === "headless"
    ? [
      "# GatherThread-owned overlay. The stock one-shot runner is disabled.",
      "- id: headless-startup",
      "  disabled: true",
      "",
      "- id: headless-runner",
      "  disabled: true",
      "",
    ]
    : ["# GatherThread-owned overlay for the official DSH web profile.", ""];
  const inject = input.profile === "web"
    ? "[agents, sessions, sessionPersistence, llm, connection]"
    : "[agents, sessions, sessionPersistence, llm]";
  return [
    ...prefix,
    "- insert:",
    `    - id: gatherthread-dsh-${input.connectionId}`,
    `      name: ${JSON.stringify(pathToFileURL(input.pluginEntry).href)}`,
    `      inject: ${inject}`,
    "      config:",
    "        enabled: true",
    "        bindingMode: project",
    `        apiUrl: ${JSON.stringify(input.binding.apiUrl)}`,
    "        credentialReference:",
    "          kind: environment",
    `          variable: ${DSH_CONNECTION_TOKEN_VARIABLE}`,
    `        projectId: ${JSON.stringify(input.binding.projectId)}`,
    `        projectName: ${JSON.stringify(input.binding.projectName)}`,
    `        deviceId: ${JSON.stringify(input.binding.deviceId)}`,
    `        workspacePath: ${JSON.stringify(input.binding.workspacePath)}`,
    `        stateRoot: ${JSON.stringify(input.binding.stateRoot)}`,
    `        provider: ${JSON.stringify(input.binding.provider)}`,
    `        model: ${JSON.stringify(input.binding.model)}`,
    "        pollIntervalMs: 1000",
    "        pollLimit: 200",
    `        shareToolEvents: ${String(input.binding.shareToolEvents)}`,
    "        refreshIntervalMs: 5000",
    "        maxConcurrentSessions: 4",
    "        retryBaseMs: 1000",
    "        retryMaxMs: 30000",
    "",
  ].join("\n");
}

async function prepareManagedDirectories(plan: DshConnectionPlan): Promise<void> {
  const profileParent = path.dirname(plan.profileDirectory);
  await secureDirectoryChain(profileParent);
  await ensurePrivateChild(plan.dshHome, "gatherthread");
  await ensurePrivateChild(plan.managedRoot, "connections");
  await ensurePrivateChild(plan.managedRoot, "removed");
  await ensurePrivateChild(plan.managedRoot, "state");
  await ensurePrivateChild(path.join(plan.managedRoot, "state"), plan.connectionId);
}

async function assertOperationDirectories(managedRoot: string): Promise<void> {
  const dshHome = path.dirname(managedRoot);
  let home: Awaited<ReturnType<typeof lstat>>;
  let managed: Awaited<ReturnType<typeof lstat>>;
  let connections: Awaited<ReturnType<typeof lstat>>;
  let removed: Awaited<ReturnType<typeof lstat>>;
  try {
    await secureDirectoryChain(managedRoot);
    [home, managed, connections, removed] = await Promise.all([
      lstat(dshHome),
      lstat(managedRoot),
      lstat(path.join(managedRoot, "connections")),
      lstat(path.join(managedRoot, "removed")),
    ]);
  } catch {
    throw new Error("GatherThread DSH managed directories are missing or unsafe");
  }
  if (home.isSymbolicLink() || !home.isDirectory()) throw new Error("DSH_HOME must be a real directory");
  assertPrivateDirectory(managed, "GatherThread DSH managed root");
  assertPrivateDirectory(connections, "GatherThread DSH connections directory");
  assertPrivateDirectory(removed, "GatherThread DSH removed directory");
}

async function ensurePrivateChild(parent: string, childName: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/u.test(childName)) throw new Error("Unsafe managed directory name");
  const beforeChain = await secureDirectoryChain(parent);
  const parentBefore = await lstat(parent);
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
    throw new Error("Managed DSH parent must be a real directory");
  }
  const target = path.join(parent, childName);
  const existing = await optionalLstat(target);
  if (existing === undefined) await mkdir(target, { mode: 0o700 });
  const parentAfter = await lstat(parent);
  if (parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
    throw new Error("Managed DSH parent changed during directory creation");
  }
  assertSameDirectoryChain(beforeChain, await secureDirectoryChain(parent));
  assertPrivateDirectory(await lstat(target), "Managed DSH directory");
}

async function assertArtifactMatchesPlan(directory: string, plan: DshConnectionPlan): Promise<void> {
  const directoryBefore = await lstat(directory);
  assertPrivateDirectory(directoryBefore, "GatherThread DSH connection artifact");
  const manifest = await readOwnedArtifact(directory, plan.connectionId);
  if (JSON.stringify(manifest) !== JSON.stringify(plan.manifest)) {
    throw new Error("Existing GatherThread DSH connection differs from the requested plan");
  }
  const patchPath = path.join(directory, DSH_CONNECTION_PATCH);
  let patchBefore: Awaited<ReturnType<typeof lstat>>;
  try {
    patchBefore = await lstat(patchPath);
    assertPrivateFile(patchBefore, "GatherThread DSH connection patch");
  } catch {
    throw new Error("Existing GatherThread DSH connection patch is missing or unsafe");
  }
  const patch = await readPrivateFile(patchPath, patchBefore);
  const directoryAfter = await lstat(directory);
  if (directoryAfter.dev !== directoryBefore.dev || directoryAfter.ino !== directoryBefore.ino) {
    throw new Error("Existing GatherThread DSH connection changed during verification");
  }
  if (patch !== plan.patch) {
    throw new Error("Existing GatherThread DSH connection patch differs from the requested plan");
  }
}

async function readOwnedArtifact(
  directory: string,
  expectedConnectionId: string,
): Promise<DshConnectionManifest> {
  const parentChain = await secureDirectoryChain(path.dirname(directory));
  assertPrivateDirectory(await lstat(directory), "GatherThread DSH connection artifact");
  const manifestPath = path.join(directory, DSH_CONNECTION_MANIFEST);
  const patchPath = path.join(directory, DSH_CONNECTION_PATCH);
  let manifestStat: Awaited<ReturnType<typeof lstat>>;
  let patchStat: Awaited<ReturnType<typeof lstat>>;
  try {
    [manifestStat, patchStat] = await Promise.all([lstat(manifestPath), lstat(patchPath)]);
  } catch {
    throw new Error("GatherThread DSH connection artifact is incomplete or not owned");
  }
  assertPrivateFile(manifestStat, "GatherThread DSH connection manifest");
  assertPrivateFile(patchStat, "GatherThread DSH connection patch");
  let manifestRaw: string;
  let patch: string;
  try {
    [manifestRaw, patch] = await Promise.all([
      readPrivateFile(manifestPath, manifestStat),
      readPrivateFile(patchPath, patchStat),
    ]);
  } catch (error) {
    if (isNodeError(error)) {
      throw new Error("GatherThread DSH connection artifact changed during verification");
    }
    throw error;
  }
  assertSameDirectoryChain(parentChain, await secureDirectoryChain(path.dirname(directory)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw) as unknown;
  } catch {
    throw new Error("GatherThread DSH connection manifest is not valid JSON");
  }
  const manifest = validateManifest(parsed, expectedConnectionId);
  if (sha256(patch) !== manifest.patchSha256) {
    throw new Error("GatherThread DSH connection patch digest does not match its manifest");
  }
  return manifest;
}

function validateManifest(value: unknown, expectedConnectionId: string): DshConnectionManifest {
  const manifest = requiredObject(value, "connection manifest");
  exactKeys(manifest, [
    "schemaVersion", "owner", "connectionId", "package", "deepseekHarness",
    "profile", "binding", "patchFile", "patchSha256",
  ], "connection manifest");
  if (manifest.schemaVersion !== 1 || manifest.owner !== DSH_CONNECTION_OWNER) {
    throw new Error("Connection artifact is not owned by this GatherThread DSH integration");
  }
  const connectionId = validateConnectionId(manifest.connectionId);
  if (connectionId !== expectedConnectionId) {
    throw new Error("GatherThread DSH connection artifact identity does not match its path");
  }
  const packageValue = requiredObject(manifest.package, "connection manifest.package");
  exactKeys(packageValue, ["name", "version", "pluginEntry"], "connection manifest.package");
  if (packageValue.name !== PACKAGE_NAME || packageValue.version !== PACKAGE_VERSION) {
    throw new Error("GatherThread DSH connection package identity is incompatible");
  }
  const pluginEntry = absolutePath(packageValue.pluginEntry, "connection manifest.package.pluginEntry");
  const dsh = requiredObject(manifest.deepseekHarness, "connection manifest.deepseekHarness");
  exactKeys(dsh, ["tag", "version", "commit"], "connection manifest.deepseekHarness");
  if (dsh.tag !== DSH_COMPATIBILITY.tag
    || dsh.version !== DSH_COMPATIBILITY.version
    || dsh.commit !== DSH_COMPATIBILITY.commit) {
    throw new Error("GatherThread DSH connection targets an incompatible Harness version");
  }
  if (manifest.profile !== "web" && manifest.profile !== "headless") {
    throw new Error("GatherThread DSH connection profile is unsupported");
  }
  const binding = requiredObject(manifest.binding, "connection manifest.binding");
  exactKeys(binding, [
    "apiUrl", "projectId", "projectName", "deviceId", "workspacePath", "stateRoot",
    "provider", "model", "shareToolEvents",
  ], "connection manifest.binding");
  if (typeof binding.shareToolEvents !== "boolean") {
    throw new Error("connection manifest.binding.shareToolEvents must be boolean");
  }
  const parsed = parseDshHostConfig({
    enabled: true,
    bindingMode: "project",
    apiUrl: binding.apiUrl,
    credentialReference: { kind: "environment", variable: DSH_CONNECTION_TOKEN_VARIABLE },
    projectId: binding.projectId,
    projectName: binding.projectName,
    deviceId: binding.deviceId,
    workspacePath: binding.workspacePath,
    stateRoot: binding.stateRoot,
    provider: binding.provider,
    model: binding.model,
    shareToolEvents: binding.shareToolEvents,
  });
  if (!parsed.enabled || parsed.bindingMode !== "project") {
    throw new Error("GatherThread DSH connection binding is invalid");
  }
  if (manifest.patchFile !== DSH_CONNECTION_PATCH
    || typeof manifest.patchSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(manifest.patchSha256)) {
    throw new Error("GatherThread DSH connection patch identity is invalid");
  }
  return {
    schemaVersion: 1,
    owner: DSH_CONNECTION_OWNER,
    connectionId,
    package: { name: PACKAGE_NAME, version: PACKAGE_VERSION, pluginEntry },
    deepseekHarness: {
      tag: DSH_COMPATIBILITY.tag,
      version: DSH_COMPATIBILITY.version,
      commit: DSH_COMPATIBILITY.commit,
    },
    profile: manifest.profile,
    binding: {
      apiUrl: parsed.apiUrl,
      projectId: parsed.projectId,
      projectName: parsed.projectName ?? parsed.projectId,
      deviceId: parsed.deviceId,
      workspacePath: parsed.workspacePath,
      stateRoot: parsed.stateRoot,
      provider: parsed.provider,
      model: parsed.model,
      shareToolEvents: parsed.shareToolEvents,
    },
    patchFile: DSH_CONNECTION_PATCH,
    patchSha256: manifest.patchSha256,
  };
}

async function guardedRename(
  sourceParent: string,
  source: string,
  targetParent: string,
  target: string,
): Promise<void> {
  const [sourceChain, targetChain] = await Promise.all([
    secureDirectoryChain(sourceParent),
    secureDirectoryChain(targetParent),
  ]);
  const [sourceParentStat, targetParentStat] = await Promise.all([
    lstat(sourceParent),
    lstat(targetParent),
  ]);
  if (await exists(target)) throw new Error("Managed DSH rename target already exists");
  await rename(source, target);
  const [sourceParentAfter, targetParentAfter] = await Promise.all([
    lstat(sourceParent),
    lstat(targetParent),
  ]);
  if (sourceParentAfter.dev !== sourceParentStat.dev
    || sourceParentAfter.ino !== sourceParentStat.ino
    || targetParentAfter.dev !== targetParentStat.dev
    || targetParentAfter.ino !== targetParentStat.ino) {
    throw new Error("Managed DSH directory changed during atomic rename");
  }
  assertSameDirectoryChain(sourceChain, await secureDirectoryChain(sourceParent));
  assertSameDirectoryChain(targetChain, await secureDirectoryChain(targetParent));
}

async function writePrivateFile(filename: string, content: string): Promise<void> {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertPrivateFile(await lstat(filename), "Managed DSH file");
}

async function readPrivateFile(filename: string, before: Awaited<ReturnType<typeof lstat>>): Promise<string> {
  const flags = process.platform === "win32"
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(filename, flags);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Managed DSH file changed while opening");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function cleanupStaging(directory: string): Promise<void> {
  await unlink(path.join(directory, DSH_CONNECTION_MANIFEST)).catch(() => undefined);
  await unlink(path.join(directory, DSH_CONNECTION_PATCH)).catch(() => undefined);
  await rmdir(directory).catch(() => undefined);
}

function connectionPaths(dshHomeValue: string, connectionIdValue: string): {
  managedRoot: string;
  connectionDirectory: string;
  removedDirectory: string;
} {
  const dshHome = absolutePath(dshHomeValue, "dshHome");
  const connectionId = validateConnectionId(connectionIdValue);
  const managedRoot = path.join(dshHome, "gatherthread");
  return {
    managedRoot,
    connectionDirectory: path.join(managedRoot, "connections", connectionId),
    removedDirectory: path.join(managedRoot, "removed", connectionId),
  };
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error("Could not verify the pinned DeepSeek Harness Git checkout");
  }
}

function normalizeApiUrl(value: string): string {
  const parsed = parseDshHostConfig({
    enabled: true,
    bindingMode: "project",
    apiUrl: value,
    credentialReference: { kind: "environment", variable: DSH_CONNECTION_TOKEN_VARIABLE },
    projectId: "normalization-project",
    projectName: "Normalization",
    deviceId: "normalization-device",
    workspacePath: path.resolve("/normalization-workspace"),
    stateRoot: path.resolve("/normalization-state"),
    provider: "normalization-provider",
    model: "normalization-model",
  });
  if (!parsed.enabled || parsed.bindingMode !== "project") throw new Error("Invalid API URL");
  return parsed.apiUrl;
}

function validateConnectionId(value: unknown): string {
  if (typeof value !== "string" || !DSH_CONNECTION_ID_PATTERN.test(value)) {
    throw new Error("connectionId must be a 24-character lowercase hexadecimal identifier");
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  if (/[\x00-\x1f\x7f-\u009f]/u.test(value)) throw new Error(`${label} contains control characters`);
  return path.resolve(value);
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\x00-\x1f\x7f-\u009f]/u.test(trimmed)) {
    throw new Error(`${label} must be safe non-empty text no longer than ${String(maximum)} characters`);
  }
  return trimmed;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !set.has(key));
  if (extra.length > 0) throw new Error(`${label} contains unsupported keys: ${extra.join(", ")}`);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  return await optionalLstat(target) !== undefined;
}

async function optionalLstat(target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPrivateDirectory(metadata: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (process.platform !== "win32" && (Number(metadata.mode) & 0o777) !== 0o700) {
    throw new Error(`${label} permissions must be 0700`);
  }
}

function assertPrivateFile(metadata: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, never a symbolic link`);
  }
  if (process.platform !== "win32" && (Number(metadata.mode) & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 0600`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
