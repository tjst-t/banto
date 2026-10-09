import { test } from "node:test";
import assert from "node:assert/strict";
import { ResourceWatch, classifyProcesses, commandLabel, containerCgroupPath, readConsumers, type FsReader } from "./resources.js";

/** パスと中身の表から作る偽の fs。フォルダは「その下にファイルがあるもの」 */
function fakeFs(files: Record<string, string>): FsReader {
  return {
    read: (p) => files[p],
    dirs: (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set<string>();
      for (const k of Object.keys(files)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length).split("/");
        if (rest.length > 1) names.add(rest[0]!);
      }
      return [...names];
    },
  };
}

const MiB = 1024 * 1024;

function proc(files: Record<string, string>, pid: number, ppid: number, argv: string[], rssKb: number) {
  files[`/proc/${pid}/stat`] = `${pid} (${argv[0]?.split("/").pop()?.slice(0, 15) ?? "x"}) S ${ppid} 1 1 0`;
  files[`/proc/${pid}/cmdline`] = `${argv.join("\0")}\0`;
  files[`/proc/${pid}/status`] = `Name:\tx\nRssAnon:\t${rssKb} kB\nRssShmem:\t0 kB\n`;
}

test("コンテナの cgroup の場所は区画の名前を付ける（default なら付けない）", () => {
  assert.equal(containerCgroupPath("user-1000", "banto-abc"), "/sys/fs/cgroup/lxc.payload.user-1000_banto-abc");
  assert.equal(containerCgroupPath("default", "banto-abc"), "/sys/fs/cgroup/lxc.payload.banto-abc");
});

test("コマンドの1行は sh -c の中身を出し、長ければ切る", () => {
  assert.equal(commandLabel(["/bin/sh", "-c", "npx playwright test  specs/a.spec.ts"]), "npx playwright test specs/a.spec.ts");
  assert.equal(commandLabel(["node", "x".repeat(100)]).length, 80);
});

test("プロセスを親子でたどり、Module・AI の仕事・コマンド・その他に分ける", () => {
  const f: Record<string, string> = {};
  proc(f, 10, 1, ["/usr/local/bin/node", "/x/banto/packages/modules/shell/dist/server.js"], 90 * 1024);
  proc(f, 11, 10, ["/bin/sh", "-c", "npx playwright test"], 1024);
  proc(f, 12, 11, ["node", "playwright/lib/worker"], 500 * 1024);
  proc(f, 20, 1, ["/usr/local/bin/node", "/x/banto/packages/modules/subagent/dist/server.js"], 130 * 1024);
  proc(f, 21, 20, ["node", "/y/@agentclientprotocol/claude-agent-acp/dist/index.js"], 120 * 1024);
  proc(f, 22, 21, ["/y/node_modules/@anthropic-ai/claude-code/cli.js"], 300 * 1024);
  proc(f, 23, 22, ["chromium", "--headless"], 200 * 1024);
  proc(f, 30, 1, ["sleep", "100"], 10);
  const fs = fakeFs(f);
  const out = classifyProcesses(
    [10, 11, 12, 20, 21, 22, 23, 30].map((pid) => {
      const stat = fs.read(`/proc/${pid}/stat`)!;
      return {
        pid,
        ppid: Number(stat.split(") ")[1]!.split(" ")[1]),
        comm: "x",
        argv: fs.read(`/proc/${pid}/cmdline`)!.split("\0").filter(Boolean),
        bytes: Number(/RssAnon:\t(\d+)/.exec(fs.read(`/proc/${pid}/status`)!)![1]) * 1024,
      };
    }),
  );
  const by = (name: string) => out.find((o) => o.name === name);
  assert.deepEqual(by("shell"), { group: "modules", name: "shell", bytes: 90 * MiB }, "Module は自分の分だけ");
  assert.deepEqual(by("npx playwright test"), { group: "commands", name: "npx playwright test", bytes: 501 * MiB }, "Module の子とその子はコマンド");
  assert.deepEqual(by("subagent"), { group: "modules", name: "subagent", bytes: 130 * MiB });
  assert.deepEqual(
    by("サブエージェント（Claude Code）"),
    { group: "work", name: "サブエージェント（Claude Code）", bytes: 620 * MiB },
    "アダプタ・CLI・その子は1つのサブエージェントにまとめる",
  );
  assert.equal(by("その他のプロセス")?.bytes, 10 * 1024);
});

