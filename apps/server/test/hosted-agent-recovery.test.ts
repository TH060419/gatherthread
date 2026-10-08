import assert from "node:assert/strict";
import test from "node:test";
import { cleanupHostedExecution, stopInterruptedHostedContainers, stopHostedContainer, HostedExecutorCleanupError } from "../src/hosted-agent-recovery.js";

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

for (const stage of ["first-list", "remove", "confirm-list"]) {
 test(`runtime cleanup classifies an unexpected Docker client exception: ${stage}`, () => {
  const name = `gt-repository-${"b".repeat(32)}`;
  let checks = 0;
  assert.throws(() => stopHostedContainer(name, (args) => {
   if (args[0] === "ps") checks++;
   if ((stage === "first-list" && checks === 1)
    || (stage === "remove" && args[0] === "rm")
    || (stage === "confirm-list" && checks === 2)) {
    throw new Error("ENOSPC: private Docker client fixture");
   }
   return { status: 0, stdout: args[0] === "ps" && checks === 1 ? name : "" };
  }), HostedExecutorCleanupError);
 });
}

test("resource cleanup failure cannot mask an unknown executor exit", async () => {
 const attempted: string[] = [];
 await assert.rejects(cleanupHostedExecution(() => { throw new Error("client fixture failure"); }, [
  () => { attempted.push("model"); },
  () => { attempted.push("files"); throw new Error("filesystem fixture failure"); },
  () => { attempted.push("remaining socket"); },
 ]), HostedExecutorCleanupError);
 assert.deepEqual(attempted, ["model", "files", "remaining socket"]);
 await assert.rejects(cleanupHostedExecution(() => {}, [
  () => { throw new Error("filesystem fixture failure"); },
 ]), /filesystem fixture failure/);
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
