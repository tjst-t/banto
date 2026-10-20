import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOTE_RESOURCE_PROBE, cpuJiffies, remoteContainerCounts, remoteResourcesOf, remoteUnitKind } from "./remote-resources.js";
import { spawnSync } from "node:child_process";

const MB = 1024 * 1024;
const P = "2ced47c4-d4dc-40f3-a6fe-7d2d86a07b89";

test("向こうの単位を内訳に振り分ける：起動役が包んだ Module・Terminal・ほかは手元と同じ", () => {
  assert.deepEqual(remoteUnitKind(`banto-mod-shell-${P}.service`), { group: "modules", name: "shell" });
  assert.deepEqual(remoteUnitKind(`banto-mod-vault-local-${P}.service`), { group: "modules", name: "vault-local" });
  assert.deepEqual(remoteUnitKind("banto-terminal-d929fbdf.scope"), { group: "commands", name: "Terminal" });
  assert.deepEqual(remoteUnitKind("banto-subagent-61da8065.scope"), { group: "work", name: "サブエージェント" });
  assert.deepEqual(remoteUnitKind("banto-mock-schedule.service"), { group: "services", name: "mock-schedule" });
  assert.equal(remoteUnitKind("dbus.service"), undefined);
});

test("/proc/stat の cpu の行から、動いていた時間と全部の時間", () => {
  assert.deepEqual(cpuJiffies("cpu  100 0 50 800 50 0 0 0 0 0"), { busy: 150, total: 1000 });
  assert.equal(cpuJiffies("intr 1 2"), undefined);
});

test("1回の読み取りを形にする：機械の全体・banto の分とそれ以外・内訳・CPU（2回目から）・混み具合", () => {
  const raw = (stat: string) => ({
    meminfo: `MemTotal: ${64000 * 1024} kB\nMemAvailable: ${4000 * 1024} kB\n`,
    pressure: { memory: "some avg10=12.00 avg60=1 avg300=0 total=0\n", cpu: "some avg10=3.00 avg60=0 avg300=0 total=0\nfull avg10=0.00 avg60=0 avg300=0 total=0\n" },
    cores: 16,
    stat,
    user: `anon ${3000 * MB}\nshmem 0\nkernel ${100 * MB}\nfile 0\n`,
    units: [
      { unit: `banto-mod-shell-${P}.service`, stat: `anon ${50 * MB}\n`, cmd: ["/x/node", "/x/banto-launcher.mjs", "--inner", "/run/s.sock"] },
      { unit: "banto-subagent-1a2b3c4d.scope", stat: `anon ${2000 * MB}\n`, cmd: ["/bin/sh", "-c", "…", "banto-work", "/x/node", "/x/claude-agent-acp/dist/index.js"] },
      { unit: "banto-shell-c3a89b55.scope", stat: `anon ${900 * MB}\n`, cmd: ["/bin/sh", "-c", "…", "banto-work", "/bin/sh", "-c", "npm ci"] },
      { unit: "banto-mock.service", stat: `anon ${150 * MB}\n`, cmd: ["/x/node", "/x/log-wrapper.js", "/d"] },
      { unit: "dbus.service", stat: `anon 4096\n` },
      { unit: "init.scope", stat: `anon ${5 * MB}\n` },
    ].map((u) => ({ cmd: [] as string[], ...u })),
  });
  const projects = [{ projectId: P, name: "Banto開発" }];
  const first = remoteResourcesOf({ runtime: "vm", address: "ubuntu@vm", raw: raw("cpu 100 0 0 900 0 0 0 0 0 0") }, projects, undefined);
  assert.equal(first.resources.cpuUsed, undefined, "最初の1回は差が無い");
  const { resources: r } = remoteResourcesOf({ runtime: "vm", address: "ubuntu@vm", raw: raw("cpu 900 0 0 1100 0 0 0 0 0 0") }, projects, first.cpu);
  assert.equal(r.cpuUsed, 12.8, "全体の 80% × 16 コア");
  assert.equal(r.bantoBytes, 3100 * MB);
  assert.equal(r.otherBytes, 60000 * MB - 3100 * MB);
  assert.equal(r.busy, true);
  assert.match(r.busyReason!, /メモリの空きを待つ時間が 12%/);
  assert.deepEqual(
    r.groups.map((g) => [g.id, g.items.map((i) => [i.name, i.detail ?? null])]),
    [
      ["modules", [["shell", null]]],
      ["work", [["サブエージェント", null]]],
      ["commands", [["コマンド", "npm ci"]]],
      ["services", [["mock", null]]],
    ],
    "包み役しか見えないものは中身を出さない・1MB 未満と init.scope は出さない",
  );
});

