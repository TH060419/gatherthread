import assert from "node:assert/strict";
import test from "node:test";
import { mcpTransportEnv, toolProfileEnv } from "../src/cli.js";

test("user MCP defaults to the credential-free local connector transport", () => {
  const env = {};
  const profile = toolProfileEnv(env);
  assert.equal(profile, "user");
  assert.equal(mcpTransportEnv(env, profile), "connector");
});

test("runtime MCP defaults to explicit server environment transport", () => {
  const env = { GATHERTHREAD_MCP_TOOL_PROFILE: "runtime" };
  const profile = toolProfileEnv(env);
  assert.equal(profile, "runtime");
  assert.equal(mcpTransportEnv(env, profile), "server-env");
  assert.throws(
    () => mcpTransportEnv({ GATHERTHREAD_MCP_TRANSPORT: "connector" }, profile),
    /requires the server-env transport/,
  );
});

test("MCP profile and transport parsing fail closed", () => {
  assert.throws(() => toolProfileEnv({ GATHERTHREAD_MCP_TOOL_PROFILE: "all" }), /user or runtime/);
  assert.throws(
    () => mcpTransportEnv({ GATHERTHREAD_MCP_TRANSPORT: "remote-oauth" }, "user"),
    /connector or server-env/,
  );
});
