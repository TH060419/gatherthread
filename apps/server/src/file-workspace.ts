import {
  FileBranchesInputSchema, FileChangesInputSchema, FileContentInputSchema, FileHistoryInputSchema,
  CLOUD_CODE_SYNC_LIMITS, FileMutationInputSchema, FileOperationSchema, FilePathSchema, FileTreeInputSchema,
  type CodeFile, type FileBranchesInput, type FileBranchesResult, type FileChangesInput, type FileChangesResult,
  type FileContentInput, type FileContentResult, type FileHistoryInput, type FileHistoryResult,
  type FileMutationInput, type FileMutationResult, type FileOperation, type FileTreeInput, type FileTreeResult,
} from "@gatherthread/protocol";
import type { CodeRepository } from "./code-repository.js";
import type { Actor, CollaborationDatabase } from "./database.js";
import { ApiError, notFound } from "./errors.js";

type MaybePromise<T> = T | Promise<T>;
export interface FileWorkspaceProviderAdapter {
  branches(actor: Actor, projectId: string, input: FileBranchesInput): MaybePromise<FileBranchesResult>;
  tree(actor: Actor, projectId: string, input: FileTreeInput): MaybePromise<FileTreeResult>;
  content(actor: Actor, projectId: string, input: FileContentInput): MaybePromise<FileContentResult>;
  history(actor: Actor, projectId: string, input: FileHistoryInput): MaybePromise<FileHistoryResult>;
  changes(actor: Actor, projectId: string, input: FileChangesInput): MaybePromise<FileChangesResult>;
  mutate(actor: Actor, projectId: string, input: FileMutationInput): MaybePromise<FileMutationResult>;
}

/** Provider dispatch keeps browser file work separate from local connector controls. */
export class FileWorkspace implements FileWorkspaceProviderAdapter {
  constructor(private readonly database: CollaborationDatabase, private readonly codeRepository: CodeRepository,
    private readonly githubAdapter?: FileWorkspaceProviderAdapter) {}

  branches(actor: Actor, projectId: string, value: unknown): MaybePromise<FileBranchesResult> {
    const input = FileBranchesInputSchema.parse(value); this.authorize(actor, projectId);
    return input.provider === "gt-cloud" ? this.codeRepository.fileBranches(actor, projectId, input) : this.github().branches(actor, projectId, input);
  }
  tree(actor: Actor, projectId: string, value: unknown): MaybePromise<FileTreeResult> {
    const input = FileTreeInputSchema.parse(value); this.authorize(actor, projectId);
    return input.provider === "gt-cloud" ? this.codeRepository.fileTree(actor, projectId, input) : this.github().tree(actor, projectId, input);
  }
  content(actor: Actor, projectId: string, value: unknown): MaybePromise<FileContentResult> {
    const input = FileContentInputSchema.parse(value); this.authorize(actor, projectId);
    return input.provider === "gt-cloud" ? this.codeRepository.fileContent(actor, projectId, input) : this.github().content(actor, projectId, input);
  }
  history(actor: Actor, projectId: string, value: unknown): MaybePromise<FileHistoryResult> {
    const input = FileHistoryInputSchema.parse(value); this.authorize(actor, projectId);
    return input.provider === "gt-cloud" ? this.codeRepository.fileHistory(actor, projectId, input) : this.github().history(actor, projectId, input);
  }
  changes(actor: Actor, projectId: string, value: unknown): MaybePromise<FileChangesResult> {
    const input = FileChangesInputSchema.parse(value); this.authorize(actor, projectId);
    return input.provider === "gt-cloud" ? this.codeRepository.fileChanges(actor, projectId, input) : this.github().changes(actor, projectId, input);
  }
  mutate(actor: Actor, projectId: string, value: unknown): MaybePromise<FileMutationResult> {
    const input = FileMutationInputSchema.parse(value); this.authorize(actor, projectId);
    return input.provider === "gt-cloud" ? this.codeRepository.fileMutate(actor, projectId, input) : this.github().mutate(actor, projectId, input);
  }
  private authorize(actor: Actor, projectId: string): void {
    this.database.assertActiveDevice(actor);
    if (!this.database.projectMembershipRole(projectId, actor.user_id)) throw notFound("Project");
  }
  private github(): FileWorkspaceProviderAdapter {
    if (!this.githubAdapter) throw new ApiError(503, "file_provider_unavailable", "GitHub file access is not configured");
    return this.githubAdapter;
  }
}

