/**
 * 第2便: **滞留を帳簿から導出して知らせる**（rethink C-3 第1手）。
 *
 * **困っていたこと**：状態は「いつからその状態なのか」を持っていなかった。だから
 * 何日詰まっていても誰も気づけない——実測で 19.2h / 28.6h / 16.8h の滞留があり、
 * task-0100 の 19.2 時間は「`blockedBy` が 18 時間変わらなかった」というだけの
 * 事実だったのに、それを言える機構が無かった。
 *
 * 入れたもの:
 *   - `banto-core/dwell.ts` … 滞在時間・最後に見えた変化・契約の版を**帳簿から導出**
 *   - `daemon` の tick `dwell-watch` … 閾値を超えたら `task_stalled` を積む
 *   - `kobo.list` / `kobo.task` に滞在時間
 *
 * **必ず守ること**：`task_stalled` は**同じ状態のあいだ二度鳴らない**。
 * 鳴り続ける知らせは読まれなくなり、知らせないのと同じになる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import {
  DEFAULT_DWELL_WARN_MINUTES,
  dwellMs,
  stateEnteredAt,
  lastObservableChangeAt,
  stalledAlreadyRecorded,
  contractVersionOf,
  formatDwell,
} from "../../packages/banto-core/src/index.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const PROJ = "dwellproj";
const HOUR = 60 * 60 * 1000;

let daemon: Daemon;
let tmpDir: string;
let repoDir: string;
let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** タスクを1つ作り、指定の状態まで運ぶ。 */
function driveTo(taskId: string, states: string[]): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動く" }],
  });
  for (const to of states) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
}

