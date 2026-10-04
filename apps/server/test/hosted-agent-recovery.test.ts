import assert from "node:assert/strict";
import test from "node:test";
import { stopInterruptedHostedContainers, stopHostedContainer, HostedExecutorCleanupError } from "../src/hosted-agent-recovery.js";

test("runtime cleanup confirms exit and fails closed for a remaining executor", () => {
 const name = `gt-hosted-${"a".repeat(16)}`; let present = true;
 stopHostedContainer(name, (args) => {
  if (args[0] === "rm") present = false;
  return { status: 0, stdout: present ? name : "" };
 });
 assert.equal(present, false);
 assert.throws(() => stopHostedContainer(name, () => ({ status: 0, stdout: name })), HostedExecutorCleanupError);
 assert.throws(() => stopHostedContainer(name, () => ({ status: 1, stdout: "" })), HostedExecutorCleanupError);
});

test("startup confirms executor exit including orphan names and preserves unrelated containers", () => {
 const names = new Set([`gt-hosted-${"a".repeat(16)}`, `gt-repository-${"b".repeat(32)}`, "database", "gt-hosted-unrelated"]);
 const removed: string[] = [];
 stopInterruptedHostedContainers((args) => {
  if (args[0] === "ps") return { status: 0, stdout: [...names].join("\n") };
  removed.push(args[2]!); names.delete(args[2]!); return { status: 0, stdout: "" };
 });
 assert.equal(removed.length, 2); assert.deepEqual([...names], ["database", "gt-hosted-unrelated"]);
});
for (const failure of ["list", "remove", "still-present"]) {
 test(`startup fails closed when executor cleanup cannot confirm exit: ${failure}`, () => {
  const name = `gt-hosted-${"a".repeat(16)}`;
  assert.throws(() => stopInterruptedHostedContainers((args) => {
   if (args[0] === "ps") return { status: failure === "list" ? 1 : 0, stdout: name };
   return { status: failure === "remove" ? 1 : 0, stdout: "" };
  }), /Cloud Agent container/);
 });
}
