import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicAnswer } from "./public-answer.mjs";
import { prepareNpm } from "./npm-setup.mjs";

const INPUT = "/input";
const WORKSPACE = "/workspace";
const repository = process.env.GT_HOSTED_REPOSITORY === "1";
const MAX_FILES = repository ? 1000 : 100;
const MAX_BYTES = repository ? 8 * 1024 * 1024 : 512_000;
const excluded = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".turbo", ".npmrc"]);

function walk(root, prefix = "", budget = { entries: 0 }, depth = 0) {
  if (depth > 16) throw new Error("workspace_depth");
  const entries = [];
  for (const name of readdirSync(join(root, prefix))) {
    if (repository && excluded.has(name)) continue;
    budget.entries += 1;
    if (budget.entries > (repository ? 5000 : 500)) throw new Error("workspace_entries");
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
    let errorOutput = "";
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > stdoutLimit) child.kill("SIGKILL");
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (process.env.GT_HOSTED_SMOKE_DEBUG === "1") errorOutput += chunk.toString("utf8").slice(0, 4_000);
      if (size > stdoutLimit) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 && size <= stdoutLimit
      ? resolve(output) : reject(new Error(process.env.GT_HOSTED_SMOKE_DEBUG === "1"
        ? `agent_failed_${code}: ${errorOutput.slice(-4_000)} ${output.slice(-4_000)}` : "agent_failed")));
  });
}

async function main() {
  initialFiles();
  const bridge = spawn("socat", [
    "TCP-LISTEN:8787,bind=127.0.0.1,fork,reuseaddr", "UNIX-CONNECT:/run/model.sock",
  ], { stdio: "ignore" });
  const npmBridge = repository ? spawn("socat", [
    "TCP-LISTEN:8788,bind=127.0.0.1,fork,reuseaddr", "UNIX-CONNECT:/run/npm.sock",
  ], { stdio: "ignore" }) : null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (repository) {
      await prepareNpm(WORKSPACE, run);
      await run("git", ["init", "--quiet"], 64000);
      mkdirSync(join(WORKSPACE, ".git", "info"), { recursive: true });
      writeFileSync(join(WORKSPACE, ".git", "info", "exclude"), "node_modules/\ndist/\ncoverage/\n.next/\n.turbo/\n");
      await run("git", ["add", "."], 64000);
      await run("git", ["-c", "user.name=GatherThread", "-c", "user.email=cloud@localhost",
        "commit", "--quiet", "-m", "Cloud task starting snapshot"], 64000);
    }
    const output = await run("opencode", [
      "run", "--format", "json", "--agent", "build",
      "Complete the attached task in this workspace.", "--file", "/run/gatherthread/prompt.txt",
    ], repository ? 1024 * 1024 : 64_000);
    const answer = publicAnswer(output);
    let files = null;
    let save_error = null;
    try { files = outputFiles(); } catch { save_error = "workspace_limit_or_unsafe_file"; }
    process.stdout.write(JSON.stringify({ answer, files, save_error }));
  } finally {
    bridge.kill("SIGTERM");
    npmBridge?.kill("SIGTERM");
  }
}

main().catch((error) => {
  if (process.env.GT_HOSTED_SMOKE_DEBUG === "1") process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
