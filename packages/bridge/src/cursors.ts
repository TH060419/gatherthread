import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TranscriptCursor } from "@agent-cooperation/adapters";

export interface BridgeCursorState {
  server: Record<string, number>;
  local: Record<string, TranscriptCursor>;
}

export interface CursorStore {
  load(): Promise<BridgeCursorState>;
  save(state: BridgeCursorState): Promise<void>;
}

const EMPTY_STATE: BridgeCursorState = { server: {}, local: {} };

export class MemoryCursorStore implements CursorStore {
  #state: BridgeCursorState = EMPTY_STATE;

  async load(): Promise<BridgeCursorState> {
    return structuredClone(this.#state);
  }

  async save(state: BridgeCursorState): Promise<void> {
    this.#state = structuredClone(state);
  }
}

export class FileCursorStore implements CursorStore {
  readonly #path: string;

  constructor(cursorPath: string) {
    this.#path = path.resolve(cursorPath);
  }

  async load(): Promise<BridgeCursorState> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<BridgeCursorState>;
      return {
        server: isNumberRecord(parsed.server) ? parsed.server : {},
        local: isCursorRecord(parsed.local) ? parsed.local : {},
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async save(state: BridgeCursorState): Promise<void> {
    await mkdir(path.dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#path);
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every((item) =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
  );
}

function isCursorRecord(value: unknown): value is Record<string, TranscriptCursor> {
  return isObject(value) && Object.values(value).every((item) =>
    isObject(item)
    && typeof item.path === "string"
    && Number.isSafeInteger(item.offset)
    && Number(item.offset) >= 0,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