test("読めなかった実行場所は理由だけを出す", () => {
  const { resources } = remoteResourcesOf({ runtime: "vm", address: "ubuntu@vm", unavailable: "繋いでいません" }, [], undefined);
  assert.deepEqual(resources, { runtime: "vm", address: "ubuntu@vm", projects: [], groups: [], busy: false, unavailable: "繋いでいません" });
});

test("containers：Project のコンテナの中の単位を Project の名前を添えて数え、banto の分にコンテナの分を足す。ほかの banto のコンテナは数えない", () => {
  const Q = "0b6e8c2a-1f3d-4e5a-9b7c-123456789abc";
  const unit = (u: string, mb: number, cmd: string[] = []) => ({ unit: u, stat: `anon ${mb * MB}\n`, cmd });
  const raw = {
    meminfo: `MemTotal: ${32000 * 1024} kB\nMemAvailable: ${20000 * 1024} kB\n`,
    pressure: {},
    cores: 8,
    stat: "cpu 100 0 0 900 0 0 0 0 0 0",
    user: `anon ${10 * MB}\n`,
    units: [],
    containers: [
      {
        name: `banto-${P}`,
        stat: `anon ${3000 * MB}\nkernel ${100 * MB}\n`,
        events: "low 0\nhigh 0\nmax 4\noom 1\noom_kill 2\n",
        pidsEvents: "max 3\n",
        memoryMax: `${8 * 1024 ** 3}\n`,
        pidsMax: "8192\n",
        units: [unit(`banto-mod-shell-${P}.service`, 80), unit("banto-shell-c3a89b55.scope", 900, ["/bin/sh", "-c", "…", "banto-work", "/bin/sh", "-c", "npm test"]), unit("init.scope", 30)],
      },
      { name: `banto-${Q}`, stat: `anon ${500 * MB}\n`, events: "oom_kill 0\n", pidsEvents: "max 0\n", memoryMax: "max\n", pidsMax: "max\n", units: [unit(`banto-mod-files-${Q}.service`, 40)] },
      // 同じ VM のほかの banto（別のデータの置き場）のコンテナ——この banto の Project ではない
      { name: "banto-zzzz", stat: `anon ${7000 * MB}\n`, units: [unit("banto-mod-x-zzzz.service", 70)] },
    ],
  };
  const projects = [
    { projectId: P, name: "A", containerName: `banto-${P}` },
    { projectId: Q, name: "B", containerName: `banto-${Q}` },
  ];
  const { resources: r } = remoteResourcesOf({ runtime: "vm", address: "u@vm", raw }, projects, undefined);
  assert.deepEqual(r.projects, [{ projectId: P, name: "A" }, { projectId: Q, name: "B" }], "画面に返す Project にコンテナの名前を混ぜた");
  assert.equal(r.bantoBytes, 10 * MB + 3100 * MB + 500 * MB, "コンテナの分を banto の分に数えていない（ほかの banto のコンテナを数えた）");
  assert.deepEqual(
    r.groups.map((g) => [g.id, g.items.map((i) => [i.name, i.detail ?? null])]),
    [
      ["modules", [["shell（A）", null], ["files（B）", null]]],
      ["commands", [["コマンド（A）", "npm test"]]],
    ],
  );
  // 上限に当たった数えと上限（見張りが使う）。max（無制限）は上限に入れない。数えの無いものは入れない
  const counts = remoteContainerCounts(raw);
  assert.deepEqual(counts.get(`banto-${P}`), { oomKills: 2, pidsMax: 3, limits: { memoryBytes: 8 * 1024 ** 3, processes: 8192 } });
  assert.deepEqual(counts.get(`banto-${Q}`), { oomKills: 0, pidsMax: 0, limits: {} });
  assert.equal(counts.has("banto-zzzz"), false);
});

test("向こうの読み取りの台本は、この機械の node でも JSON を返す（コンテナが無ければ containers は空）", () => {
  const r = spawnSync(process.execPath, ["-"], { input: REMOTE_RESOURCE_PROBE, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { containers?: unknown[]; units: unknown[] };
  assert.ok(Array.isArray(out.containers));
  assert.ok(Array.isArray(out.units));
});
