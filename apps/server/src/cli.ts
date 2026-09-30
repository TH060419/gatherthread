import { CollaborationDatabase } from "./database.js";
import {
  assertPersistentCredentialPepper,
  assertStaticDirectory,
  ConfigurationError,
  loadServerConfig,
  prepareDatabaseDirectory,
  type ServerConfig,
} from "./config.js";
import { startCollaborationServer } from "./server.js";

interface BootstrapArguments {
  userId?: string;
  displayName: string;
  deviceId?: string;
  deviceName: string;
}

const HELP = `Usage:
  npm start [-- start]
  npm run owner-host:init -- --display-name NAME --device-name NAME [--user-id ID] [--device-id ID]
  npm run owner-host:issue-test-access -- [--ttl 1h|24h|7d] [--count 1..50] [--format json|share]
  npm run owner-host:revoke-test-access -- --grant-id ID

Commands:
  start       Start the loopback-only owner host (default)
  bootstrap   Create the first owner directly in SQLite and print its credential once
  init        Alias for bootstrap
  issue-test-access  Issue up to 50 single-use test qualifications locally (JSON by default)
  registration pause|resume|status|cleanup  Local registration circuit breaker and retention
  revoke-test-access Revoke an unclaimed test qualification token locally

Configuration is read from NODE_ENV and the GATHERTHREAD_* variables documented in .env.example.
`;

function requireOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new ConfigurationError(`${name} is required`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new ConfigurationError(`${name} requires a value`);
  return value;
}

function parseBootstrapArguments(args: string[]): BootstrapArguments {
  const known = new Set(["--user-id", "--display-name", "--device-id", "--device-name"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!option || !known.has(option)) throw new ConfigurationError(`Unknown bootstrap option: ${option ?? ""}`);
    if (args[index + 1] === undefined) throw new ConfigurationError(`${option} requires a value`);
    if (seen.has(option)) throw new ConfigurationError(`${option} may be provided only once`);
    seen.add(option);
  }
  const userId = optionalOption(args, "--user-id");
  const deviceId = optionalOption(args, "--device-id");
  return {
    ...(userId ? { userId } : {}),
    displayName: requireOption(args, "--display-name"),
    ...(deviceId ? { deviceId } : {}),
    deviceName: requireOption(args, "--device-name"),
  };
}

function databaseOptions(config: ServerConfig): { authTokenPepper?: string } {
  return config.authTokenPepper ? { authTokenPepper: config.authTokenPepper } : {};
}

function bootstrap(config: ServerConfig, args: string[]): void {
  const input = parseBootstrapArguments(args);
  assertPersistentCredentialPepper(config);
  prepareDatabaseDirectory(config);
  const database = new CollaborationDatabase(config.databasePath, databaseOptions(config));
  try {
    const identity = database.bootstrapIdentity({
      ...(input.userId ? { user_id: input.userId } : {}),
      display_name: input.displayName,
      ...(input.deviceId ? { device_id: input.deviceId } : {}),
      device_name: input.deviceName,
    });
    process.stderr.write("Owner created. Store the access token now; it will not be shown again.\n");
    process.stdout.write(`${JSON.stringify({
      user_id: identity.actor.user_id,
      device_id: identity.actor.device_id,
      access_token: identity.token,
    }, null, 2)}\n`);
  } finally {
    database.close();
  }
}

function withOperatorDatabase(config: ServerConfig, operation: (database: CollaborationDatabase) => void): void {
  assertPersistentCredentialPepper(config);
  prepareDatabaseDirectory(config);
  const database = new CollaborationDatabase(config.databasePath, databaseOptions(config));
  try {
    operation(database);
  } finally {
    database.close();
  }
}