function portableKey(path: string): string {
  return path.normalize("NFC").replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "").toLowerCase();
}
function conflict(): ApiError {
  return new ApiError(409, "file_path_conflict", "The destination already exists or conflicts with a file or folder");
}
/** Reject file/directory overlaps and aliases on case-insensitive portable filesystems. */
function assertLayout(files: CodeFile[]): void {
  const nodes = new Map<string, { path: string; file: boolean }>();
  for (const file of files) {
    const components = file.path.split("/");
    for (let index = 1; index <= components.length; index += 1) {
      const path = components.slice(0, index).join("/");
      const key = portableKey(path), isFile = index === components.length;
      const existing = nodes.get(key);
      if (existing && (existing.path !== path || existing.file || isFile)) throw conflict();
      nodes.set(key, { path, file: isFile });
    }
  }
}

function fileBytes(file: Pick<CodeFile, "content_base64">): number {
  const encoded = file.content_base64;
  return encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
}
function assertCloudBudget(count: number, bytes: number, fileSize = 0): void {
  if (count > CLOUD_CODE_SYNC_LIMITS.maxFiles || bytes > CLOUD_CODE_SYNC_LIMITS.maxSnapshotBytes
    || fileSize > CLOUD_CODE_SYNC_LIMITS.maxFileBytes) {
    throw new ApiError(507, "code_storage_quota_exceeded", "Code storage, branch, or checkpoint quota exceeded");
  }
}

/** Bound each sequential cloud tree before expanding it; callers persist atomically. */
export function applyFileOperations(original: CodeFile[], operations: FileOperation[]): CodeFile[] {
  assertCloudBudget(original.length, 0);
  let bytes = 0;
  for (const file of original) {
    const size = fileBytes(file);
    bytes += size;
    assertCloudBudget(original.length, bytes, size);
  }
  let files = original.map((file) => ({ ...file }));
  assertLayout(files);
  for (const raw of operations) {
    const operation = FileOperationSchema.parse(raw);
    if (operation.type === "write") {
      const previous = files.find((file) => file.path === operation.path);
      const size = fileBytes(operation);
      const nextBytes = bytes - (previous ? fileBytes(previous) : 0) + size;
      assertCloudBudget(files.length + (previous ? 0 : 1), nextBytes, size);
      files = files.filter((file) => file.path !== operation.path);
      files.push({ path: operation.path, content_base64: operation.content_base64,
        executable: operation.executable ?? previous?.executable ?? false });
      bytes = nextBytes;
    } else {
      const source = files.filter((file) => file.path === operation.path || file.path.startsWith(`${operation.path}/`));
      if (!source.length) throw notFound("File or folder");
      if (operation.type === "delete") {
        const deleted = new Set(source.map((file) => file.path));
        files = files.filter((file) => !deleted.has(file.path));
        bytes -= source.reduce((sum, file) => sum + fileBytes(file), 0);
      } else {
        const destinationKey = portableKey(operation.destination), sourceKey = portableKey(operation.path);
        if (destinationKey === sourceKey || destinationKey.startsWith(`${sourceKey}/`)
          || files.some((file) => portableKey(file.path) === destinationKey || portableKey(file.path).startsWith(`${destinationKey}/`))) throw conflict();
        const nextBytes = bytes + (operation.type === "copy" ? source.reduce((sum, file) => sum + fileBytes(file), 0) : 0);
        assertCloudBudget(files.length + (operation.type === "copy" ? source.length : 0), nextBytes);
        const copied = source.map((file) => ({ ...file,
          path: FilePathSchema.parse(operation.destination + file.path.slice(operation.path.length)) }));
        if (operation.type === "move") {
          const removed = new Set(source.map((file) => file.path));
          files = files.filter((file) => !removed.has(file.path));
        }
        files.push(...copied);
        bytes = nextBytes;
      }
    }
    assertLayout(files);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
