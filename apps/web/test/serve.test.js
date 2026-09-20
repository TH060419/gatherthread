import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebServer, isProxyPath, loadWebServerConfig } from "../scripts/serve.mjs";

test("Web preview binds to loopback and proxies only owner-host API paths", () => {
  const config = loadWebServerConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4173);
  assert.equal(config.upstream.origin, "http://127.0.0.1:18787");
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

test("Web preview serves the product home and nested application entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "gatherthread-web-home-"));
  await mkdir(join(root, "app"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Product home</title>");
  await writeFile(join(root, "app", "index.html"), "<!doctype html><title>Application</title>");
  await writeFile(join(root, "assets", "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const server = createWebServer({ ...loadWebServerConfig({}), root });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    for (const [path, title] of [["/", "Product home"], ["/app/", "Application"]]) {
      const response = await new Promise((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: server.address().port,
          method: "GET",
          path,
        }, resolve);
        request.once("error", reject);
        request.end();
      });
      assert.equal(response.statusCode, 200);
      let body = "";
      response.setEncoding("utf8");
      for await (const chunk of response) body += chunk;
      assert.match(body, new RegExp(title));
    }

    const asset = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        method: "GET",
        path: "/assets/mark.svg",
      }, resolve);
      request.once("error", reject);
      request.end();
    });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers["content-type"], "image/svg+xml");
    asset.resume();

    const redirect = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        method: "GET",
        path: "/app",
      }, resolve);
      request.once("error", reject);
      request.end();
    });
    assert.equal(redirect.statusCode, 308);
    assert.equal(redirect.headers.location, "/app/");
    redirect.resume();

    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        path: "/app/",
      }, resolve);
      request.once("error", reject);
      request.end();
    });
    assert.equal(response.statusCode, 405);
    response.resume();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
