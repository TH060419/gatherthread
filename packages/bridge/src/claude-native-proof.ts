import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface ClaudeNativeTurnProofInput {
  configDirectory: string;
  workspacePath: string;
  nativeSessionId: string;
  transcriptPath: string;
  promptDigest: string;
  answerDigest: string;
  startedAt: string;
  endedAt?: string;
  /** Stat-only Stop watermark. It never contains native transcript bytes. */
  transcriptAnchor?: ClaudeNativeTranscriptAnchor;
}
export interface ClaudeNativeTranscriptAnchor { end: number; device: number; inode: number }
const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_FLUSH_GRACE_BYTES = 256 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Stat metadata only, including while upload is off. A later authorized proof
 * stays near this captured turn rather than chasing a growing transcript tail. */
export async function captureClaudeNativeTranscriptAnchor(input: Pick<ClaudeNativeTurnProofInput,
  "configDirectory" | "workspacePath" | "nativeSessionId" | "transcriptPath">): Promise<ClaudeNativeTranscriptAnchor | undefined> {
  try {
    const { candidate } = await authorizeTranscriptPath(input);
    const metadata = await lstat(candidate);
    requireOwnedFile(metadata);
    return { end: metadata.size, device: metadata.dev, inode: metadata.ino };
  } catch { return undefined; } // Missing final flush keeps a private, retryable outbox item.
}

/** Only called after explicit automatic/manual upload consent. No discovery or whole-history read.
 * A bounded tail proves the exact current prompt/final and actual final model. Thinking/tool bodies
 * are neither returned nor shared. A missing final record at Stop simply remains retryable.
 */
export async function readClaudeNativeTurnProof(input: ClaudeNativeTurnProofInput): Promise<{ observedModel: string }> {
  try { return await readBoundTurn(input); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Claude ")) throw error;
    throw new Error("Claude current-turn proof is not available yet; the local turn remains private for a safe retry");
  }
}

async function readBoundTurn(input: ClaudeNativeTurnProofInput): Promise<{ observedModel: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.nativeSessionId)
    || !/^[a-f0-9]{64}$/.test(input.promptDigest) || !/^[a-f0-9]{64}$/.test(input.answerDigest) || !Number.isFinite(Date.parse(input.startedAt))
    || (input.endedAt !== undefined && (!Number.isFinite(Date.parse(input.endedAt)) || Date.parse(input.endedAt) < Date.parse(input.startedAt)))) {
    throw new Error("Claude current-turn proof has an invalid session identity");
  }
  const { candidate, workspace } = await authorizeTranscriptPath(input);
  const metadata = await lstat(candidate);
  requireOwnedFile(metadata);
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer, start: number;
  try {
    const observed = await handle.stat();
    if (observed.ino !== metadata.ino || observed.dev !== metadata.dev || !observed.isFile() || observed.nlink !== 1) throw new Error("Claude transcript proof file changed during authorization");
    const anchor = input.transcriptAnchor;
    if (anchor && (![anchor.end, anchor.device, anchor.inode].every(value => Number.isSafeInteger(value) && value >= 0)
      || anchor.device !== observed.dev || anchor.inode !== observed.ino || observed.size < anchor.end)) throw new Error("Claude transcript proof watermark no longer matches its owned file");
    // The extra bounded suffix permits a final record flushed just after Stop,
    // without reading later accumulated history or allowing a drifting offset.
    start = Math.max(0, (anchor?.end ?? observed.size) - MAX_TAIL_BYTES);
    const end = anchor ? Math.min(observed.size, anchor.end + MAX_FLUSH_GRACE_BYTES) : observed.size;
    bytes = Buffer.alloc(end - start);
    let filled = 0;
    while (filled < bytes.length) {
      const part = await handle.read(bytes, filled, bytes.length - filled, start + filled);
      if (!part.bytesRead) break;
      filled += part.bytesRead;
    }
    bytes = bytes.subarray(0, filled);
  } finally { await handle.close(); }
  let lines = bytes.toString("utf8").split("\n");
  if (start > 0) lines = lines.slice(1); // Discard the partially read first record, never parse a fragment.
  if (!bytes.toString("utf8").endsWith("\n")) lines.pop();
  let currentPrompt = false, finalModel: string | undefined;
  let finalDigest: string | undefined, finalAt = 0;
  const matches: string[] = [];
  const finishTurn = () => {
    if (currentPrompt && finalDigest === input.answerDigest && Number.isFinite(finalAt) && finalAt >= Date.parse(input.startedAt)
      && (input.endedAt === undefined || finalAt <= Date.parse(input.endedAt)) && finalModel && /^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/.test(finalModel)) matches.push(finalModel);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Claude current-turn proof contains malformed JSONL"); }
    if (!record(value) || value.isMeta === true || value.isSidechain === true || !["user", "assistant"].includes(String(value.type))) continue;
    if (value.sessionId !== input.nativeSessionId || value.cwd !== workspace || !record(value.message)) throw new Error("Claude transcript proof record belongs to another session or workspace");
    const message = value.message;
    const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.flatMap(block => record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
    if (value.type === "user") {
      if (!content) continue; // Tool results are not another human prompt.
      finishTurn(); currentPrompt = digest(content) === input.promptDigest;
      finalDigest = undefined; finalModel = undefined; finalAt = 0;
    } else if (currentPrompt && content) {
      finalDigest = digest(content); finalModel = typeof message.model === "string" ? message.model : undefined;
      finalAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : 0;
    }
  }
  finishTurn();
  if (matches.length !== 1) throw new Error("Claude transcript proof does not uniquely match this captured prompt, final answer and actual model");
  return { observedModel: matches[0]! };
}

async function authorizeTranscriptPath(input: Pick<ClaudeNativeTurnProofInput,
  "configDirectory" | "workspacePath" | "nativeSessionId" | "transcriptPath">): Promise<{ candidate: string; workspace: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.nativeSessionId)) throw new Error("Claude transcript proof session is invalid");
  const root = await realpath(input.configDirectory), workspace = await realpath(input.workspacePath);
  const expected = path.join(root, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"), `${input.nativeSessionId}.jsonl`);
  const candidate = path.resolve(input.transcriptPath);
  const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(candidate) !== comparable(expected)) throw new Error("Claude transcript proof path does not match the authorized workspace/session root");
  for (const directory of [path.join(root, "projects"), path.dirname(expected)]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Claude transcript proof parent must not be a symbolic link");
  }
  return { candidate, workspace };
}

function requireOwnedFile(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (process.getuid && metadata.uid !== process.getuid())) throw new Error("Claude transcript proof requires a single-link owned regular file");
}
