import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLanProxyConfiguration,
  caddyChildEnvironment,
  resolveLanBindAddress,
  renderLanCaddyfile,
} from "../self-host-lan.mjs";

test("LAN proxy keeps the application on loopback behind exact HTTPS", () => {
  const result = assertLanProxyConfiguration({
    NODE_ENV: "production",
    GATHERTHREAD_SERVER_HOST: "127.0.0.1",
    GATHERTHREAD_SERVER_PORT: "8787",
    GATHERTHREAD_PUBLIC_BASE_URL: "https://192.168.50.20:8443",
    GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "true",
  });
  assert.equal(result.target, "http://127.0.0.1:8787");
  const caddyfile = renderLanCaddyfile(result.publicUrl, result.target, "192.168.50.20");
  assert.match(caddyfile, /skip_install_trust/);
  assert.match(caddyfile, /https:\/\/192\.168\.50\.20:8443/);
  assert.match(caddyfile, /bind 192\.168\.50\.20/);
  assert.match(caddyfile, /reverse_proxy http:\/\/127\.0\.0\.1:8787/);
});

test("LAN hostname resolves only to a private bind address", async () => {
  const url = new URL("https://gatherthread.home.arpa:8443");
  const address = await resolveLanBindAddress(url, async () => [
    { address: "203.0.113.20", family: 4 },
    { address: "192.168.50.20", family: 4 },
  ]);
  assert.equal(address, "192.168.50.20");
  await assert.rejects(
    () => resolveLanBindAddress(url, async () => [{ address: "203.0.113.20", family: 4 }]),
    /does not resolve to a private LAN address/,
  );
});

test("LAN proxy rejects non-production and non-loopback application binds", () => {
  assert.throws(() => assertLanProxyConfiguration({
    NODE_ENV: "development",
  }), /NODE_ENV=production/);
  assert.throws(() => assertLanProxyConfiguration({
    NODE_ENV: "production",
    GATHERTHREAD_SERVER_HOST: "0.0.0.0",
    GATHERTHREAD_PUBLIC_BASE_URL: "https://192.168.50.20:8443",
    GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "true",
  }), /127\.0\.0\.1/);
});

test("Caddy child environment excludes GatherThread and unrelated credentials", () => {
  const child = caddyChildEnvironment({
    PATH: "/usr/bin",
    HOME: "/safe/home",
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "do-not-forward",
    OPENAI_API_KEY: "do-not-forward",
  }, "/private/data", "/private/config");
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.HOME, "/safe/home");
  assert.equal(child.XDG_DATA_HOME, "/private/data");
  assert.equal(child.XDG_CONFIG_HOME, "/private/config");
  assert.equal(child.GATHERTHREAD_AUTH_TOKEN_PEPPER, undefined);
  assert.equal(child.OPENAI_API_KEY, undefined);
});
