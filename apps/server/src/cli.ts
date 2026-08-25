import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startCollaborationServer } from "./server.js";

const databasePath = resolve(process.env.ACP_DATABASE_PATH ?? "./data/collaboration.sqlite");
const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";

mkdirSync(dirname(databasePath), { recursive: true });
const running = await startCollaborationServer({ databasePath }, port, host);
console.log(`Agent Cooperation server listening at ${running.origin}`);

async function shutdown(): Promise<void> {
  await running.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
