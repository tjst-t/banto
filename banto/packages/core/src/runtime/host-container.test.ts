import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER_NODE_PATH, ContainerAddressUnavailable, instanceContainerId, type ProjectContainers } from "@banto/container";
import { HostContainerRuntime } from "./host-container.js";
import { RuntimeStopError } from "./runtime.js";

const LIMITS = { memoryBytes: 1, cpus: 1, processes: 1 } as never;
const opts = { dataDir: "/data", port: 4000, bantoDir: "/code", limitsFor: () => LIMITS };

/** 偽の Incus（使う口だけ）。`incus` は呼ばない */
function fakeContainers(over: Partial<Record<keyof ProjectContainers, unknown>> = {}): ProjectContainers {
  return {
    ensure: async (spec: { projectId: string }) => ({ name: `banto-${spec.projectId}`, created: false }),
    hostAddress: async () => "10.0.0.1",
    ...over,
  } as unknown as ProjectContainers;
}

test("前提が欠けていれば、箱を用意せずに理由と直し方を添えて断る", async () => {
  const rt = new HostContainerRuntime(opts, { ok: false, problems: [{ code: "incus-missing", message: "Incus が無い", fix: "入れる" }] } as never, fakeContainers(), async () => "img");
  await assert.rejects(rt.prepare({ id: "p1", root: "/w", nesting: false }), /前提が欠けています：Incus が無い（直し方：入れる）/);
});

test("用意した箱：パスは host と同じ・中から届く住所はブリッジの host 側・node は中の決まった場所", async () => {
  const rt = new HostContainerRuntime(opts, { ok: true, problems: [] }, fakeContainers(), async () => "img");
  const p = await rt.prepare({ id: "p1", root: "/w", nesting: false });
  assert.equal(p.name, "banto-p1");
  assert.equal(p.pathInside("/data/modules/x"), "/data/modules/x");
  assert.equal(p.bantoOrigin, "http://10.0.0.1:4000");
  assert.equal(p.nodePath, CONTAINER_NODE_PATH);
  const cmd = p.processCommand({ command: process.execPath, args: ["m.js"], cwd: "/w", env: { A: "1" } });
  assert.equal(cmd.command, "incus");
  assert.ok(cmd.args.includes(CONTAINER_NODE_PATH));
  assert.ok(cmd.args.includes("A=1"));
  assert.ok(p.processCommand({ command: "/bin/true", args: [], cwd: "/w", env: {} }).args.includes("/bin/true"));
});

test("見張る相手は用意できた箱だけ。banto 全体用の箱には Project の id を付けない", async () => {
  const rt = new HostContainerRuntime(opts, { ok: true, problems: [] }, fakeContainers(), async () => "img");
  await rt.prepare({ id: "p1", root: "/w", nesting: false });
  await rt.prepare({ id: rt.instancePlaceId, nesting: false });
  assert.equal(rt.instancePlaceId, instanceContainerId("/data"));
  assert.deepEqual(rt.resourceTargets(), [
    { containerName: "banto-p1", projectId: "p1" },
    { containerName: `banto-${rt.instancePlaceId}` },
  ]);
  rt.forget("p1");
  assert.deepEqual(rt.resourceTargets(), [{ containerName: `banto-${rt.instancePlaceId}` }]);
});

test("止められなければ、どの箱が残ったかを添えて投げる。止めないときは手放すだけ", async () => {
  let stops = 0;
  const rt = new HostContainerRuntime(opts, { ok: true, problems: [] }, fakeContainers({
    stop: async () => {
      stops++;
      throw new Error("timeout");
    },
  }), async () => "img");
  await rt.prepare({ id: "p1", root: "/w", nesting: false });
  await rt.prepare({ id: "p2", root: "/v", nesting: false });
  await rt.release("p1", { stop: false });
  assert.equal(stops, 0);
  await assert.rejects(rt.release("p2", { stop: true }), (err: unknown) => {
    assert.ok(err instanceof RuntimeStopError);
    assert.equal(err.placeName, "banto-p2");
    assert.equal(err.reason, "timeout");
    return true;
  });
  assert.deepEqual(rt.resourceTargets(), []);
});

test("Publish のアドレス：確かに届かないは値で返し、分からないは投げる。送り元の照合は届かないなら「違う」", async () => {
  let mode: "ok" | "gone" | "broken" = "ok";
  const rt = new HostContainerRuntime(opts, { ok: true, problems: [] }, fakeContainers({
    containerAddress: async (_name: string, owner: string) => {
      assert.equal(owner, "/data");
      if (mode === "gone") throw new ContainerAddressUnavailable("止まっている");
      if (mode === "broken") throw new Error("incus が答えない");
      return "10.0.0.9";
    },
  }), async () => "img");
  assert.deepEqual(await rt.address("p1"), { address: "10.0.0.9" });
  assert.equal(await rt.sourceMatches("p1", "10.0.0.9"), true);
  assert.equal(await rt.sourceMatches("p1", "10.0.0.8"), false);
  mode = "gone";
  assert.deepEqual(await rt.address("p1"), { unavailable: "止まっている" });
  assert.equal(await rt.sourceMatches("p1", "10.0.0.9"), false);
  mode = "broken";
  await assert.rejects(rt.address("p1"), /答えない/);
  await assert.rejects(rt.sourceMatches("p1", "10.0.0.9"), /答えない/);
});
