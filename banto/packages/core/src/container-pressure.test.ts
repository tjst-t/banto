import { test } from "node:test";
import assert from "node:assert/strict";
import { ContainerPressureWatch, type PressureCounts, type PressureNotice } from "./container-pressure.js";

function setup() {
  const counts = new Map<string, PressureCounts | undefined>();
  const notices: PressureNotice[] = [];
  const watch = new ContainerPressureWatch({
    read: async (name) => counts.get(name),
    notify: async (n) => notices.push(n),
    describeLimits: () => "メモリ 11 GiB・CPU 3 コア分・プロセス 8192",
  });
  return { counts, notices, watch };
}
const T = [{ containerName: "banto-p1", projectId: "p1" }];

test("最初に見た値は基準にするだけで、増えたときだけ知らせる", async () => {
  const { counts, notices, watch } = setup();
  counts.set("banto-p1", { oomKills: 13, pidsMax: 0 });
  await watch.tick(T);
  assert.equal(notices.length, 0, "起こし直すたびに昔の分を言い直している");
  await watch.tick(T);
  assert.equal(notices.length, 0);
  counts.set("banto-p1", { oomKills: 15, pidsMax: 1 });
  await watch.tick(T);
  assert.deepEqual(notices.map((n) => [n.projectId, n.dedupeKey]), [
    ["p1", "container-oom:banto-p1"],
    ["p1", "container-pids:banto-p1"],
  ]);
  assert.match(notices[0]!.detail, /2 個のプロセス/);
  assert.match(notices[0]!.detail, /いまの上限：メモリ 11 GiB/);
});

test("コンテナを起こし直して数えが戻ったら、その値を新しく増えた分にする。読めなければ飛ばす", async () => {
  const { counts, notices, watch } = setup();
  counts.set("banto-p1", { oomKills: 5, pidsMax: 0 });
  await watch.tick(T);
  counts.set("banto-p1", { oomKills: 1, pidsMax: 0 });
  await watch.tick(T);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.detail, /1 個のプロセス/);
  counts.set("banto-p1", undefined);
  await watch.tick(T);
  assert.equal(notices.length, 1);
});
