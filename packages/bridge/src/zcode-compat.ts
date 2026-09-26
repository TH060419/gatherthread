import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withoutGatherThreadCredentialEnvironment } from "./zcode-protocol.js";

const execFile = promisify(execFileCallback);

/**
 * Every ZCode-version-sensitive interaction lives in this module (plus the
 * protocol client in `zcode-protocol.ts`). The upstream ZCode CLI is an
 * Electron-bundled executable whose headless surface changes between builds.
 * Nothing outside these modules guesses at CLI paths, subcommands, or output
 * shapes: the connector resolves one command spec, probes its capabilities
 * structurally and through a live protocol handshake, and refuses to run when
 * a required capability is missing. This mirrors the fail-closed compatibility
 * boundary the repository applies to Codex App Server and DSH Host versions.
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
  /** `--help` advertises the `app-server` stdio protocol subcommand. */
  supportsAppServer: boolean;
  /** `--help` advertises `-p, --prompt` single-prompt mode (informational). */
  supportsPromptMode: boolean;
  /** `--help` advertises `--resume` (informational; resume uses the protocol). */
  supportsResume: boolean;
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 262_144;
const SCRIPT_EXTENSIONS = new Set([".cjs", ".mjs", ".js"]);
// Node spawns with shell:false and refuses .bat/.cmd shims outright (since
// CVE-2024-27980), so an accepted shim would only fail later with an opaque
// EINVAL. A PowerShell script is equally unspawnable as a direct executable.
const SCRIPT_SHIM_EXTENSIONS = new Set([".bat", ".cmd", ".ps1"]);

interface ProbeRunner {
  (spec: ZcodeCommandSpec, args: readonly string[]): Promise<string>;
}

const defaultProbeRunner: ProbeRunner = (spec, args) => new Promise((resolve, reject) => {
  execFile(spec.command, [...spec.baseArgs, ...args], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_OUTPUT_BYTES,
    windowsHide: true,
    // Probe children are model-adjacent processes too: they must never see
    // GatherThread credentials, exactly like the app-server execution child.
    env: withoutGatherThreadCredentialEnvironment(process.env),
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
 * Node, mirroring the desktop bundle layout), while `.bat`/`.cmd`/`.ps1`
 * script shims are refused with an actionable error. Otherwise the connector
 * looks for `zcode` on PATH and then in the documented desktop install
 * locations. A missing CLI is an actionable refusal, never a silent fallback.
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
  if (SCRIPT_SHIM_EXTENSIONS.has(extension)) {
    throw new Error(
      `${source} points at a ${extension} script shim (${resolved}); the connector spawns without a shell, so pass the real ZCode .exe or the bundled glm/zcode.cjs entry instead`,
    );
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
  // Windows: accept only real executables. Node spawns with shell:false, and
  // since CVE-2024-27980 it refuses .bat/.cmd shims outright, so a .cmd shim
  // found on PATH would fail later with an opaque EINVAL; the desktop-bundle
  // and --zcode-command paths remain the supported Windows alternatives.
  const executableNames = platform === "win32"
    ? [`${command}.exe`]
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
  return {
    version,
    // Anchored to a line start so prose mentions of "app-server" inside
    // option descriptions cannot satisfy the capability check.
    supportsAppServer: /(?:^|\r?\n)[ \t]*app-server(?:\s|$)/.test(helpOutput),
    supportsPromptMode: helpOutput.includes("--prompt") || helpOutput.includes("-p,"),
    supportsResume: helpOutput.includes("--resume"),
  };
}

export function assertUsableZcodeCli(probe: ZcodeCliProbe): void {
  const missing: string[] = [];
  if (!probe.supportsAppServer) missing.push("the ZCode Protocol app-server (`zcode app-server`)");
  if (missing.length > 0) {
    throw new Error(
      `The resolved ZCode CLI (${probe.version}) is missing required headless capabilities: ${missing.join(", ")}. Upgrade ZCode or point --zcode-command at a compatible build.`,
    );
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
