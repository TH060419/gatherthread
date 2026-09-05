import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Resolve an absent path without guessing through symlinks: realpath the
 * nearest existing ancestor, then append only the still-absent components.
 */
export async function prospectiveRealPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing ancestor for path: ${candidate}`);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Reject every symbolic-link component already present in a state directory. */
export async function secureDirectoryChain(directory: string): Promise<readonly DirectoryIdentity[]> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  const components = relative ? relative.split(path.sep) : [];
  const identities: DirectoryIdentity[] = [];
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("DSH connector state path must not traverse a symbolic-link ancestor");
    }
    if (!metadata.isDirectory()) {
      throw new Error("DSH connector state path ancestor must be a directory");
    }
    identities.push({ path: current, dev: metadata.dev, ino: metadata.ino });
  }
  return identities;
}

export function assertSameDirectoryChain(
  before: readonly DirectoryIdentity[],
  after: readonly DirectoryIdentity[],
): void {
  if (before.length !== after.length
    || before.some((entry, index) => {
      const candidate = after[index];
      return candidate === undefined
        || candidate.path !== entry.path
        || candidate.dev !== entry.dev
        || candidate.ino !== entry.ino;
    })) {
    throw new Error("DSH connector state path ancestors changed during file access");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
