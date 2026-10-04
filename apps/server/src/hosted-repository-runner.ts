import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stopHostedContainer } from "./hosted-agent-recovery.js";
import { CodeFilesSchema, containsCodeSyncSecret, type CodeFile } from "@gatherthread/protocol";
import { HostedModelProxy, runDocker, type HostedAgentOptions } from "./hosted-agent.js";
import { HostedNpmProxy } from "./hosted-npm-proxy.js";
import type { HostedEndpoint } from "./hosted-agent-pool.js";
import { redactJson } from "./redaction.js";

export class HostedRepositoryRunner {
  constructor(private readonly options: HostedAgentOptions) {}
  async run(files: CodeFile[], prompt: string, endpoint: HostedEndpoint, onUnavailable: (ms: number) => void,
    controlOptions?: { taskId: string; signal: AbortSignal; authorize: () => void }) {
    CodeFilesSchema.parse(files);
    if (controlOptions && !/^gh-task-[a-f0-9]{32}$/u.test(controlOptions.taskId)) throw new Error("invalid_repository_task");
    const npm = new HostedNpmProxy(files, this.options.fetch ?? globalThis.fetch, controlOptions?.authorize);
    const root = mkdtempSync(join(tmpdir(), "gt-repository-"));
    const workspace = join(root, "input");
    const control = join(root, "control");
    const modelSocket = join(root, "model.sock");
    const npmSocket = join(root, "npm.sock");
    const name = `gt-repository-${controlOptions ? controlOptions.taskId.slice(8) : randomBytes(10).toString("hex")}`;
    const model = new HostedModelProxy({ endpoint, repositoryRun: true, onUnavailable,
      ...(controlOptions ? { authorize: controlOptions.authorize } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
    try {
      mkdirSync(workspace, { mode: 0o755 }); mkdirSync(control, { mode: 0o755 });
      for (const file of files) {
        const path = join(workspace, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
        writeFileSync(path, Buffer.from(file.content_base64, "base64"), { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
        chmodSync(path, file.executable ? 0o755 : 0o644);
      }
      writeFileSync(join(control, "prompt.txt"), String(redactJson(prompt)), { mode: 0o644 });
      writeFileSync(join(control, "opencode.json"), JSON.stringify({
        model: `hosted/${endpoint.model}`, small_model: `hosted/${endpoint.model}`, share: "disabled",
        provider: { hosted: { npm: "@ai-sdk/openai-compatible", name: "GatherThread Cloud Agent",
          options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "local" },
          models: { [endpoint.model]: { name: endpoint.label, limit: { context: 32000, output: 2048 } } } } },
        permission: { read: "allow", edit: "allow", bash: "allow", task: "deny", external_directory: "allow", webfetch: "deny", websearch: "deny" },
      }), { mode: 0o644 });
      await model.listen(modelSocket); await npm.listen(npmSocket);
      const args = ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
        "--user", "10001:10001", "--workdir", "/workspace",
        "--mount", `type=bind,src=${workspace},dst=/input,readonly`,
        "--mount", `type=bind,src=${control},dst=/run/gatherthread,readonly`,
        "--mount", `type=bind,src=${modelSocket},dst=/run/model.sock`,
        "--mount", `type=bind,src=${npmSocket},dst=/run/npm.sock`,
        "--tmpfs", "/workspace:rw,nosuid,size=1536m,mode=1777",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m", "--tmpfs", "/home/agent:rw,nosuid,size=128m",
        "-e", "HOME=/home/agent", "-e", "OPENCODE_CONFIG=/run/gatherthread/opencode.json",
        "-e", "GT_HOSTED_REPOSITORY=1", "-e", "NO_COLOR=1", "-e", "CI=1", this.options.image];
      const output = await (this.options.runContainer ?? ((a, t) => runDocker(a, t, 12 * 1024 * 1024, controlOptions?.signal)))(args, 900_000);
      const result = JSON.parse(output);
      if (!result.answer || result.save_error || !Array.isArray(result.files)) throw new Error("repository_result_invalid");
      const changed = CodeFilesSchema.parse(result.files);
      if (changed.some((f) => containsCodeSyncSecret(Buffer.from(f.content_base64, "base64").toString("utf8")))) {
        throw new Error("repository_secret_detected");
      }
      return { answer: String(redactJson(String(result.answer))).slice(0, 12000), files: changed };
    } finally {
      let cleanupError: unknown;
      try { if (!this.options.runContainer) stopHostedContainer(name); }
      catch (error) { cleanupError = error; }
      await model.close().catch(() => undefined); await npm.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      if (cleanupError) throw cleanupError;
    }
  }
}
