import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync } from "node:fs";
import { ApiError } from "./errors.js";
import type { CodeFile } from "@gatherthread/protocol";

/** Exact lockfile tarballs only. No arbitrary registry, metadata, redirects or credentials. */
export class HostedNpmProxy {
  private readonly allowed = new Set<string>();
  private bytes = 0;
  private calls = 0;
  private active = 0;
  readonly server = createServer((req, res) => void this.forward(req, res));
  constructor(files: CodeFile[], private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly authorize?: () => void) {
    const manifest = files.find((f) => f.path === "package.json");
    const lockFile = files.find((f) => f.path === "package-lock.json");
    if (!manifest || !lockFile) throw new ApiError(400, "npm_lock_required", "Commit package.json and package-lock.json before starting a cloud task");
    const pkg = JSON.parse(Buffer.from(manifest.content_base64, "base64").toString("utf8"));
    if (pkg.packageManager && !/^npm@/u.test(pkg.packageManager)) throw new ApiError(400, "npm_only", "This cloud environment supports npm projects");
    const lock = JSON.parse(Buffer.from(lockFile.content_base64, "base64").toString("utf8"));
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== "object") {
      throw new ApiError(400, "npm_lock_unsupported", "Use an npm v2 or v3 package lock");
    }
    const packages = Object.entries(lock.packages);
    if (packages.length > 2000) throw new ApiError(413, "npm_dependency_limit", "Too many locked dependencies");
    for (const [name, raw] of packages) {
      if (!name) continue;
      const item = raw as { link?: boolean; resolved?: string; integrity?: string };
      if (item.link) continue; // npm validates local workspace links during ci.
      if (!item.resolved) throw new ApiError(400, "npm_dependency_source", "Every external dependency needs a registry tarball");
      let url: URL;
      try { url = new URL(item.resolved); } catch { throw new ApiError(400, "npm_dependency_source", "Unsupported dependency source"); }
      if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password
        || url.search || url.hash || !/^\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+\/-\/[a-zA-Z0-9_.-]+\.tgz$/u.test(url.pathname)
        || !item.integrity || !/^(?:sha512|sha256)-[A-Za-z0-9+/=]+$/u.test(item.integrity)) {
        throw new ApiError(400, "npm_dependency_source", "Only integrity-pinned public npm tarballs are supported");
      }
      this.allowed.add(url.pathname);
    }
  }
  async listen(path: string) {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject);
      this.server.listen(path, () => { this.server.off("error", reject); resolve(); }); });
    chmodSync(path, 0o666);
  }
  async close() {
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private async forward(req: IncomingMessage, res: ServerResponse) {
    let acquired = false;
    try {
      this.authorize?.();
      if (req.method !== "GET" || !req.url || !this.allowed.has(req.url) || this.calls++ >= 4000) {
        res.writeHead(403).end(); return;
      }
      if (this.active >= 8) { res.writeHead(429).end(); return; }
      this.active++; acquired = true;
      const controller = new AbortController();
      res.once("close", () => controller.abort());
      const upstream = await this.fetcher(`https://registry.npmjs.org${req.url}`, {
        redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), headers: { accept: "application/octet-stream" },
      });
      if (!upstream.ok || !upstream.body) { res.writeHead(502).end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let fileBytes = 0;
      for await (const chunk of upstream.body) {
        fileBytes += chunk.length; this.bytes += chunk.length;
        if (fileBytes > 32 * 1024 * 1024 || this.bytes > 256 * 1024 * 1024) throw new Error("npm_download_limit");
        if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
          const drain = () => { res.off("close", closed); resolve(); };
          const closed = () => { res.off("drain", drain); reject(new Error("npm_client_closed")); };
          res.once("drain", drain); res.once("close", closed);
        });
      }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); }
    finally { if (acquired) this.active--; }
  }
}
