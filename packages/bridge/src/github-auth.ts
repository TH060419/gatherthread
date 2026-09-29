import { spawn } from "node:child_process";
import { CodeSyncError } from "./code-sync.js";

export type GitHubAuthCommand = (args: readonly string[], timeoutMs: number) => Promise<boolean>;

/** Only a local user action may call this. No device code or token is returned to GT. */
export async function connectGitHubAccount(command: GitHubAuthCommand = runGitHubAuthCommand): Promise<void> {
  if (await command(["auth", "status", "--hostname", "github.com"], 10_000)) return;
  const signedIn = await command(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"], 240_000);
  if (!signedIn || !await command(["auth", "status", "--hostname", "github.com"], 10_000)) {
    throw new CodeSyncError("github_auth_failed", "GitHub sign-in was not completed on this device. Reopen the connection and finish in your browser.");
  }
}

export function runGitHubAuthCommand(args: readonly string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // Never inherit an environment token: the browser flow must establish the
    // device's own durable GitHub CLI login, not a temporary process secret.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_PROMPT_DISABLED"].includes(key)));
    const child = spawn("gh", [...args], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new CodeSyncError(error.code === "ENOENT" ? "github_cli_unavailable" : "github_auth_failed",
        error.code === "ENOENT" ? "Install GitHub CLI on this device before connecting." : "GitHub CLI could not start on this device."));
    });
    child.on("close", (code) => finish(code === 0));
  });
}