test("1回測る：使っている量・キャッシュ・上限・内訳・混んでいるか・上限に当たった記録・この機械", async () => {
  const root = "/sys/fs/cgroup/lxc.payload.user-1000_banto-p1";
  const f: Record<string, string> = {
    [`${root}/memory.stat`]: "anon 8000000000\nfile 2000000000\nshmem 0\n",
    [`${root}/memory.max`]: "10000000000\n",
    [`${root}/memory.events`]: "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n",
    [`${root}/pids.current`]: "300\n",
    [`${root}/pids.max`]: "8192\n",
    [`${root}/pids.events`]: "max 0\n",
    [`${root}/cpu.stat`]: "usage_usec 1000000\n",
    [`${root}/cpu.max`]: "300000 100000\n",
    [`${root}/cpu.pressure`]: "some avg10=50.00 avg60=1 avg300=0 total=0\nfull avg10=2.00 avg60=1 avg300=0 total=0\n",
    [`${root}/memory.pressure`]: "some avg10=12.50 avg60=1 avg300=0 total=0\nfull avg10=1.00 avg60=1 avg300=0 total=0\n",
    [`${root}/io.pressure`]: "some avg10=0.00 avg60=0 avg300=0 total=0\n",
    [`${root}/.lxc/cgroup.procs`]: "10\n",
    [`${root}/user.slice/user-1000.slice/user@1000.service/app.slice/banto-mock.service/memory.stat`]: "anon 600000000\nfile 1\n",
    [`${root}/user.slice/user-1000.slice/user@1000.service/app.slice/banto-mock.service/cgroup.procs`]: "40\n",
    [`${root}/lxc.payload.user-1000_banto-nested/memory.stat`]: "anon 300000000\nfile 0\n",
    "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\n",
    "/proc/pressure/cpu": "some avg10=3.00 avg60=0 avg300=0 total=0\nfull avg10=0.00 avg60=0 avg300=0 total=0\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0 avg300=0 total=0\n",
    "/sys/fs/cgroup/system.slice/incus.service/memory.stat": "anon 400000000\nfile 0\n",
  };
  proc(f, 10, 1, ["/usr/local/bin/node", "/x/packages/modules/shell/dist/server.js"], 1000);
  proc(f, 40, 1, ["/bin/sh", "-c", "npx next dev -p 4173"], 1000);
  let now = 1_000_000;
  const w = new ResourceWatch({
    fs: fakeFs(f),
    incusProject: async () => "user-1000",
    cores: 4,
    selfBytes: () => 300_000_000,
    stalls: () => [{ endedAt: now - 1000, ms: 12_300 }],
    now: () => now,
  });
  const targets = [{ containerName: "banto-p1", projectId: "p1", name: "banto" }];
  let s = await w.tick(targets);
  const p = s.projects[0]!;
  assert.equal(p.usedBytes, 8_000_000_000);
  assert.equal(p.cacheBytes, 2_000_000_000);
  assert.equal(p.limitBytes, 10_000_000_000);
  assert.equal(p.cpuLimit, 3);
  assert.equal(p.cpuUsed, undefined, "最初の1回は差が無い");
  assert.equal(p.busy, true);
  assert.match(p.busyReason!, /メモリの空きを待つ時間が 13%/);
  assert.deepEqual(p.waiting, { cpu: 50, memory: 12.5, io: 0 });
  assert.deepEqual(p.hits, [], "最初に見た数えは基準にするだけ");
  assert.deepEqual(
    p.groups.map((g) => [g.id, g.items.map((i) => [i.name, i.detail ?? null])]),
    [
      ["modules", [["shell", null]]],
      ["services", [["mock", "npx next dev -p 4173"]]],
      ["nested", [["user-1000_banto-nested", null]]],
    ],
  );
  assert.equal(s.host.busy, false);
  assert.deepEqual(
    s.host.memory.map((m) => m.id),
    ["container:banto-p1", "banto", "incus", "other"],
  );
  assert.equal(s.host.stalls[0]!.seconds, 12.3);

  // 10 秒後：CPU を 2 コア分使い、OOM が 2 回増えた
  now += 10_000;
  f[`${root}/cpu.stat`] = "usage_usec 21000000\n";
  f[`${root}/memory.events`] = "oom_kill 3\n";
  s = await w.tick(targets);
  assert.equal(s.projects[0]!.cpuUsed, 2);
  assert.match(s.projects[0]!.hits[0]!.what, /プロセスが 2 個止められました/);
  assert.deepEqual(w.busySummary().projects.map((x) => x.projectId), ["p1"]);
  assert.deepEqual(await w.readEvents("banto-p1"), { oomKills: 3, pidsMax: 0 });
});

test("読めないコンテナ（止まっている）は飛ばす", async () => {
  const w = new ResourceWatch({ fs: fakeFs({}), incusProject: async () => "default", cores: 1, selfBytes: () => 0, stalls: () => [] });
  const s = await w.tick([{ containerName: "banto-x", projectId: "x", name: "x" }]);
  assert.deepEqual(s.projects, []);
});

test("中身：Shell の待たない形の単位はコマンドとして数える", () => {
  const root = "/c";
  const f: Record<string, string> = {
    [`${root}/user.slice/user-1000.slice/user@1000.service/app.slice/banto-shell-abc.service/memory.stat`]: "anon 50000000\n",
    [`${root}/user.slice/user-1000.slice/user@1000.service/app.slice/banto-shell-abc.service/cgroup.procs`]: "",
  };
  const groups = readConsumers(fakeFs(f), root);
  assert.deepEqual(groups.map((g) => g.id), ["commands"]);
  assert.equal(groups[0]!.items[0]!.name, "待たないコマンド abc");
});
