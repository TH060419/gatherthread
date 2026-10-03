import { closeSync, fchmodSync, openSync, writeFileSync } from "node:fs";
import { loadServerConfig } from "./config.js";
import { TestGateStore } from "./test-gate.js";

/** Deliberately separate from retired account-qualification commands. */
export function runTestGateCli(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const config = loadServerConfig(env);
  if (!config.testGate) throw new Error("Test admission administration requires the isolated test configuration");
  const [command, ...rest] = args;
  const known = command === "issue" ? ["--count", "--hours", "--output"] : command === "revoke" ? ["--grant-id"] : [];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1];
    if (!name || !known.includes(name) || values.has(name) || !value || value.startsWith("--")) throw new Error("Invalid admission command options");
    values.set(name, value);
  }
  if (!["issue", "revoke", "list"].includes(command ?? "")) throw new Error("Usage: test-gate issue --output PRIVATE_FILE [--count 1..50] [--hours 1..720] | revoke --grant-id ID | list");
  if (command === "revoke" && !values.has("--grant-id")) throw new Error("--grant-id is required");
  if (command === "issue" && !values.has("--output")) throw new Error("--output is required; codes are never printed to logs");
  const count = Number(values.get("--count") ?? "1"), hours = Number(values.get("--hours") ?? "168");
  if (command === "issue" && (!Number.isInteger(count) || count < 1 || count > 50 || !Number.isInteger(hours) || hours < 1 || hours > 720)) throw new Error("Use count 1..50 and hours 1..720");
  const store = new TestGateStore(config.testGate);
  try {
    if (command === "revoke") { store.revoke(values.get("--grant-id")!); process.stdout.write("测试人员代码已撤销，其门禁会话也失效。\n"); }
    if (command === "list") process.stdout.write(`${JSON.stringify(store.list(), null, 2)}\n`);
    if (command === "issue") {
      // O_EXCL refuses replacement, links, and accidentally reused distribution files.
      const fd = openSync(values.get("--output")!, "wx", 0o600);
      try {
        fchmodSync(fd, 0o600);
        const grants = store.issue(count, hours);
        try {
          writeFileSync(fd, grants.map(grant => [
            `测试环境：${config.testGate!.origin}`,
            `测试人员代码：${grant.admission_code}`,
            `撤销编号：${grant.grant_id}`,
            `有效期至：${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(grant.expires_at))}（北京时间）`,
            "请打开测试站输入代码，再注册自己的邮箱账号和密码。测试账号与正式账号独立。代码只供本人进入测试环境，请勿发到公开聊天、链接、截图或工单。",
          ].join("\n")).join("\n\n") + "\n");
        } catch (error) { for (const grant of grants) store.revoke(grant.grant_id); throw error; }
        process.stdout.write(`已写入 ${count} 份私密发放说明。请逐人私下分发；代码不在终端显示。\n`);
      } finally { closeSync(fd); }
    }
  } finally { store.close(); }
}

try { runTestGateCli(process.argv.slice(2)); }
catch { process.stderr.write("测试门禁命令失败。检查独立测试配置、命令参数、私密目录和新输出文件。\n"); process.exitCode = 1; }
