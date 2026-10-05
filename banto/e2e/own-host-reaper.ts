// **自前の host（`own-host.ts`）の片づけ役**（追加・2026-10-05、`run-reaper.ts` と同じ考え方）。
//
// spec は自前の host を自分のプロセスグループで起こす（detached）ので、Playwright が外から殺されても（`timeout` の
// 打ち切り・Ctrl-C・SIGKILL）host には信号が届かず、親を失って残る。spec の `finally` も走らない。そこで host を
// 起こす前に、**別のセッションでこの片づけ役を起こしておく**。spec の worker が居なくなったら：
//   1. host のプロセスグループを止める（pid は置き場の `host.pid`。起こし直すたびに書き換わる）
//   2. その置き場の札が付いたコンテナを消す
//   3. 置き場を消す
// 置き場が先に消えたら（spec がふつうに `close` した）何もせずに終わる。これでも漏れたもの（この片づけ役ごと殺された
// 等）は、次の回の `global-setup.ts` が拾う（置き場が `E2E_OWNER` の形）。
//
// 使い方：node own-host-reaper.ts <worker の pid> <自前の host の置き場>
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isAlive, isGroupAlive, listOwnedContainers, removeContainers, sleepSync } from "./containers.ts";

const workerPid = Number(process.argv[2]);
const dir = process.argv[3];
if (!Number.isInteger(workerPid) || !dir) {
  console.error("使い方：node own-host-reaper.ts <worker の pid> <自前の host の置き場>");
  process.exit(2);
}
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

while (isAlive(workerPid) && existsSync(dir)) sleepSync(1000);
if (!existsSync(dir)) process.exit(0);
log(`[e2e] 自前の host（${dir}）を残したまま worker ${workerPid} が居なくなった——片づける`);

let pgid: number | undefined;
try {
  pgid = Number(readFileSync(join(dir, "host.pid"), "utf8").trim());
} catch {
  // まだ起こしていない
}
if (pgid !== undefined && isGroupAlive(pgid)) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // もう居ない
    }
    for (let i = 0; i < 50 && isGroupAlive(pgid); i++) sleepSync(200);
    if (!isGroupAlive(pgid)) break;
  }
  log(isGroupAlive(pgid) ? `[e2e] host のグループ ${pgid} が止まりません` : `[e2e] host のグループ ${pgid} を止めた`);
}

const dataDir = join(dir, "data");
try {
  const mine = listOwnedContainers().filter((c) => c.owner === dataDir).map((c) => c.name);
  const failed = removeContainers(mine, log);
  if (failed.length > 0) log(`[e2e] ${failed.length} 台は消せなかった（次の回が片づける）`);
} catch (err) {
  log(`[e2e] コンテナの一覧を読めず、片づけられませんでした：${(err as Error).message}（次の回が片づける）`);
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch (err) {
  log(`[e2e] 置き場 ${dir} を消せませんでした：${(err as Error).message}`);
}