function issueTestAccess(config: ServerConfig, args: string[]): void {
  let ttl: "1h" | "24h" | "7d" = "7d";
  let count = 1;
  let format: "json" | "share" = "json";
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !new Set(["--ttl", "--count", "--format"]).has(option) || seen.has(option) || !value || value.startsWith("--")) {
      throw new ConfigurationError("Usage: issue-test-access [--ttl 1h|24h|7d] [--count 1..50] [--format json|share]");
    }
    seen.add(option);
    if (option === "--ttl") {
      if (value !== "1h" && value !== "24h" && value !== "7d") throw new ConfigurationError("--ttl must be 1h, 24h, or 7d");
      ttl = value;
    } else if (option === "--count") {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 50) {
        throw new ConfigurationError("--count must be an integer from 1 to 50");
      }
      count = Number(value);
    } else {
      if (value !== "json" && value !== "share") throw new ConfigurationError("--format must be json or share");
      format = value;
    }
  }
  withOperatorDatabase(config, (database) => {
    const grants = database.issueTestAccessBatch(ttl, count);
    process.stdout.write(format === "json"
      ? `${JSON.stringify(count === 1 ? grants[0] : grants, null, 2)}\n`
      : `${grants.map((grant) => [
        `测试资格码：${grant.access_token}`,
        "初次登录请使用上述资格码激活账号。激活后会获得仅显示一次的设备访问令牌，请妥善保存；以后可用该令牌登录，也可勾选「记住此设备」快捷登录。",
        `有效期：${formatBeijingDateTime(grant.created_at)} 至 ${formatBeijingDateTime(grant.expires_at)}（北京时间）`,
      ].join("\n")).join("\n\n")}\n`);
    process.stderr.write(`${count} single-use test access code(s) issued. Send each privately; they will not be shown again.\n`);
    for (const [index, grant] of grants.entries()) {
      process.stderr.write(`Revoke ID ${index + 1}/${count}: ${grant.grant_id}\n`);
    }
  });
}

function formatBeijingDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function revokeTestAccess(config: ServerConfig, args: string[]): void {
  if (args.length !== 2 || args[0] !== "--grant-id" || !args[1]) {
    throw new ConfigurationError("Usage: revoke-test-access --grant-id ID");
  }
  withOperatorDatabase(config, (database) => database.revokeTestAccess(args[1]!));
  process.stdout.write("Unclaimed test access revoked.\n");
}

async function start(config: ServerConfig): Promise<void> {
  assertPersistentCredentialPepper(config);
  prepareDatabaseDirectory(config);
  assertStaticDirectory(config);
  const running = await startCollaborationServer({
    registration: config.registration,
    databasePath: config.databasePath,
    allowedOrigins: config.allowedOrigins,
    ...(config.authTokenPepper ? { authTokenPepper: config.authTokenPepper } : {}),
    allowHttpBootstrap: config.allowHttpBootstrap,
    staticDirectory: config.staticDirectory,
    publicBaseUrl: config.publicBaseUrl,
    secureTransport: config.secureTransport,
    maxUserEventBytes: config.maxUserEventBytes,
    maxSessionEventBytes: config.maxSessionEventBytes,
    maxTotalEventBytes: config.maxTotalEventBytes,
    maxEventBytes: config.maxEventBytes,
    maxUserSessions: config.maxUserSessions,
    maxProjectSessions: config.maxProjectSessions,
    maxTotalSessions: config.maxTotalSessions,
  }, config.port, config.host);
  process.stdout.write(`GatherThread owner host listening at ${running.origin}\n`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await running.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const config = loadServerConfig();
  if (command === "bootstrap" || command === "init") {
    bootstrap(config, args);
    return;
  }
  if (command === "issue-test-access") {
    issueTestAccess(config, args);
    return;
  }
  if (command === "revoke-test-access") {
    revokeTestAccess(config, args);
    return;
  }
  if (command === "registration") {
    const action = args[0];
    if (args.length !== 1 || !["pause", "resume", "status", "cleanup"].includes(action ?? "")) throw new ConfigurationError("Usage: registration pause|resume|status|cleanup");
    withOperatorDatabase(config, (database) => {
      if (action === "pause" || action === "resume") database.registration.pause(action === "pause");
      if (action === "cleanup") database.registration.cleanup();
      process.stdout.write(`${JSON.stringify({ enabled: database.registration.ready(config.registration), paused: database.registration.paused() })}\n`);
    });
    return;
  }
  if (command !== "start" || args.length > 0) throw new ConfigurationError(`Unknown command: ${[command, ...args].join(" ")}`);
  await start(config);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Startup failed: ${message}\n`);
  process.exitCode = 1;
});
