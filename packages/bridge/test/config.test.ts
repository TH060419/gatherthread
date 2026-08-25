import assert from "node:assert/strict";
import test from "node:test";
import {
  loadBridgeDaemonConfig,
  loadRelayroomConnectionConfig,
} from "../src/index.js";

test("bridge daemon config validates a complete environment without exposing the token in arguments", () => {
  const config = loadBridgeDaemonConfig(validEnvironment());
  assert.equal(config.connection.apiUrl, "https://relay.example/v1");
  assert.equal(config.runtime.sessionId, "session-1");
  assert.equal(config.runtime.captureFidelity, "harness_transcript");
  assert.deepEqual(config.adapter.args, ["--mode", "json"]);
});

test("connection config rejects insecure remote URLs and embedded URL credentials", () => {
  assert.throws(() => loadRelayroomConnectionConfig({
    RELAYROOM_API_URL: "http://relay.example/v1",
    RELAYROOM_TOKEN: "secret-token",
  }), /must use HTTPS/);
  assert.throws(() => loadRelayroomConnectionConfig({
    RELAYROOM_API_URL: "https://user:password@relay.example/v1",
    RELAYROOM_TOKEN: "secret-token",
  }), /cannot contain credentials/);
  assert.equal(loadRelayroomConnectionConfig({
    RELAYROOM_API_URL: "http://127.0.0.1:8787/v1/",
    RELAYROOM_TOKEN: "secret-token",
  }).apiUrl, "http://127.0.0.1:8787/v1");
});

test("bridge config rejects Relayroom credentials embedded in adapter arguments", () => {
  const env = validEnvironment();
  env.RELAYROOM_ADAPTER_ARGS_JSON = JSON.stringify(["--token=top-secret-token"]);
  assert.throws(() => loadBridgeDaemonConfig(env), /must not be included in adapter arguments/);
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    RELAYROOM_API_URL: "https://relay.example/v1/",
    RELAYROOM_TOKEN: "top-secret-token",
    RELAYROOM_SESSION_ID: "session-1",
    RELAYROOM_DEVICE_ID: "device-1",
    RELAYROOM_HARNESS: "codex",
    RELAYROOM_PROVIDER: "openai",
    RELAYROOM_MODEL: "gpt-5",
    RELAYROOM_LOCAL_SESSION_ID: "local-1",
    RELAYROOM_ADAPTER_COMMAND: "/opt/relayroom/adapter",
    RELAYROOM_ADAPTER_ARGS_JSON: "[\"--mode\",\"json\"]",
  };
}
