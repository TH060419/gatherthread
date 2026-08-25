import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const PROJECTS_DIRECTORY = "GatherThread Projects";
const PROJECT_MARKER = ".gatherthread-project.json";
const MAX_WORKSPACE_NAME_BYTES = 120;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface GatherThreadProjectMarker {
  version: 1;
  apiUrl: string;
  projectId: string;
  projectName: string;
}

export interface EnsureProjectWorkspaceOptions {
  apiUrl: string;
  projectId: string;
  projectName: string;
  homeDirectory?: string;
}

export function sanitizeProjectWorkspaceName(projectName: string): string {
  let safeName = projectName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[ .-]+|[ .-]+$/g, "");
  if (!safeName || safeName === "." || safeName === "..") safeName = "GatherThread Project";
  if (WINDOWS_RESERVED_NAME.test(safeName)) safeName = `_${safeName}`;
  while (Buffer.byteLength(safeName, "utf8") > MAX_WORKSPACE_NAME_BYTES) {
    safeName = [...safeName].slice(0, -1).join("").replace(/[ .]+$/g, "");
  }
  return safeName || "GatherThread Project";
}

export async function ensureProjectWorkspace(options: EnsureProjectWorkspaceOptions): Promise<string> {
  if (!options.projectId.trim() || /[\0\r\n]/.test(options.projectId)) {
    throw new Error("GatherThread project ID is invalid");
  }
  const homeDirectory = path.resolve(options.homeDirectory ?? homedir());
  const projectsRoot = path.resolve(homeDirectory, PROJECTS_DIRECTORY);
  await ensurePrivateDirectory(projectsRoot, true, "GatherThread projects root");

  const workspaceName = sanitizeProjectWorkspaceName(options.projectName);
  const workspacePath = path.resolve(projectsRoot, workspaceName);
  const relativeWorkspace = path.relative(projectsRoot, workspacePath);
  if (!relativeWorkspace || relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
    throw new Error("GatherThread project name does not resolve to a safe workspace");
  }
  const created = await ensurePrivateDirectory(workspacePath, false, "GatherThread project workspace");
  const markerPath = path.join(workspacePath, PROJECT_MARKER);
  const expected: GatherThreadProjectMarker = {
    version: 1,
    apiUrl: options.apiUrl,
    projectId: options.projectId,
    projectName: options.projectName,
  };

  const markerMetadata = await lstat(markerPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (markerMetadata) {
    if (markerMetadata.isSymbolicLink() || !markerMetadata.isFile()) {
      throw new Error("GatherThread project marker must be a regular file, not a symlink");
    }
    if (process.platform !== "win32" && (markerMetadata.mode & 0o077) !== 0) {
      throw new Error("GatherThread project marker is not private; repair its permissions before reconnecting");
    }
    const marker = parseProjectMarker(await readFile(markerPath, "utf8"));
    if (marker.apiUrl !== expected.apiUrl || marker.projectId !== expected.projectId) {
      throw new Error("Local workspace is already bound to a different GatherThread project or server");
    }
    return workspacePath;
  }

  const entries = await readdir(workspacePath);
  if (!created && entries.length > 0) {
    throw new Error("Refusing to use a non-empty directory that is not managed by GatherThread");
  }
  const handle = await open(markerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error("GatherThread project marker appeared concurrently; reconnect to validate it", { cause: error });
      }
      throw error;
    });
  try {
    await handle.writeFile(`${JSON.stringify(expected, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return workspacePath;
}

async function ensurePrivateDirectory(
  directoryPath: string,
  recursive: boolean,
  label: string,
): Promise<boolean> {
  let created = false;
  try {
    await mkdir(directoryPath, { recursive, mode: 0o700 });
    created = !recursive;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  if (process.platform !== "win32") await chmod(directoryPath, 0o700);
  return created;
}

function parseProjectMarker(value: string): GatherThreadProjectMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("GatherThread project marker is invalid JSON", { cause: error });
  }
  if (!isObject(parsed)
    || parsed.version !== 1
    || typeof parsed.apiUrl !== "string"
    || typeof parsed.projectId !== "string"
    || typeof parsed.projectName !== "string") {
    throw new Error("GatherThread project marker is invalid; repair or rebuild the workspace explicitly");
  }
  return parsed as unknown as GatherThreadProjectMarker;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
