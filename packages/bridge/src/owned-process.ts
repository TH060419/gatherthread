import { spawn, type ChildProcess } from "node:child_process";

/** Signal only a process group created by this connector, never an ambient group. */
export async function stopOwnedProcess(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    return;
  }
  // Windows fallback is best-effort ordinary execution only. Without a Job
  // Object, descendants cannot be verified after their parent has already exited.
  await new Promise<void>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ["systemroot", "windir", "path", "pathext", "temp", "tmp"].includes(name.toLowerCase())));
    const cleanup = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true, env });
    cleanup.once("error", reject);
    cleanup.once("close", (code) => code === 0 ? resolve() : reject(new Error("Native process tree stop was not confirmed")));
  }).catch(() => { child.kill(signal); });
}

export async function terminateOwnedProcessGroup(groupId: number): Promise<void> {
  if (!Number.isSafeInteger(groupId) || groupId < 1 || groupId === process.pid) throw new Error("Invalid isolated native process group");
  const alive = () => {
    try { process.kill(-groupId, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw new Error("Shared native process cleanup could not be verified"); }
  };
  if (!alive()) return;
  try { process.kill(-groupId, "SIGTERM"); } catch { if (!alive()) return; }
  const forceAt = Date.now() + 5000, finishAt = forceAt + 2000;
  let forced = false;
  while (alive()) {
    if (!forced && Date.now() >= forceAt) { process.kill(-groupId, "SIGKILL"); forced = true; }
    if (Date.now() >= finishAt) throw new Error("Shared native process cleanup could not be confirmed");
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
