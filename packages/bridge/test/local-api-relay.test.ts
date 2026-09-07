import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import type {
  AppendEventInput,
  CollaborationApi,
  CompleteAgentRequestInput,
  RuntimeRegistration,
} from "../src/index.js";
import {
  LocalConnectorApiRelayServer,
  LocalConnectorCollaborationClient,
  resolveWorkspaceConnectorApiPath,
} from "../src/index.js";

class FakeApi implements CollaborationApi {
  appended: AppendEventInput[] = [];
  listProjectCalls = 0;
  constructor(readonly projectId = "p1", readonly sessionId = "s1") {}
  async listProjects() {
    this.listProjectCalls += 1;
    return [{ id: this.projectId, name: `Project ${this.projectId}`, role: "owner" as const, state: "active" as const, sessionCount: 1 }];
  }
  async listProjectSessions() {
    return [{ id: this.sessionId, projectId: this.projectId, name: `Session ${this.sessionId}`, mode: "multi" as const, role: "owner" as const }];
  }
  async listSessions() { return this.listProjectSessions(); }
  async listSessionMembers() { return []; }
  async readEvents(_sessionId: string, afterSequence: number) {
    return { events: [], nextSequence: afterSequence, hasMore: false };
  }
  async appendEvent(sessionId: string, input: AppendEventInput) {
    this.appended.push(input);
    return {
      id: "e1", sessionId, sequence: 1, type: input.type, actorId: "u1",
      timestamp: "2026-09-06T00:00:00.000Z", payload: input.payload,
    };
  }
  async registerRuntime(runtime: RuntimeRegistration) { return { ...runtime, id: "r1", userId: "u1" }; }
  async claimAgentRequest(_sessionId: string, requestId: string, runtimeId: string) {
    return { claimed: true, status: "claimed" as const, requestId, runtimeId };
  }
  async completeAgentRequest(_sessionId: string, _requestId: string, input: CompleteAgentRequestInput) {
    return this.appendEvent(this.sessionId, {
      type: "agent_response", idempotencyKey: input.idempotencyKey, payload: input.payload,
    });
  }
}

test("local user API relay uses a private ephemeral capability and refuses a second connector", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows named-pipe isolation is covered by deterministic path and capability tests");
    return;
  }
  const directory = await mkdtemp(path.join("/tmp", "gtr-"));
  const homeDirectory = path.join(directory, "home");
  const workspacePath = path.join(directory, "workspace");
  await mkdir(path.join(workspacePath, "nested"), { recursive: true });
  const linkedWorkspacePath = path.join(directory, "workspace-link");
  await symlink(workspacePath, linkedWorkspacePath, "dir");
  const endpoint = resolveWorkspaceConnectorApiPath(await realpath(workspacePath), homeDirectory);
  const api = new FakeApi();
  const first = new LocalConnectorApiRelayServer({ endpoint, api, projectId: "p1", homeDirectory });
  try {
    await first.start();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.diagnostic("Unix sockets are blocked by the current test sandbox");
      return;
    }
    throw error;
  }
  t.after(() => first.close());
  assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
  assert.equal((await stat(`${endpoint}.capability`)).mode & 0o777, 0o600);
  const firstCapability = await readFile(`${endpoint}.capability`, "utf8");
  const registrations = await readdir(path.join(homeDirectory, ".gatherthread", "codex", "ipc", "active"));
  assert.equal(registrations.length, 1);
  const registration = await readFile(path.join(
    homeDirectory, ".gatherthread", "codex", "ipc", "active", registrations[0]!,
  ), "utf8");
  assert.doesNotMatch(registration, new RegExp(firstCapability));
  assert.doesNotMatch(registration, /token|Bearer|capability/i);

  const client = new LocalConnectorCollaborationClient({
    workspacePath: path.join(linkedWorkspacePath, "nested"),
    homeDirectory,
  });
  assert.equal((await client.listProjects())[0]?.id, "p1");
  const unauthorized = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({
      id: "rogue", method: "listProjects", params: [], capability: "predictable-path-is-not-authority",
    })}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
  assert.match(unauthorized, /capability was rejected/);
  assert.equal(api.listProjectCalls, 1);
  await client.appendEvent("s1", {
    type: "human_chat", idempotencyKey: "local-relay-chat", payload: { text: "hello" },
  });
  assert.equal(api.appended.length, 1);

  const second = new LocalConnectorApiRelayServer({ endpoint, api, projectId: "p1", homeDirectory });
  await assert.rejects(second.start(), /already active/);
  await second.close();
  assert.equal((await client.listProjects())[0]?.id, "p1");

  await first.close();
  await assert.rejects(access(`${endpoint}.capability`));
  const restarted = new LocalConnectorApiRelayServer({ endpoint, api, projectId: "p1", homeDirectory });
  await restarted.start();
  t.after(() => restarted.close());
  assert.notEqual(await readFile(`${endpoint}.capability`, "utf8"), firstCapability);
});

