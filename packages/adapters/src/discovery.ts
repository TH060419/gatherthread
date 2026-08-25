import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessName } from "./types.js";
import { resolveAuthorizedPath } from "./jsonl.js";

export interface TranscriptFile {
  path: string;
  harness: HarnessName;
  size: number;
  modifiedAt: string;
}

export interface DiscoveryOptions {
  maxFiles?: number;
}

export async function discoverJsonlTranscripts(
  harness: HarnessName,
  authorizedRoots: readonly string[],
  options: DiscoveryOptions = {},
): Promise<TranscriptFile[]> {
  if (authorizedRoots.length === 0) return [];
  const limit = options.maxFiles ?? 1_000;
  const discovered: TranscriptFile[] = [];
  const roots = await Promise.all(authorizedRoots.map((root) => realpath(root)));
  const pending = [...roots];
  const visited = new Set<string>();

  while (pending.length > 0 && discovered.length < limit) {
    const candidate = pending.shift();
    if (!candidate) break;
    const canonicalCandidate = await realpath(candidate);
    if (visited.has(canonicalCandidate)) continue;
    visited.add(canonicalCandidate);
    const metadata = await stat(canonicalCandidate);
    if (metadata.isFile()) {
      if (canonicalCandidate.endsWith(".jsonl")) {
        const authorizedPath = await resolveAuthorizedPath(canonicalCandidate, roots);
        discovered.push({
          path: authorizedPath,
          harness,
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        });
      }
      continue;
    }
    if (!metadata.isDirectory()) continue;

    const entries = await readdir(canonicalCandidate, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(canonicalCandidate, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const authorizedPath = await resolveAuthorizedPath(child, roots);
          pending.push(authorizedPath);
        } catch {
          // Symlinks escaping the opt-in roots are intentionally invisible.
        }
      } else if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".jsonl"))) {
        pending.push(child);
      }
    }
  }

  return discovered.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}
