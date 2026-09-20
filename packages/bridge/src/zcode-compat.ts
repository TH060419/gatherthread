import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Every ZCode-version-sensitive interaction lives in this module.
 *
 * The upstream ZCode CLI is an Electron-bundled executable whose headless
 * surface may change between builds. Nothing outside this module guesses at
 * CLI paths, flags, or output shapes: the connector resolves one command spec,
 * probes its capabilities structurally, and refuses to run when a required
 * capability is missing. This mirrors the fail-closed compatibility boundary
 * the repository applies to Codex App Server and DSH Host versions.
 */

export interface ZcodeCommandSpec {
  /** Executable to spawn. For a `.cjs`/`.mjs`/`.js` entry this is Node itself. */
  command: string;
  /** Arguments that must precede any subcommand, e.g. the script path for Node. */
  baseArgs: readonly string[];
  /** Where the spec was found, for actionable diagnostics only. */
  source: string;
}

export interface ZcodeCliProbe {
  /** First line of `--version` output, bounded to 80 characters. */
  version: string;
  /** `--help` advertises `-p/--print` with a structured `--output-format`. */
  supportsHeadless: boolean;
  /** `--help` advertises `stream-json` output. */
  supportsStreamJson: boolean;
  /** `--help` advertises `--resume`. */
  supportsResume: boolean;
  /** `--help` advertises `--input-format` (needed for oversized prompts). */
  supportsStdinPrompt: boolean;
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 262_144;
const MAX_PROMPT_ARGV_CHARS = 30_000;
const SCRIPT_EXTENSIONS = new Set([".cjs", ".mjs", ".js"]);

export { MAX_PROMPT_ARGV_CHARS };

interface ProbeRunner {
  (spec: ZcodeCommandSpec, args: readonly string[]): Promise<string>;
}

const defaultProbeRunner: ProbeRunner = (spec, args) => new Promise((resolve, reject) => {
  execFile(spec.command, [...spec.baseArgs, ...args], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_OUTPUT_BYTES,
    windowsHide: true,
  }).then(
    ({ stdout }) => resolve(stdout),
    (error: NodeJS.ErrnoException & { stdout?: string; killed?: boolean }) => {
      if (typeof error.stdout === "string" && error.stdout.trim()) {
        resolve(error.stdout);
        return;
      }
      reject(new Error(
        error.killed
          ? `ZCode CLI probe timed out (${spec.source})`
          : `ZCode CLI probe failed (${spec.source}): ${error.code ?? error.message}`,
        { cause: error },
      ));
    },
  );
});

/**
 * Resolves the ZCode CLI without a shell. An explicit option wins; it may be a
 * directory-qualified executable or a `.cjs`/`.mjs`/`.js` entry (run through
 * Node, mirroring the desktop bundle layout). Otherwise the connector looks
 * for `zcode` on PATH and then in the documented desktop install locations.
 * A missing CLI is an actionable refusal, never a silent fallback.
 */
export async function resolveZcodeCommand(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ZcodeCommandSpec> {
  const trimmed = option?.trim();
  if (trimmed) {
    return specForEntry(trimmed, "--zcode-command option");
  }
  const pathSpec = await fromPath("zcode", env, platform);
  if (pathSpec) return pathSpec;
  const bundled = await fromDesktopInstall(env, platform);
  if (bundled) return bundled;
  throw new Error(
    "Could not locate the ZCode CLI. Install ZCode, expose `zcode` on PATH, or pass --zcode-command <path> (a directory-qualified executable or the bundled glm/zcode.cjs entry).",
  );
}

async function specForEntry(entry: string, source: string): Promise<ZcodeCommandSpec> {
  const resolved = path.resolve(entry);
  await accessEntry(resolved, source);
  const extension = path.extname(resolved).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return { command: process.execPath, baseArgs: [resolved], source };
  }
  return { command: resolved, baseArgs: [], source };
}