/** そのタスクの `task_stalled` を数える。 */
function stalledEvents(taskId: string): Array<Record<string, unknown>> {
  return daemon
    .getTaskEvents(PROJ, taskId)
    .filter((e) => e.type === "task_stalled") as unknown as Array<Record<string, unknown>>;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-dwell-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    disableMergeQueue: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const tools = createKoboTools(daemon);
  call = async (name, args) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool: ${name}`);
    const r = await t.execute(args as never, { toolCallId: "t" });
    return (r.details ?? {}) as Record<string, unknown>;
  };
});

after(async () => {
  await daemon.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[第2便] 滞留は帳簿から導出する（保存しない・D3）", () => {
  it("いまの状態に入った時刻＝最後の state_transitioned。滞在時間はそこから", () => {
    const id = "task-3001";
    driveTo(id, ["queued"]);
    const events = daemon.getProjectEvents(PROJ);

    const enteredAt = stateEnteredAt(events, PROJ, id);
    assert.ok(enteredAt, "状態に入った時刻が導出できない");
    const transitions = events.filter(
      (e) => e.type === "state_transitioned" && (e as { taskId?: string }).taskId === id
    );
    assert.equal(enteredAt, transitions[transitions.length - 1]!.timestamp);

    // 3時間後に測れば 3時間（時計は渡せる。19時間待たない・I1）
    const now = Date.parse(enteredAt) + 3 * HOUR;
    assert.equal(dwellMs(events, PROJ, id, now), 3 * HOUR);
  });

  it("一度も動いていないタスクでも測れる（task_created を起点に落ちる）", () => {
    const id = "task-3002";
    daemon.createTask(PROJ, id, id, {
      kind: "feature",
      scope: { paths: ["src/x/**"] },
      acceptance: [{ id: "a1", text: "動く" }],
    });
    const events = daemon.getProjectEvents(PROJ);
    assert.ok(stateEnteredAt(events, PROJ, id), "task_created を起点にできていない");
  });

  it("**分からないときは 0 を返さない**（入ったばかりと混同すると閾値が静かに緩む）", () => {
    const events = daemon.getProjectEvents(PROJ);
    assert.equal(dwellMs(events, PROJ, "task-9999", Date.now()), undefined);
    assert.equal(stateEnteredAt(events, PROJ, "task-9999"), undefined);
  });

  it("最後に**外から見える変化**があった時刻を、状態遷移と別に読める", () => {
    const id = "task-3003";
    driveTo(id, ["queued", "ready"]);
    const events = daemon.getProjectEvents(PROJ);
    // まだ職人を起こしていないので、見える変化＝最後の遷移
    assert.equal(
      lastObservableChangeAt(events, PROJ, id),
      stateEnteredAt(events, PROJ, id)
    );
  });

  it("人が読む長さに直せる", () => {
    assert.equal(formatDwell(30 * 60_000), "30分");
    assert.equal(formatDwell(3 * HOUR), "3時間");
    assert.equal(formatDwell(3 * HOUR + 20 * 60_000), "3時間20分");
    assert.equal(formatDwell(50 * HOUR), "2日2時間");
  });
});

describe("[第2便] 閾値を超えたら task_stalled を積む", () => {
  it("既定の閾値（queued 120分）を超えると積まれる。実測値と閾値の両方が残る", () => {
    const id = "task-3010";
    driveTo(id, ["queued"]);

    // 閾値の手前では鳴らない
    const enteredAt = Date.parse(stateEnteredAt(daemon.getProjectEvents(PROJ), PROJ, id)!);
    daemon.runDwellWatch(enteredAt + 60 * 60_000);
    assert.equal(stalledEvents(id).length, 0, "閾値の手前で鳴っている");

    // 超えたら鳴る
    daemon.runDwellWatch(enteredAt + 5 * HOUR);
    const stalled = stalledEvents(id);
    assert.equal(stalled.length, 1, `1件だけ積まれること（実際: ${stalled.length}）`);
    assert.equal(stalled[0]!["status"], "queued");
    assert.equal(stalled[0]!["dwellMs"], 5 * HOUR, "測った実測値がそのまま残る");
    assert.equal(
      stalled[0]!["thresholdMs"],
      DEFAULT_DWELL_WARN_MINUTES["queued"]! * 60_000,
      "**当時の閾値**が残る（後で閾値を変えても、当時の判断が読める）"
    );
    assert.ok(typeof stalled[0]!["lastChangeAt"] === "string");
  });

  it("**同じ状態のあいだ二度鳴らない**（鳴り続ける知らせは読まれなくなる）", () => {
    const id = "task-3010";
    const enteredAt = Date.parse(stateEnteredAt(daemon.getProjectEvents(PROJ), PROJ, id)!);
    // 何度回しても増えない
    daemon.runDwellWatch(enteredAt + 6 * HOUR);
    daemon.runDwellWatch(enteredAt + 24 * HOUR);
    daemon.runDwellWatch(enteredAt + 100 * HOUR);
    assert.equal(stalledEvents(id).length, 1, "同じ状態で鳴り直している");
  });

  it("状態が動けばまた鳴る（印は帳簿が持つ。再起動で消える印を手元に持たない）", () => {
    const id = "task-3010";
    assert.equal(daemon.transition(PROJ, id, "ready", "先へ").ok, true);
    assert.equal(daemon.transition(PROJ, id, "planning", "先へ").ok, true);
    assert.equal(daemon.transition(PROJ, id, "implementing", "先へ").ok, true);

    const events = daemon.getProjectEvents(PROJ);
    assert.equal(
      stalledAlreadyRecorded(events, PROJ, id),
      false,
      "状態が動いたのに「もう鳴らした」のまま"
    );

    const enteredAt = Date.parse(stateEnteredAt(events, PROJ, id)!);
    daemon.runDwellWatch(enteredAt + 5 * HOUR);
    assert.equal(stalledEvents(id).length, 2, "新しい状態で鳴っていない");
    assert.equal(stalledEvents(id)[1]!["status"], "implementing");
  });

  it("**見張らない状態では鳴らない**（通り過ぎるだけの ready で鳴らしても、できることが無い）", () => {
    const id = "task-3011";
    driveTo(id, ["queued", "ready"]);
    const enteredAt = Date.parse(stateEnteredAt(daemon.getProjectEvents(PROJ), PROJ, id)!);
    daemon.runDwellWatch(enteredAt + 1000 * HOUR);
    assert.equal(stalledEvents(id).length, 0, "閾値を持たない状態で鳴っている");
  });

  it("層B設定 `limits.dwell_warn_minutes` で閾値を上書きできる", () => {
    fs.writeFileSync(
      path.join(repoDir, "meta", "config.yaml"),
      ["---", "limits:", "  dwell_warn_minutes:", "    ready: 30", "---", ""].join("\n"),
      "utf-8"
    );
    const id = "task-3012";
    driveTo(id, ["queued", "ready"]);
    const enteredAt = Date.parse(stateEnteredAt(daemon.getProjectEvents(PROJ), PROJ, id)!);

    daemon.runDwellWatch(enteredAt + 20 * 60_000);
    assert.equal(stalledEvents(id).length, 0, "設定した閾値の手前で鳴っている");
    daemon.runDwellWatch(enteredAt + 40 * 60_000);
    assert.equal(stalledEvents(id).length, 1, "設定した閾値を超えても鳴らない");
    fs.rmSync(path.join(repoDir, "meta", "config.yaml"));
  });

  it("`kobo.list` と `kobo.task` に滞在時間が出る", async () => {
    const list = await call("kobo.list", { projectTag: PROJ, state: "queued" });
    const rows = list["tasks"] as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0, "queued のタスクが無い");
    assert.ok(
      rows.every((r) => typeof r["since"] === "string"),
      "一覧に滞在時間が無い（詰まっているものと通り過ぎているものが同じ顔で並ぶ）"
    );

    const detail = await call("kobo.task", { projectTag: PROJ, taskId: "task-3010" });
    const history = detail["history"] as Array<Record<string, unknown>>;
    const stalledRow = history.find((h) => h["type"] === "task_stalled");
    assert.ok(stalledRow, "経緯に task_stalled が出ていない");
    assert.match(String(stalledRow["detail"]), /のまま/);
  });
});

describe("[第2便・段1] 契約の版は帳簿から導出する（新しく持たない）", () => {
  it("改訂が無ければ task_created の eventId、改訂があればその eventId", () => {
    const id = "task-3020";
    driveTo(id, ["queued"]);
    const events = daemon.getProjectEvents(PROJ);
    const created = events.find(
      (e) => e.type === "task_created" && (e as { taskId?: string }).taskId === id
    )!;
    assert.equal(
      contractVersionOf(events, PROJ, id),
      created.eventId,
      "契約の版が task_created を指していない"
    );
  });
});
