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
  const cmd = p.processCommand({ name: "shell-p1", command: process.execPath, args: ["m.js"], cwd: "/w", env: { A: "1" } });
  assert.equal(cmd.command, "incus");
  assert.ok(cmd.args.includes(CONTAINER_NODE_PATH));
  assert.ok(cmd.args.includes("A=1"));
  assert.ok(p.processCommand({ name: "shell-p1", command: "/bin/true", args: [], cwd: "/w", env: {} }).args.includes("/bin/true"));
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

/**
 * **同梱の道具用の箱の中を、偽の Incus で演じる**（追加・2026-10-15）。sudo の設定・入っているパッケージ・空きを持ち、
 * 呼ばれたコマンドを覚える
 */
function fakeToolsIncus(state: { installed: Set<string>; free: number; aptFails?: string; sudoStays?: boolean }) {
  const calls: string[][] = [];
  let sudoDropped = false;
  const run = async (args: string[]) => {
    calls.push(args);
    const cmd = args.slice(args.indexOf("--") + 1);
    if (cmd[0] === "/bin/sh" && cmd[2]?.includes("sudoers.d")) {
      sudoDropped = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "sudo") {
      const can = !sudoDropped || state.sudoStays;
      return can ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "sudo: a password is required" };
    }
    if (cmd[0] === "dpkg-query") {
      const pkgs = cmd.slice(3);
      return { code: 0, stdout: pkgs.filter((p) => state.installed.has(p)).map((p) => `${p} installed\n`).join(""), stderr: "" };
    }
    if (cmd[0] === "df") return { code: 0, stdout: `Avail\n${state.free}\n`, stderr: "" };
    if (cmd[0] === "/bin/sh" && cmd[2]?.includes("apt-get")) {
      if (state.aptFails) return { code: 100, stdout: "", stderr: state.aptFails };
      for (const p of cmd.slice(4)) state.installed.add(p);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const aptRuns = () => calls.filter((a) => a.some((x) => x.includes("apt-get"))).length;
  return { run, calls, aptRuns };
}

const toolsRuntime = (incus: ReturnType<typeof fakeToolsIncus>) =>
  new HostContainerRuntime(opts, { ok: true, problems: [] }, fakeContainers(), async () => "img", incus.run);

test("道具用の箱：中で sudo できなくし、名乗ったパッケージを root で入れてから返す。入っていれば入れない", async () => {
  const state = { installed: new Set<string>(), free: 50 * 1024 ** 3 };
  const incus = fakeToolsIncus(state);
  const rt = toolsRuntime(incus);
  assert.equal(rt.toolsPlaceId.startsWith("tools-"), true);
  assert.notEqual(rt.toolsPlaceId, rt.instancePlaceId, "第三者の Module が居る banto 全体用の箱とは別の箱");
  const p = await rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["jq", "bubblewrap"] } });
  assert.equal(p.name, `banto-${rt.toolsPlaceId}`);
  assert.deepEqual([...state.installed].sort(), ["bubblewrap", "jq"]);
  // root で（`--user` を付けずに）入れる
  const apt = incus.calls.find((a) => a.some((x) => x.includes("apt-get")))!;
  assert.equal(apt.includes("--user"), false);
  // sudo を外してから、そのユーザーで sudo できないことを確かめている
  const sudoCheck = incus.calls.find((a) => a.includes("sudo"))!;
  assert.ok(sudoCheck.includes("--user"));
  // もう一度起こしても入れ直さない
  await rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["bubblewrap", "jq"] } });
  assert.equal(incus.aptRuns(), 1);
  // 見張る相手には Project の id を付けない（資源の上限は banto 全体用の箱と同じ決め方）
  assert.deepEqual(rt.resourceTargets(), [{ containerName: `banto-${rt.toolsPlaceId}` }]);
});

test("道具用の箱：sudo を外してもできてしまうなら、Module を起こさない（fail closed）", async () => {
  const incus = fakeToolsIncus({ installed: new Set(), free: 50 * 1024 ** 3, sudoStays: true });
  const rt = toolsRuntime(incus);
  await assert.rejects(rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["jq"] } }), /まだ sudo できてしまいます/);
  assert.equal(incus.aptRuns(), 0);
});

test("道具用の箱：空きが 2GiB 未満なら入れずに理由を返す", async () => {
  const incus = fakeToolsIncus({ installed: new Set(), free: 1024 ** 3 });
  const rt = toolsRuntime(incus);
  await assert.rejects(rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["jq"] } }), /空きが 1 GiB しかありません（2 GiB 要ります）/);
  assert.equal(incus.aptRuns(), 0);
});

test("道具用の箱：入れられなかったら覚えて、「入れ直す」まで apt をやり直さない", async () => {
  const state = { installed: new Set<string>(), free: 50 * 1024 ** 3, aptFails: "E: Unable to locate package jq" as string | undefined };
  const incus = fakeToolsIncus(state);
  const rt = toolsRuntime(incus);
  const place = { id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["jq"] } };
  await assert.rejects(rt.prepare(place), /Unable to locate package jq/);
  assert.deepEqual(rt.toolsInstallStatus().failures.map((f) => f.packages), [["jq"]]);
  // 起こし直しても、毎回は走らせない——設定の「入れ直す」へ案内する
  await assert.rejects(rt.prepare(place), /道具を入れ直す/);
  await assert.rejects(rt.prepare(place), /道具を入れ直す/);
  assert.equal(incus.aptRuns(), 1);
  // 人が「入れ直す」を押すと、次に起こすときに入れ直す
  state.aptFails = undefined;
  rt.retryToolsInstall();
  assert.deepEqual(rt.toolsInstallStatus().failures, []);
  await rt.prepare(place);
  assert.equal(incus.aptRuns(), 2);
  assert.ok(state.installed.has("jq"));
});

test("道具用の箱：入れるのは同時に1本。同時に来たものは同じ1本を待つ", async () => {
  const state = { installed: new Set<string>(), free: 50 * 1024 ** 3 };
  const incus = fakeToolsIncus(state);
  let active = 0;
  let maxActive = 0;
  const slow = async (args: string[]) => {
    const isApt = args.some((x) => x.includes("apt-get"));
    if (isApt) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      return await incus.run(args);
    } finally {
      if (isApt) active--;
    }
  };
  const rt = new HostContainerRuntime(opts, { ok: true, problems: [] }, fakeContainers(), async () => "img", slow);
  let installing: readonly string[] | undefined;
  const a = rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["jq"] } });
  const b = rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["jq"] } });
  const c = rt.prepare({ id: rt.toolsPlaceId, nesting: false, tools: { aptPackages: ["bubblewrap"] } });
  await new Promise((r) => setTimeout(r, 5));
  installing = rt.toolsInstallStatus().installing;
  await Promise.all([a, b, c]);
  assert.equal(maxActive, 1);
  assert.equal(incus.aptRuns(), 2, "jq の1本と bubblewrap の1本");
  assert.ok(installing && installing.length > 0, "入れている間は、何を入れているかが見える");
  assert.equal(rt.toolsInstallStatus().installing, undefined);
});
