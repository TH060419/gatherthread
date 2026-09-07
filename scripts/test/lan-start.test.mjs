import assert from "node:assert/strict";
import test from "node:test";
import {
  caddyInstallHint,
  lanOrigin,
  parseLanStartArguments,
  privateLanAddresses,
} from "../lan-start.mjs";

test("LAN one-command startup discovers only usable private interfaces", () => {
  assert.deepEqual(privateLanAddresses({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.50.20", family: "IPv4", internal: false }],
    bridge0: [{ address: "10.10.0.2", family: 4, internal: false }],
    public0: [{ address: "203.0.113.8", family: "IPv4", internal: false }],
    link0: [{ address: "fe80::1", family: "IPv6", internal: false }],
  }), [
    { interfaceName: "bridge0", address: "10.10.0.2", family: 4 },
    { interfaceName: "en0", address: "192.168.50.20", family: 4 },
  ]);
});

test("LAN one-command arguments stay explicit and bounded", () => {
  assert.deepEqual(parseLanStartArguments([
    "--address", "192.168.50.20",
    "--port", "9443",
    "--display-name", "Yuhan He",
    "--device-name", "Lab Mac",
  ]), {
    address: "192.168.50.20",
    port: 9443,
    displayName: "Yuhan He",
    deviceName: "Lab Mac",
  });
  assert.equal(lanOrigin("192.168.50.20", 9443), "https://192.168.50.20:9443");
  assert.equal(lanOrigin("fd00::20", 8443), "https://[fd00::20]:8443");
  assert.throws(() => parseLanStartArguments(["--address", "8.8.8.8"]), /private IP/);
  assert.throws(() => parseLanStartArguments(["--port", "443"]), /1024 to 65535/);
});

test("missing Caddy guidance is short and platform-specific", () => {
  assert.match(caddyInstallHint("darwin"), /brew install caddy/);
  assert.match(caddyInstallHint("win32"), /choco install caddy/);
  assert.match(caddyInstallHint("linux"), /caddyserver\.com\/docs\/install/);
});
