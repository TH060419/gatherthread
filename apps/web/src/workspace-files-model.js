/** File workspace helpers. Server schemas remain the authority for every write. */
const encoder = new TextEncoder();
const ignored = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
export const FILE_TEXT_LIMIT = 2 * 1024 * 1024;
export const FILE_PREVIEW_LIMIT = 20 * 1024 * 1024;

export function validateFileImport(files, provider) {
  if (files.length > 100) throw new Error("files.operationLimit");
  const maxFile = (provider === "gt-cloud" ? 2 : 8) * 1024 * 1024;
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFile) {
      throw new Error(provider === "gt-cloud" ? "files.cloudFileLimit" : "files.githubFileLimit");
    }
    total += file.size;
  }
  if (total > 8 * 1024 * 1024) throw new Error("files.writeBatchLimit");
}

export function validateFileWriteOperations(operations, provider) {
  if (operations.length > 100) throw new Error("files.operationLimit");
  validateFileImport(operations.filter((operation) => operation.type === "write").map((operation) => {
    const encoded = operation.content_base64;
    return { size: encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) };
  }), provider);
}

export function portablePathKey(path) {
  return String(path).normalize("NFC").replace(ignored, "").toLowerCase();
}

export function normalizeFilePath(value) {
  if (typeof value !== "string" || !value || value.length > 500 || value.startsWith("/")
    || /[\\\u0000-\u001f\u007f\ud800-\udfff:<>"|?*]/u.test(value)) throw new Error("files.pathInvalid");
  for (const part of value.split("/")) {
    const lower = portablePathKey(part);
    if (!part || encoder.encode(part).length > 255 || [".", ".."].includes(lower)
      || !lower || /[. ]$/u.test(part) || /[. ]$/u.test(lower)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(lower)
      || /^[^.~]{1,6}~[1-9][0-9]*(?:\.[^.]*)?$/u.test(lower)
      || [".git", ".codex", ".dsh", ".ssh", ".npmrc", ".netrc", ".ds_store"].includes(lower)
      || lower.startsWith(".gatherthread")
      || ((lower === ".env" || lower.startsWith(".env.")) && ![".env.example", ".env.sample", ".env.template"].includes(lower))
      || /\.(?:pem|p12|pfx|key)$/iu.test(lower) || /^(?:id_rsa|id_ed25519)(?:\.|$)/iu.test(lower)) throw new Error("files.pathInvalid");
  }
  return value;
}

export function fileContextKey(context = {}) {
  return JSON.stringify([context.scope ?? "", context.userId ?? "", context.projectId ?? ""]);
}

export function canEditFileBranch(context, branch, historic = false) {
  return Boolean(context?.canWrite && context?.userId && !historic && branch?.id !== "main"
    && branch?.can_write === true && (branch.id === "own" || branch.user_id === context.userId));
}

export function fileParent(path) { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }
export function fileBasename(path) { return path.slice(path.lastIndexOf("/") + 1); }
export function pathContains(parent, path) { return path === parent || path.startsWith(`${parent}/`); }

export function validateFileDestination(destination, entries, { source, isDirectory = false } = {}) {
  const path = normalizeFilePath(destination);
  const key = portablePathKey(path);
  if (source && isDirectory && pathContains(portablePathKey(source), key)) throw new Error("files.pathInsideSource");
  const keys = entries.map((entry) => portablePathKey(entry.path));
  if (keys.some((existing) => existing === key || existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`))) {
    throw new Error("files.pathExists");
  }
  return path;
}

/** Derive folders without trusting entry names as markup or accepting unsafe paths. */
export function buildFileTree(entries = []) {
  const root = { path: "", name: "", directory: true, children: [] };
  const directories = new Map([["", root]]);
  const seen = new Set();
  for (const entry of entries) {
    let path;
    try { path = normalizeFilePath(entry.path); } catch { continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const parts = path.split("/");
    let parent = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const parentPath = parts.slice(0, index + 1).join("/");
      if (!directories.has(parentPath)) {
        const directory = { path: parentPath, name: parts[index], directory: true, children: [] };
        directories.set(parentPath, directory); parent.children.push(directory);
      }
      parent = directories.get(parentPath);
    }
    parent.children.push({ ...entry, path, name: parts.at(-1), directory: false });
  }
  const sort = (node) => {
    node.children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.children.filter((child) => child.directory).forEach(sort);
  };
  sort(root); return root;
}

export function flattenFileTree(root, expanded = new Set(), query = "") {
  const search = query.trim().toLocaleLowerCase();
  const matching = (node) => node.path.toLocaleLowerCase().includes(search)
    || (node.directory && node.children.some(matching));
  const rows = [];
  const visit = (children, depth) => {
    for (const child of children) {
      if (search && !matching(child)) continue;
      rows.push({ ...child, depth });
      if (child.directory && (search || expanded.has(child.path))) visit(child.children, depth + 1);
    }
  };
  visit(root.children, 0); return rows;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
export function textToBase64(text) { return bytesToBase64(encoder.encode(text)); }

export function decodeFileContent(content) {
  const encoded = content?.content_base64;
  if (typeof encoded !== "string" || encoded.length > Math.ceil(FILE_PREVIEW_LIMIT / 3) * 4
    || encoded.length % 4 !== 0) throw new Error("files.contentInvalid");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  // Linear validation avoids the RegExp stack overflow caused by repeated base64 groups on large files.
  if (/[^A-Za-z0-9+/]/u.test(encoded.slice(0, encoded.length - padding))) throw new Error("files.contentInvalid");
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > FILE_PREVIEW_LIMIT || (Number.isFinite(content.size) && content.size !== bytes.length)) throw new Error("files.contentInvalid");
  return bytes;
}

export function describeFileContent(path, bytes) {
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", mime: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg" };
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return { kind: "image", mime: "image/gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (ascii(0, 5) === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (bytes.length <= FILE_TEXT_LIMIT && !bytes.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { kind: /\.(?:md|markdown|mdown)$/iu.test(path) ? "markdown" : "text", text, mime: "text/plain;charset=utf-8" };
    } catch { /* Binary bytes are downloadable, never coerced into editable UTF-8. */ }
  }
  return { kind: "binary", mime: "application/octet-stream" };
}
