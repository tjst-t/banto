// **回が終わるのを見届けて、その回のコンテナとサーバを必ず片づける片づけ役**（追加・2026-10-01）。
//
// `globalTeardown` は Playwright が自分で終わるときにしか走らない。**外から殺された回は何も片づけない**
// ——2026-10-01、サブエージェントが `timeout 3000 npx playwright test` で回したフル E2E が 50 分で打ち切られ
// （exit=124）、コンテナ 50 台が動いたまま残って Project のコンテナを圧迫した。Playwright は webServer を
// 別のプロセスグループで起こすので、`timeout` の signal は webServer に届かず、画面のサーバ（`next start`）も
// 居残っていた（core が殺されずに残ることも実測した）。
//
// そこで core を起こすときに（`start-core.ts`）、**別のセッション（setsid）でこの片づけ役を起こしておく**。
// `timeout` や Ctrl-C はプロセスグループにしか届かないので、ここは巻き添えにならない。Playwright の pid が
// 居なくなったら（成功・失敗・打ち切り・SIGKILL のどれでも）：
//   1. core がまだ生きていればグループごと止める（生きたままだとコンテナを作り直す・触っていて消せない）
//   2. この回の画面のサーバ（その回の port の `next start`）が居残っていればグループごと止める
//   3. その回の札が付いたコンテナを全部消す
// これでも漏れたもの（この片づけ役ごと殺された等）は、次の回の `global-setup.ts` が拾う。
//
// 使い方：node run-reaper.ts <Playwright の pid> <core の pid> <データの置き場> <画面の port>
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAlive, killProcessGroups, listOwnedContainers, removeContainers, sleepSync, waitGone } from "./containers.ts";

const [playwrightPid, corePid] = [Number(process.argv[2]), Number(process.argv[3])];
const dataDir = process.argv[4];
const frontendPort = Number(process.argv[5]);
if (!Number.isInteger(playwrightPid) || !Number.isInteger(corePid) || !dataDir || !Number.isInteger(frontendPort)) {
  console.error("使い方：node run-reaper.ts <Playwright の pid> <core の pid> <データの置き場> <画面の port>");
  process.exit(2);
}

const logFile = join(dirname(dataDir), "reaper.log");
const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

log(`[e2e] 片づけ役：Playwright ${playwrightPid} の終わりを待つ（core ${corePid}）`);
while (isAlive(playwrightPid)) sleepSync(2000);
log(`[e2e] Playwright ${playwrightPid} が終わった`);

if (isAlive(corePid)) {
  log(`[e2e] core ${corePid} が残っているので止める`);
  // core はふつう自分のグループの頭（Playwright が webServer を別グループで起こす）。グループごと送る
  for (const target of [-corePid, corePid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // そのグループは無い・もう居ない
    }
  }
  if (!waitGone(corePid, 10_000)) {
    try {
      process.kill(corePid, "SIGKILL");
    } catch {
      // もう居ない
    }
    waitGone(corePid, 5_000);
  }
}

// 画面のサーバ。port は回ごとに違う（`config.ts` の portForRun）ので、別の回のものは巻き込まない
const frontendServer = new RegExp(`next start .*-p ${frontendPort}(\\s|$)`);
killProcessGroups((cmd) => frontendServer.test(cmd), log);

let mine: string[];
try {
  mine = listOwnedContainers().filter((c) => c.owner === dataDir).map((c) => c.name);
} catch (err) {
  log(`[e2e] コンテナの一覧を読めず、片づけられませんでした：${(err as Error).message}（次の回が片づける）`);
  process.exit(1);
}
const failed = removeContainers(mine, log);
log(`[e2e] 片づけ役：${mine.length - failed.length} 台を消した${failed.length ? `、${failed.length} 台は消せなかった（次の回が片づける）` : ""}`);
