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

const HELP = `Usage:
  npm start
  npm run owner-host:init
  node apps/server/dist/src/cli.js registration pause|resume|status|cleanup

Commands:
  start       Start the loopback-only host (default)
  registration pause|resume|status|cleanup  Local registration circuit breaker and retention
  hosted-agent:set-user-limit  Set a user's Cloud Agent daily run allowance locally

User accounts register with verified email and sign in with their password.
owner-host:init prepares private configuration only; it creates no account or login token.
Configuration is read from NODE_ENV and GATHERTHREAD_* in .env.example.
`;

function databaseOptions(config: ServerConfig): { authTokenPepper?: string } {
  return config.authTokenPepper ? { authTokenPepper: config.authTokenPepper } : {};
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

async function start(config: ServerConfig): Promise<void> {
  assertPersistentCredentialPepper(config);
  prepareDatabaseDirectory(config);
  assertStaticDirectory(config);
  const running = await startCollaborationServer({
    registration: config.registration,
    databasePath: config.databasePath,
    allowedOrigins: config.allowedOrigins,
    ...(config.authTokenPepper ? { authTokenPepper: config.authTokenPepper } : {}),
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
    ...(config.hostedAgent ? { hostedAgent: config.hostedAgent } : {}),
    ...(config.hostedGithub ? { hostedGithub: config.hostedGithub } : {}),
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
  if (command === "hosted-agent:set-user-limit") {
    if (args.length !== 4 || args[0] !== "--user-id" || !["--runs", "--neurons"].includes(args[2]!)
      || !/^(0|[1-9][0-9]*)$/u.test(args[3] ?? "")) {
      throw new ConfigurationError("Usage: hosted-agent:set-user-limit --user-id ID --runs 0..10000");
    }
    withOperatorDatabase(config, (database) => database.setHostedAgentUserLimit(args[1]!, args[2] === "--neurons" ? Math.floor(Number(args[3]) / 2000) : Number(args[3])));
    process.stdout.write("Cloud Agent user limit updated.\n");
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
