#!/usr/local/bin/node
import { checkHostedResources } from "./resource-check.mjs";

let verified = false;
try {
  // No input preparation, process spawn or harness import before actual controls pass.
  checkHostedResources();
  verified = true;
} catch {
  process.stderr.write("hosted_resource_controls_unavailable\n");
  process.exitCode = 1;
}

// Harness/import failures retain their original handling rather than becoming a resource refusal.
if (verified) await import("./gatherthread-hosted-entrypoint.mjs");
