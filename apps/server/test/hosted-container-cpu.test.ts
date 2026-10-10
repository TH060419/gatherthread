import assert from "node:assert/strict";
import test from "node:test";
import { HOSTED_CPUSET_ENTRYPOINT, hostedContainerCpuArguments, parseHostedCpuSet } from "../src/hosted-container-cpu.js";

test("CPU affinity accepts only an explicitly configured canonical single index", () => {
  assert.equal(parseHostedCpuSet(undefined), undefined);
  for (const value of ["0", "1", "4095"]) assert.equal(parseHostedCpuSet(value), value);
  for (const value of ["", " ", " 1", "1 ", "01", "-1", "+1", "1.0", "0,1", "0-1", "4096", "1\n", "1\r\n",
    null, 1, ["1"]]) assert.throws(() => parseHostedCpuSet(value as string), /canonical CPU index/);
});

test("default CFS arguments are unchanged and explicit affinity always forces the guarded image entrypoint", () => {
  assert.deepEqual(hostedContainerCpuArguments("trial", undefined, 768), ["--cpus", "1"]);
  assert.deepEqual(hostedContainerCpuArguments("repository", undefined, 2048), ["--cpus", "2"]);
  for (const [kind, memory, pids] of [["trial", 512, 128], ["repository", 256, 256]] as const) {
    const args = hostedContainerCpuArguments(kind, "1", memory);
    assert.deepEqual(args, ["--cpuset-cpus", "1", "--entrypoint", HOSTED_CPUSET_ENTRYPOINT,
      "-e", "GT_HOSTED_CPUSET=1", "-e", `GT_HOSTED_MEMORY_BYTES=${memory * 1024 * 1024}`, "-e", `GT_HOSTED_PIDS=${pids}`]);
    assert.ok(!args.includes("--cpus"));
  }
  for (const value of [255, 769, NaN, Infinity, 512.5]) {
    assert.throws(() => hostedContainerCpuArguments("trial", "1", value), /memory/);
  }
});

test("shared-host memory cannot select the unguarded CFS entrypoint", () => {
  for (const [kind, memory] of [["trial", 512], ["repository", 768]] as const) {
    assert.throws(() => hostedContainerCpuArguments(kind, undefined, memory, "shared-host"), /guarded CPU set/);
    const args = hostedContainerCpuArguments(kind, "1", memory, "shared-host");
    assert.ok(args.includes(HOSTED_CPUSET_ENTRYPOINT));
    assert.ok(args.includes("GT_HOSTED_MEMORY_POLICY=shared-host"));
  }
});
