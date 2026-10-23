import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inject } from "../src/native-plugin.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

async function bundlePatch(fragment = "cordis.patch.yml"): Promise<string> {
  return readFile(path.join(packageRoot, fragment), "utf8");
}

interface PatchEntry {
  id: string | undefined;
  body: string;
}

/** Split a Cordis patch layer into its top-level `- ` entries. */
function topLevelEntries(source: string): PatchEntry[] {
  const entries: PatchEntry[] = [];
  let current: PatchEntry | undefined;
  for (const line of source.split(/\r?\n/u)) {
    if (/^- /u.test(line)) {
      current = { id: undefined, body: "" };
      entries.push(current);
    }
    if (current !== undefined) current.body += `${line}\n`;
  }
  for (const entry of entries) {
    entry.id = /^\s*- id:\s*(\S+)\s*$/mu.exec(entry.body)?.[1];
  }
  return entries;
}

function injectList(body: string): string[] | undefined {
  const match = /^\s*inject:\s*\[([^\]]*)\]\s*$/mu.exec(body);
  if (match === null) return undefined;
  return (match[1] ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
}

function entryNamed(entries: readonly PatchEntry[], id: string): PatchEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  assert.ok(entry !== undefined, `the bundle patch must declare an entry for ${id}`);
  return entry;
}

test("bundle patch injects exactly the services the native Host plugin declares", async () => {
  // The Loader row is the only place the Host's dependency list reaches the
  // profile. A name missing here fails the row before `apply()` runs, and an
  // extra name widens the plugin's reachable services, so the two lists are
  // pinned to each other rather than to a copy of themselves.
  for (const fragment of ["cordis.patch.yml", "cordis.patch.dsh-0.1.yml"]) {
    const entries = topLevelEntries(await bundlePatch(fragment));
    const host = entries.find((entry) => entry.body.includes("id: gatherthread-dsh-native"));
    assert.ok(host !== undefined, `${fragment} must insert the native Host plugin row`);
    assert.deepEqual(injectList(host.body), [...inject], `${fragment} Host row`);
    assert.equal(
      injectList(host.body)?.includes("webServer"),
      false,
      "webServer must not be added to the Host row: cordis resolves Connection's own lookup from "
        + "Connection's fiber, so only the connection row can supply it",
    );
  }
});

test("bundle patch restores Connection's webServer dependency for DSH 0.2.1-rc.2", async () => {
  // The Host plugin registers an RPC channel through `connection.rpc.handle()`,
  // and Connection evaluates `owner.webServer` from its providing fiber, so only
  // this row can supply it. Without the restore the Host row raises
  // `cannot get property "webServer" without inject`.
  //
  // DSH 0.2.1-rc.2 declared `inject: [webStartup]` on this row with
  // `trustedHosts: !!js ctx.webStartup.trustedHosts`, and provides `webRuntime`
  // only after the server binds. Naming `webRuntime` here instead leaves the
  // required Connection row pending forever, which fails startup; naming
  // `webStartup` keeps the row's own config expression resolvable.
  const connection = entryNamed(topLevelEntries(await bundlePatch()), "connection");
  assert.deepEqual(injectList(connection.body), ["webStartup", "credentials", "webServer"]);
});

test("the frozen 0.1.x layer keeps Connection's webRuntime dependency", async () => {
  // DSH 0.1.5-rc.x moved `webServer` into a nested scope, and 0.1.7-rc.2's row
  // interpolates `!!js ctx.webRuntime.trustedHosts`. All three names are
  // load-bearing there, and the layer cannot be merged with the 0.2.x one.
  const connection = entryNamed(topLevelEntries(await bundlePatch("cordis.patch.dsh-0.1.yml")), "connection");
  assert.deepEqual(injectList(connection.body), ["webRuntime", "credentials", "webServer"]);
});

test("the manifest gates the profile layer to the DSH releases it was verified on", async () => {
  // Current DSH reads engines.dsh; older DSH reads only its optional peer.
  // Both reject the whole bundle before composing the Connection row patch.
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    engines?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  assert.equal(manifest.engines?.dsh, ">=0.2.1-rc.2 <0.3.0");
  assert.equal(manifest.peerDependencies?.["@deepseek-ai/dsh"], manifest.engines?.dsh);
  assert.equal(manifest.peerDependenciesMeta?.["@deepseek-ai/dsh"]?.optional, true);
});
