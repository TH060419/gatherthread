import assert from "node:assert/strict";
import test from "node:test";
import {
  loadBridgeDaemonConfig,
  loadGatherThreadConnectionConfig,
} from "../src/index.js";

test("bridge daemon config validates a complete environment without exposing the token in arguments", () => {
  const config = loadBridgeDaemonConfig(validEnvironment());
  assert.equal(config.connection.apiUrl, "https://gatherthread.example/v1");
  assert.equal(config.runtime.sessionId, "session-1");
  assert.equal(config.runtime.captureFidelity, "harness_transcript");
  assert.deepEqual(config.adapter.args, ["--mode", "json"]);
});

test("connection config rejects insecure remote URLs and embedded URL credentials", () => {
  assert.throws(() => loadGatherThreadConnectionConfig({
    GATHERTHREAD_API_URL: "http://gatherthread.example/v1",
    GATHERTHREAD_TOKEN: "secret-token",
  }), /must use HTTPS/);
  assert.throws(() => loadGatherThreadConnectionConfig({
    GATHERTHREAD_API_URL: "https://user:password@gatherthread.example/v1",
    GATHERTHREAD_TOKEN: "secret-token",
  }), /cannot contain credentials/);
  assert.equal(loadGatherThreadConnectionConfig({
    GATHERTHREAD_API_URL: "http://127.0.0.1:8787/v1/",
    GATHERTHREAD_TOKEN: "secret-token",
  }).apiUrl, "http://127.0.0.1:8787/v1");
});

test("bridge config rejects GatherThread credentials embedded in adapter arguments", () => {
  const env = validEnvironment();
  env.GATHERTHREAD_ADAPTER_ARGS_JSON = JSON.stringify(["--token=top-secret-token"]);
  assert.throws(() => loadBridgeDaemonConfig(env), /must not be included in adapter arguments/);
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    GATHERTHREAD_API_URL: "https://gatherthread.example/v1/",
    GATHERTHREAD_TOKEN: "top-secret-token",
    GATHERTHREAD_SESSION_ID: "session-1",
    GATHERTHREAD_DEVICE_ID: "device-1",
    GATHERTHREAD_HARNESS: "codex",
    GATHERTHREAD_PROVIDER: "openai",
    GATHERTHREAD_MODEL: "gpt-5",
    GATHERTHREAD_LOCAL_SESSION_ID: "local-1",
    GATHERTHREAD_ADAPTER_COMMAND: "/opt/gatherthread/adapter",
    GATHERTHREAD_ADAPTER_ARGS_JSON: "[\"--mode\",\"json\"]",
  };
}
