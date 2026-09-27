export type HarnessName = "codex" | "claude-code" | "zcode";

export type CaptureFidelity =
  | "canonical_history"
  | "harness_transcript"
  | "provider_request";

export type TranscriptEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result";

export interface TranscriptEvent {
  kind: TranscriptEventKind;
  localEventId: string;
  timestamp?: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: unknown;
  result?: unknown;
  isError?: boolean;
  harness: HarnessName;
  captureFidelity: "harness_transcript";
}

export interface TranscriptCursor {
  path: string;
  offset: number;
  device?: number;
  inode?: number;
}

export interface TailResult {
  events: TranscriptEvent[];
  cursor: TranscriptCursor;
  malformedLines: number;
}

export interface TranscriptAdapter {
  readonly harness: HarnessName;
  parseLine(line: string): TranscriptEvent[];
}
