import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuJiffies, remoteResourcesOf, remoteUnitKind } from "./remote-resources.js";

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
