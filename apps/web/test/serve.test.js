import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createWebServer, isProxyPath, loadWebServerConfig } from "../scripts/serve.mjs";

test("Web preview binds to loopback and proxies only owner-host API paths", () => {
  const config = loadWebServerConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4173);
  assert.equal(config.upstream.origin, "http://127.0.0.1:8787");
  assert.equal(isProxyPath("/health"), true);
  assert.equal(isProxyPath("/v1/me"), true);
  assert.equal(isProxyPath("/src/main.js"), false);
});

test("Web preview refuses network-wide binds and non-loopback upstreams", () => {
  assert.throws(() => loadWebServerConfig({ GATHERTHREAD_WEB_HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => loadWebServerConfig({ GATHERTHREAD_WEB_PORT: "0" }), /1 to 65535/);
  assert.throws(() => loadWebServerConfig({ GATHERTHREAD_WEB_API_ORIGIN: "https://api.example.com" }), /loopback HTTP origin/);
  assert.throws(() => loadWebServerConfig({ GATHERTHREAD_WEB_API_ORIGIN: "http://127.0.0.1:8787/v1" }), /must not contain a path/);
});

test("Web preview rejects absolute and malformed request targets without proxying or crashing", async () => {
  const server = createWebServer(loadWebServerConfig({}));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    for (const target of ["http://attacker.invalid/v1/me", "/bad%zz"]) {
      const response = await new Promise((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: server.address().port,
          method: "GET",
          path: target,
        }, resolve);
        request.once("error", reject);
        request.end();
      });
      assert.equal(response.statusCode, 400);
      response.resume();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
