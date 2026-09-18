/**
 * Opt-in DeepSeek Harness host integration.
 *
 * The package is inert unless its Cordis host plugin is explicitly added to a
 * DSH profile. It deliberately does not register with GatherThread's existing
 * Codex/Claude bridge runner.
 */
export const DSH_HARNESS_NAME = "deepseek-harness" as const;

export * from "./canonical-prompt.js";
export * from "./client-slot.js";
export * from "./collaboration-api.js";
export * from "./config.js";
export * from "./connection-install.js";
export * from "./status.js";
export * from "./connector.js";
export * from "./dsh-compat.js";
export * from "./event-mapper.js";
export * from "./execution-gate.js";
export * from "./native-connection.js";
export * from "./native-plugin.js";
export * from "./path-security.js";
export * from "./project-manager.js";
export * from "./session-title.js";
export * from "./state-store.js";
export * from "./types.js";
