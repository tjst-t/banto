import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectContainers, containerNameFor, execInContainer, idmapFor, instanceContainerId } from "./project-container.js";
import type { RunIncus } from "./incus.js";

test("同じコンテナへの設定の書き換えは、同時に来ても1本ずつ通す（Incus は同時の書き換えを断る）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const devices: Record<string, Record<string, string>> = {};
  const run: RunIncus = async (args) => {
    if (args[0] === "project") return { code: 0, stdout: "user-1000\n", stderr: "" };
    if (args[0] === "query") return { code: 0, stdout: JSON.stringify({ status: "Running", config: {}, devices }), stderr: "" };
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    if (args[1] === "device" && args[2] === "add") devices[args[4]!] = { source: args[6]!.slice(7), path: args[7]!.slice(5) };
    inFlight--;
    return { code: 0, stdout: "", stderr: "" };
  };
  const c = new ProjectContainers(run);
  await Promise.all(["/d/a", "/d/b", "/d/c"].map((dir, i) => c.ensureDisk("banto-x", `m-${i}`, dir)));
  assert.equal(maxInFlight, 1, "書き換えが重なった");
  assert.deepEqual(Object.keys(devices).sort(), ["m-0", "m-1", "m-2"]);
});

test("前の書き換えが失敗しても、次の書き換えは止まらない", async () => {
  let calls = 0;
  const run: RunIncus = async (args) => {
    if (args[0] === "project") return { code: 0, stdout: "p\n", stderr: "" };
    if (args[0] === "query") return { code: 0, stdout: JSON.stringify({ status: "Running", config: {}, devices: {} }), stderr: "" };
    calls++;
    return calls === 1 ? { code: 1, stdout: "", stderr: "Error: boom" } : { code: 0, stdout: "", stderr: "" };
  };
  const c = new ProjectContainers(run);
  const [a, b] = await Promise.allSettled([c.ensureDisk("banto-x", "m-a", "/a"), c.ensureDisk("banto-x", "m-b", "/b")]);
  assert.equal(a.status, "rejected");
  assert.match(String((a as PromiseRejectedResult).reason), /boom/);
  assert.equal(b.status, "fulfilled");
});

test("コンテナの名前は Incus の決まりに合わせる", () => {
  assert.equal(containerNameFor("9cc52d86-179c-49ca-af37-c537f38c67fe"), "banto-9cc52d86-179c-49ca-af37-c537f38c67fe");
  assert.equal(containerNameFor("AB_c"), "banto-ab-c");
});

test("uid と gid が同じなら1行、違えば2行で対応させる", () => {
  assert.equal(idmapFor(1000, 1000), "both 1000 1000");
  assert.equal(idmapFor(1000, 1001), "uid 1000 1000\ngid 1001 1001");
});

test("中で起こす：ユーザーを切り替えてから cd し、入れなければ 126（--cwd には頼らない）", () => {
  const r = execInContainer("banto-x", { cwd: "/home/u/p", env: { A: "1" }, uid: 1000, gid: 1000 }, "/usr/local/bin/node", ["s.js"]);
  assert.equal(r.command, "incus");
  assert.deepEqual(r.args, [
    "exec", "banto-x", "--user", "1000", "--group", "1000", "--env", "A=1", "--",
    "/bin/sh", "-c", 'cd -- "$1" || exit 126; shift; exec "$@"', "banto-cd", "/home/u/p", "/usr/local/bin/node", "s.js",
  ]);
  assert.ok(!r.args.includes("--cwd"));
});

test("banto 全体用のコンテナは、どの banto のものか（置き場）で名前が分かれる", () => {
  const a = containerNameFor(instanceContainerId("/home/u/.local/share/banto"));
  const b = containerNameFor(instanceContainerId("/home/u/.cache/banto-e2e/1/data"));
  assert.match(a, /^banto-instance-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(a, containerNameFor(instanceContainerId("/home/u/.local/share/banto")), "同じ置き場なら同じ名前");
});

/** 偽の Incus：コンテナの状態を持ち、device の付け外しを覚える（`ensure` の一周が通る分だけ） */
function fakeIncus(initial?: { devices: Record<string, Record<string, string>> }) {
  let state = initial ? { status: "Running", config: { "security.nesting": "false" }, devices: initial.devices } : undefined;
  const calls: string[][] = [];
  const run: RunIncus = async (args) => {
    calls.push(args);
    if (args[0] === "project") return { code: 0, stdout: "p\n", stderr: "" };
    if (args[0] === "query") return state ? { code: 0, stdout: JSON.stringify(state), stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
    if (args[0] === "init") state = { status: "Stopped", config: { "security.nesting": "false" }, devices: {} };
    if (args[0] === "start" && state) state.status = "Running";
    if (args[0] === "config" && args[1] === "device" && args[2] === "remove") delete state!.devices[args[4]!];
    if (args[0] === "config" && args[1] === "device" && args[2] === "add") {
      const opts = Object.fromEntries(args.slice(6).map((a) => a.split("=") as [string, string]));
      state!.devices[args[4]!] = opts;
    }
    if (args[0] === "exec" && args.includes("--version")) return { code: 0, stdout: "v24.0.0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, devices: () => state?.devices ?? {} };
}

const SPEC = {
  projectId: "p1",
  root: "/home/u/proj",
  bantoDir: "/home/u/ghq/banto",
  nodePath: "/usr/local/bin/node",
  nodeVersion: "v24.0.0",
  nesting: false,
  image: "images:ubuntu/24.04",
  owner: "/home/u/.local/share/banto",
  uid: 1000,
  gid: 1000,
};

test("banto のコードの置き場が移ったら、コンテナのマウントを付け直す（読み取り専用のまま）", async () => {
  const fake = fakeIncus({
    devices: {
      banto: { type: "disk", source: "/home/u/worktrees/banto-v4/banto", path: "/home/u/worktrees/banto-v4/banto", readonly: "true" },
      project: { type: "disk", source: "/home/u/proj", path: "/home/u/proj" },
    },
  });
  await new ProjectContainers(fake.run).ensure(SPEC);
  assert.deepEqual(fake.devices()["banto"], { source: "/home/u/ghq/banto", path: "/home/u/ghq/banto", readonly: "true" });
  assert.ok(fake.calls.some((a) => a.join(" ") === "config device remove banto-p1 banto"), "古い置き場を外していない");
});

test("置き場が同じなら付け直さない。作るときも同じ1か所で付ける", async () => {
  const same = fakeIncus({
    devices: {
      banto: { type: "disk", source: "/home/u/ghq/banto", path: "/home/u/ghq/banto", readonly: "true" },
      project: { type: "disk", source: "/home/u/proj", path: "/home/u/proj" },
    },
  });
  await new ProjectContainers(same.run).ensure(SPEC);
  assert.equal(same.calls.filter((a) => a[0] === "config" && a[1] === "device").length, 0, "変わっていないのに付け直した");

  const fresh = fakeIncus();
  const r = await new ProjectContainers(fresh.run).ensure(SPEC);
  assert.equal(r.created, true);
  assert.deepEqual(fresh.devices()["banto"], { source: "/home/u/ghq/banto", path: "/home/u/ghq/banto", readonly: "true" });
  assert.equal(fresh.calls.filter((a) => a.join(" ").startsWith("config device add banto-p1 banto ")).length, 1);
});
