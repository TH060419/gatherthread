#!/usr/bin/env node
import { runZcodeConnectCli } from "./index.js";

await runZcodeConnectCli().catch((error: unknown) => {
  process.stderr.write(`gatherthread-zcode-connect: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