test("MCP discovery deduplicates restarted endpoints, aggregates active projects, and routes sessions uniquely", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX multiplexer fixture; Windows registry and pipe names share the same client logic");
    return;
  }
  const directory = await mkdtemp(path.join("/tmp", "gtr-multi-"));
  const homeDirectory = path.join(directory, "home");
  const workspaces = ["one", "two", "duplicate"].map((name) => path.join(directory, name));
  const pluginCache = path.join(directory, "plugin-cache");
  await Promise.all([...workspaces, pluginCache].map((candidate) => mkdir(candidate, { recursive: true })));
  const firstApi = new FakeApi("p1", "s1");
  const secondApi = new FakeApi("p2", "s2");
  const firstEndpoint = resolveWorkspaceConnectorApiPath(await realpath(workspaces[0]!), homeDirectory);
  const secondEndpoint = resolveWorkspaceConnectorApiPath(await realpath(workspaces[1]!), homeDirectory);
  const first = new LocalConnectorApiRelayServer({
    endpoint: firstEndpoint,
    api: firstApi,
    projectId: "p1",
    homeDirectory,
  });
  const second = new LocalConnectorApiRelayServer({
    endpoint: secondEndpoint,
    api: secondApi,
    projectId: "p2",
    homeDirectory,
  });
  t.after(() => Promise.all([first.close(), second.close()]));
  try {
    await Promise.all([first.start(), second.start()]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.diagnostic("Unix sockets are blocked by the current test sandbox");
      return;
    }
    throw error;
  }
  const activeDirectory = path.join(homeDirectory, ".gatherthread", "codex", "ipc", "active");
  const supersededInstanceId = randomUUID();
  await writeFile(path.join(activeDirectory, `${supersededInstanceId}.json`), JSON.stringify({
    version: 1,
    instanceId: supersededInstanceId,
    endpoint: firstEndpoint,
    projectId: "p1",
    leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  }), { mode: 0o600 });
  const client = new LocalConnectorCollaborationClient({ workspacePath: pluginCache, homeDirectory });
  assert.deepEqual((await client.listProjects()).map(({ id }) => id), ["p1", "p2"]);
  const workspaceClient = new LocalConnectorCollaborationClient({
    workspacePath: workspaces[0]!,
    homeDirectory,
  });
  assert.deepEqual(
    (await workspaceClient.listProjects()).map(({ id }) => id),
    ["p1", "p2"],
    "an MCP launched from one project must still aggregate every active connector",
  );
  assert.deepEqual((await client.listSessions()).map(({ id }) => id), ["s1", "s2"]);
  await client.appendEvent("s2", {
    type: "human_chat", idempotencyKey: "multi-route-chat", payload: { text: "hello two" },
  });
  assert.equal(firstApi.appended.length, 0);
  assert.equal(secondApi.appended.length, 1);

  const staleEndpointId = "b".repeat(24);
  const staleEndpointDirectory = path.join(homeDirectory, ".gatherthread", "codex", "ipc", staleEndpointId);
  await mkdir(staleEndpointDirectory, { recursive: true });
  const staleEndpoint = path.join(staleEndpointDirectory, "user-api.sock");
  await writeFile(`${staleEndpoint}.capability`, "B".repeat(43), { mode: 0o600 });
  const staleInstanceId = randomUUID();
  const staleRegistrationPath = path.join(activeDirectory, `${staleInstanceId}.json`);
  await writeFile(staleRegistrationPath, JSON.stringify({
    version: 1,
    instanceId: staleInstanceId,
    endpoint: staleEndpoint,
    projectId: "offline-project",
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  assert.deepEqual((await client.listProjects()).map(({ id }) => id), ["p1", "p2"]);
  await assert.rejects(access(staleRegistrationPath));
  assert.equal(await readFile(`${staleEndpoint}.capability`, "utf8"), "B".repeat(43));

  const duplicate = new LocalConnectorApiRelayServer({
    endpoint: resolveWorkspaceConnectorApiPath(await realpath(workspaces[2]!), homeDirectory),
    api: new FakeApi("p1", "s3"),
    projectId: "p1",
    homeDirectory,
  });
  await duplicate.start();
  t.after(() => duplicate.close());
  await assert.rejects(client.listProjects(), /Multiple active connectors expose project ID p1/);
});

test("expired connector registrations are ignored immediately without deleting shared endpoint authority", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX stale socket fixture");
    return;
  }
  const directory = await mkdtemp(path.join("/tmp", "gtr-stale-active-"));
  const homeDirectory = path.join(directory, "home");
  const pluginCache = path.join(directory, "plugin-cache");
  const endpointId = "a".repeat(24);
  const endpointDirectory = path.join(homeDirectory, ".gatherthread", "codex", "ipc", endpointId);
  const activeDirectory = path.join(homeDirectory, ".gatherthread", "codex", "ipc", "active");
  await Promise.all([
    mkdir(pluginCache),
    mkdir(endpointDirectory, { recursive: true }),
    mkdir(activeDirectory, { recursive: true }),
  ]);
  const endpoint = path.join(endpointDirectory, "user-api.sock");
  const capabilityPath = `${endpoint}.capability`;
  await writeFile(capabilityPath, "A".repeat(43), { mode: 0o600 });
  const instanceId = randomUUID();
  const registrationPath = path.join(activeDirectory, `${instanceId}.json`);
  await writeFile(registrationPath, JSON.stringify({
    version: 1,
    instanceId,
    endpoint,
    projectId: "stale-project",
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  const client = new LocalConnectorCollaborationClient({ workspacePath: pluginCache, homeDirectory });
  await assert.rejects(client.listProjects(), /not running/);
  await assert.rejects(access(registrationPath));
  assert.equal(await readFile(capabilityPath, "utf8"), "A".repeat(43));
});

test("workspace IPC names are stable but write authorization is not encoded in the path", () => {
  const first = resolveWorkspaceConnectorApiPath("C:\\Users\\Alice\\Project", "C:\\Users\\Alice", "win32");
  const second = resolveWorkspaceConnectorApiPath("c:\\users\\alice\\project", "C:\\Users\\Alice", "win32");
  assert.equal(first, second);
  assert.match(first, /^\\\\\.\\pipe\\gatherthread-[a-f0-9]{24}-user-api$/);
  assert.doesNotMatch(first, /token|capability|Bearer|gta_/i);
});
