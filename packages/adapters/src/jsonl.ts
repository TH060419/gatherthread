import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  TailResult,
  TranscriptAdapter,
  TranscriptCursor,
} from "./types.js";

const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;

export interface TailOptions {
  authorizedRoots: readonly string[];
  maxReadBytes?: number;
}

export async function tailJsonlTranscript(
  adapter: TranscriptAdapter,
  transcriptPath: string,
  cursor: TranscriptCursor | undefined,
  options: TailOptions,
): Promise<TailResult> {
  const authorizedPath = await resolveAuthorizedPath(transcriptPath, options.authorizedRoots);
  const metadata = await stat(authorizedPath);
  if (!metadata.isFile()) throw new Error(`Transcript is not a file: ${authorizedPath}`);

  const sameFile = cursor?.path === authorizedPath
    && cursor.device === metadata.dev
    && cursor.inode === metadata.ino
    && cursor.offset <= metadata.size;
  const start = sameFile ? cursor.offset : 0;
  const available = metadata.size - start;
  const readLength = Math.min(available, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  if (readLength <= 0) {
    return {
      events: [],
      malformedLines: 0,
      cursor: createCursor(authorizedPath, start, metadata.dev, metadata.ino),
    };
  }

  const handle = await open(authorizedPath, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, start);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const finalNewline = buffer.lastIndexOf(0x0a);
  if (finalNewline < 0) {
    if (readLength === (options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES)) {
      throw new Error("Transcript line exceeds the configured maximum read size");
    }
    return {
      events: [],
      malformedLines: 0,
      cursor: createCursor(authorizedPath, start, metadata.dev, metadata.ino),
    };
  }

  const completeBytes = buffer.subarray(0, finalNewline + 1);
  const lines = completeBytes.toString("utf8").split("\n");
  lines.pop();

  const events = [];
  let malformedLines = 0;
  for (const line of lines) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized.trim()) continue;
    try {
      events.push(...adapter.parseLine(normalized));
    } catch {
      malformedLines += 1;
    }
  }

  return {
    events,
    malformedLines,
    cursor: createCursor(authorizedPath, start + completeBytes.length, metadata.dev, metadata.ino),
  };
}

export async function resolveAuthorizedPath(
  candidate: string,
  authorizedRoots: readonly string[],
): Promise<string> {
  if (authorizedRoots.length === 0) {
    throw new Error("Transcript access is disabled until at least one root is explicitly authorized");
  }

  const [resolvedCandidate, ...resolvedRoots] = await Promise.all([
    realpath(candidate),
    ...authorizedRoots.map((root) => realpath(root)),
  ]);

  const permitted = resolvedRoots.some((root) => {
    const relative = path.relative(root, resolvedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!permitted) throw new Error(`Transcript path is outside authorized roots: ${candidate}`);
  return resolvedCandidate;
}

function createCursor(
  transcriptPath: string,
  offset: number,
  device: number,
  inode: number,
): TranscriptCursor {
  return { path: transcriptPath, offset, device, inode };
}