async function accessEntry(resolved: string, source: string): Promise<void> {
  try {
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new Error(`${source} must point to a file`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must point to a file")) throw error;
    throw new Error(`${source} does not exist: ${resolved}`, { cause: error });
  }
}

async function fromPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<ZcodeCommandSpec | undefined> {
  const accessMode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  const executableNames = platform === "win32"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      try {
        await access(candidate, accessMode);
        return { command: candidate, baseArgs: [], source: `PATH (${directory})` };
      } catch {
        // Continue to the next candidate.
      }
    }
  }
  return undefined;
}

async function fromDesktopInstall(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<ZcodeCommandSpec | undefined> {
  const candidates: string[] = [];
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
      );
    }
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    );
  } else if (platform === "linux") {
    candidates.push(
      path.join(env.HOME ?? "", ".local", "share", "ZCode", "resources", "glm", "zcode.cjs"),
    );
  }
  for (const candidate of candidates.filter((entry) => entry.trim())) {
    try {
      await access(candidate, fsConstants.F_OK);
      return {
        command: process.execPath,
        baseArgs: [candidate],
        source: `desktop bundle (${candidate})`,
      };
    } catch {
      // Try the next documented install location.
    }
  }
  return undefined;
}

/**
 * Structurally probes the resolved CLI. A missing capability refuses at
 * preflight with an actionable message instead of failing mid-turn.
 */
export async function probeZcodeCli(
  spec: ZcodeCommandSpec,
  runner: ProbeRunner = defaultProbeRunner,
): Promise<ZcodeCliProbe> {
  const [versionOutput, helpOutput] = await Promise.all([
    runner(spec, ["--version"]),
    runner(spec, ["--help"]),
  ]);
  const version = firstLine(versionOutput).slice(0, 80);
  if (!version) throw new Error("ZCode CLI --version produced no usable output");
  const probe: ZcodeCliProbe = {
    version,
    supportsHeadless: helpOutput.includes("--print") || helpOutput.includes("-p,"),
    supportsStreamJson: helpOutput.includes("stream-json"),
    supportsResume: helpOutput.includes("--resume"),
    supportsStdinPrompt: helpOutput.includes("--input-format"),
  };
  return probe;
}

export function assertUsableZcodeCli(probe: ZcodeCliProbe): void {
  const missing: string[] = [];
  if (!probe.supportsHeadless) missing.push("headless print mode (-p/--print)");
  if (!probe.supportsStreamJson) missing.push("structured stream-json output (--output-format stream-json)");
  if (!probe.supportsResume) missing.push("native session resume (--resume)");
  if (missing.length > 0) {
    throw new Error(
      `The resolved ZCode CLI (${probe.version}) is missing required headless capabilities: ${missing.join(", ")}. Upgrade ZCode or point --zcode-command at a compatible build.`,
    );
  }
}

/** Headless output is line-delimited JSON; oversize prompts must go through stdin. */
export function promptFitsArgv(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") <= MAX_PROMPT_ARGV_CHARS;
}

export function zcodeHeadlessArgs(options: {
  probe: ZcodeCliProbe;
  prompt: string;
  resumeSessionId?: string;
}): { args: string[]; stdinPrompt: string | undefined } {
  if (options.prompt.length === 0) throw new Error("ZCode execution prompt must not be empty");
  const args = ["-p"];
  if (options.resumeSessionId) {
    if (!options.probe.supportsResume) {
      throw new Error("ZCode session continuation requires a CLI with --resume support");
    }
    args.push("--resume", options.resumeSessionId);
  }
  if (promptFitsArgv(options.prompt)) {
    return { args: [...args, "--output-format", "stream-json", options.prompt], stdinPrompt: undefined };
  }
  if (!options.probe.supportsStdinPrompt) {
    throw new Error(
      "The GatherThread session history exceeds the ZCode CLI argument budget and the resolved CLI does not advertise --input-format for stdin prompts. Shorten the shared session history or upgrade ZCode.",
    );
  }
  return {
    args: [...args, "--output-format", "stream-json", "--input-format", "text"],
    stdinPrompt: options.prompt,
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
