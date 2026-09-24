import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inject } from "../src/native-plugin.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

async function bundlePatch(): Promise<string> {
  return readFile(path.join(packageRoot, "cordis.patch.yml"), "utf8");
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
  const entries = topLevelEntries(await bundlePatch());
  const host = entries.find((entry) => entry.body.includes("id: gatherthread-dsh-native"));
  assert.ok(host !== undefined, "the bundle patch must insert the native Host plugin row");
  assert.deepEqual(injectList(host.body), [...inject]);
  assert.equal(
    injectList(host.body)?.includes("webServer"),
    false,
    "webServer must not be added to the Host row: cordis resolves Connection's own lookup from "
      + "Connection's fiber, so only the connection row can supply it",
  );
});

test("bundle patch restores Connection's webServer dependency for DSH 0.1.5-rc.x", async () => {
  // DSH 0.1.5-rc.x removed `webServer` from the Connection plugin's own inject
  // list and moved it into a nested scope that covers only its new
  // index-injection feature. Connection still evaluates `owner.webServer` from
  // its providing context, so applying the Host plugin throws
  // `cannot get property "webServer" without inject` and no row in the tree
  // loads at all. This entry mirrors the 0.1.2-rc.1 top-level list.
  //
  // All three names are load-bearing: a row patch replaces `inject` wholesale,
  // so dropping `webRuntime` would break this row's own
  // `trustedHosts: !!js ctx.webRuntime.trustedHosts`.
  const connection = entryNamed(topLevelEntries(await bundlePatch()), "connection");
  assert.deepEqual(injectList(connection.body), ["webRuntime", "credentials", "webServer"]);
});
