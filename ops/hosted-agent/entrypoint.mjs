import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const INPUT = "/input";
const WORKSPACE = "/workspace";
const MAX_FILES = 100;
const MAX_BYTES = 512_000;

function walk(root, prefix = "", budget = { entries: 0 }, depth = 0) {
  if (depth > 16) throw new Error("workspace_depth");
  const entries = [];
  for (const name of readdirSync(join(root, prefix))) {
    budget.entries += 1;
    if (budget.entries > 500) throw new Error("workspace_entries");
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("unsafe_file");
    if (stat.isDirectory()) entries.push(...walk(root, relative, budget, depth + 1));
    else entries.push({ path: relative, absolute: path, size: stat.size, executable: Boolean(stat.mode & 0o111) });
  }
  return entries;
}

function initialFiles() {
  for (const file of walk(INPUT)) {
    const destination = join(WORKSPACE, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.absolute, destination);
    chmodSync(destination, file.executable ? 0o700 : 0o600);
  }
}

function outputFiles() {
  const entries = walk(WORKSPACE);
  if (entries.length > MAX_FILES || entries.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) {
    throw new Error("workspace_limit");
  }
  return entries.map((file) => ({
    path: file.path,
    content_base64: readFileSync(file.absolute).toString("base64"),
    executable: file.executable,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function run(program, args, stdoutLimit) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: WORKSPACE, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > stdoutLimit) child.kill("SIGKILL");
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => { size += chunk.length; if (size > stdoutLimit) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 && size <= stdoutLimit
      ? resolve(output) : reject(new Error("agent_failed")));
  });
}

async function main() {
  initialFiles();
  const bridge = spawn("socat", [
    "TCP-LISTEN:8787,bind=127.0.0.1,fork,reuseaddr", "UNIX-CONNECT:/run/model.sock",
  ], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answer = await run("opencode", [
      "run", "--model", "hosted/@cf/qwen/qwen3-30b-a3b-fp8", "--agent", "build",
      "--file", "/run/gatherthread/prompt.txt", "Complete the attached task in this workspace.",
    ], 64_000);
    let files = null;
    let save_error = null;
    try { files = outputFiles(); } catch { save_error = "workspace_limit_or_unsafe_file"; }
    process.stdout.write(JSON.stringify({ answer, files, save_error }));
  } finally {
    bridge.kill("SIGTERM");
  }
}

main().catch(() => { process.exitCode = 1; });
