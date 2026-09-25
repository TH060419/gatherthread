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
  npm run owner-host:issue-test-access -- [--ttl 1h|24h|7d]
  npm run owner-host:revoke-test-access -- --grant-id ID

Commands:
  start       Start the loopback-only owner host (default)
  bootstrap   Create the first owner directly in SQLite and print its credential once
  init        Alias for bootstrap
  issue-test-access  Issue one single-use test qualification token locally
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
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--ttl")) {
    throw new ConfigurationError("Usage: issue-test-access [--ttl 1h|24h|7d]");
  }
  const ttl = args.length === 2 ? args[1] : "7d";
  if (ttl !== "1h" && ttl !== "24h" && ttl !== "7d") {
    throw new ConfigurationError("--ttl must be 1h, 24h, or 7d");
  }
  withOperatorDatabase(config, (database) => {
    const grant = database.issueTestAccess(ttl);
    process.stderr.write("Single-use test access issued. Send it privately; it will not be shown again.\n");
    process.stdout.write(`${JSON.stringify(grant, null, 2)}\n`);
  });
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
  if (command !== "start" || args.length > 0) throw new ConfigurationError(`Unknown command: ${[command, ...args].join(" ")}`);
  await start(config);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Startup failed: ${message}\n`);
  process.exitCode = 1;
});
