/**
 * `kobo.list` の既定は「まだ見る必要があるもの」（prop-0001 第1段・PO 裁定 2026-08-08）。
 *
 * **困っていたこと**：終わったタスクは消えない（保持期間による削除は未実装）ので、
 * 積み上がって 100 件の枠を埋め、**動いているタスクを押し出す**。実機で 340 件のうち
 * 100 件しか出ない状態になっていた。
 *
 * **何も捨てずに直す**：既定から外すのは**片が付いたもの**だけ
 * （`merged` / `closed` / `superseded` / `evaluating`）。見たいときは
 * `state: "all"` か状態名で指定すれば出る。
 *
 * **`failed` は既定に残す。** 「終わった」と「止まっている」は違う——終端だからと
 * 外すと、**落ちたタスクが一番忘れられやすい**という逆の結果になる。実際に
 * loamium の task-0004 / 0005 はマージ前ゲートで failed になったまま、
 * 誰の既定の視界にも入っていなかった。
 *
 * 直しを戻すと落ちることを確認済み。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (a === null || typeof a === "string") { reject(new Error("no port")); return; }
      const { port } = a;
      s.close(() => resolve(port));
    });
  });
}

const PROJ = "listproj";
let daemon: Daemon;
let tmpDir: string;
let call: (args: Record<string, unknown>) => Promise<{
  tasks: Array<{ taskId: string; status: string }>;
  total: number;
}>;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-list-default-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  daemon = Daemon.create({
    port: await freePort(),
    dataDir: path.join(tmpDir, "data"),
    watchIntervalMs: 99999,
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  // 4本積んで、それぞれ違う終わり方へ持っていく
  for (const id of ["task-active", "task-failed", "task-merged", "task-closed"]) {
    daemon.createTask(PROJ, id, id);
    const q = daemon.transition(PROJ, id, "queued", "テスト：積む");
    assert.equal(q.ok, true, `${id} を queued にできなかった: ${JSON.stringify(q)}`);
  }

  // active はそのまま（queued）。他は終端へ
  daemon.transition(PROJ, "task-failed", "failed", "テスト：落ちた形にする");
  for (const [id, path_] of [
    ["task-merged", ["ready", "planning", "implementing", "auditing", "review-ready", "in-review", "approved", "merging", "merged"]],
    ["task-closed", ["ready", "planning", "implementing", "auditing", "review-ready", "in-review", "approved", "merging", "merged", "evaluating", "closed"]],
  ] as const) {
    for (const to of path_) {
      const r = daemon.transition(PROJ, id, to, "テスト：終端まで進める");
      assert.equal(r.ok, true, `${id} → ${to} に進めなかった: ${JSON.stringify(r)}`);
    }
  }

  const tools = createKoboTools(daemon);
  const list = tools.find((t) => t.name === "kobo.list");
  assert.ok(list, "kobo.list があること");
  call = async (args) => {
    const r = await list.execute(args as never, { toolCallId: "t" });
    return (r.details ?? {}) as never;
  };
});

after(async () => {
  await daemon.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[prop-0001 第1段] kobo.list の既定は「まだ見る必要があるもの」", () => {
  it("片が付いたもの（merged / closed）は既定では出ない", async () => {
    const { tasks } = await call({ projectTag: PROJ });
    const ids = tasks.map((t) => t.taskId);
    // **ここが本体**。直す前は state 未指定でも merged / closed が枠を食っていた
    assert.equal(ids.includes("task-merged"), false, `merged が既定に出ている: ${ids.join(",")}`);
    assert.equal(ids.includes("task-closed"), false, `closed が既定に出ている: ${ids.join(",")}`);
  });

  it("**failed は既定に残る**（終端だが、放っておいてよいものではない）", async () => {
    const { tasks } = await call({ projectTag: PROJ });
    const ids = tasks.map((t) => t.taskId);
    assert.equal(
      ids.includes("task-failed"),
      true,
      "落ちたタスクを既定から外すと、一番忘れられやすいものが見えなくなる（loamium/task-0004・0005）"
    );
  });

  it("動いているものは当然出る", async () => {
    const { tasks } = await call({ projectTag: PROJ });
    assert.equal(tasks.map((t) => t.taskId).includes("task-active"), true);
  });

  it("state: \"all\" なら片が付いたものも出る（隠しただけで捨てていない）", async () => {
    const { tasks } = await call({ projectTag: PROJ, state: "all" });
    const ids = tasks.map((t) => t.taskId);
    for (const id of ["task-active", "task-failed", "task-merged", "task-closed"]) {
      assert.equal(ids.includes(id), true, `state:all で ${id} が出ない: ${ids.join(",")}`);
    }
  });

  it("状態名を指定すれば片が付いたものだけも見られる", async () => {
    const { tasks } = await call({ projectTag: PROJ, state: "merged" });
    assert.deepEqual(tasks.map((t) => t.taskId), ["task-merged"]);
  });

  it("既定の total は、隠したぶんを含まない（見えている母数と一致する）", async () => {
    const shown = await call({ projectTag: PROJ });
    const all = await call({ projectTag: PROJ, state: "all" });
    // total は「絞り込みに一致した件数」。既定と all で違うのが正しい
    // ——ここが all の件数のままだと、札の `n / total` が意味を失う
    assert.equal(shown.total, shown.tasks.length);
    assert.ok(all.total > shown.total, `all(${all.total}) は既定(${shown.total}) より多いはず`);
  });
});
