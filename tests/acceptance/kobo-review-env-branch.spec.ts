/**
 * 段11c-2 の回帰（報告 `2026-08-13-kobo-vs-po-intent.md` A-6 (3)）。
 *
 * **PO が触るレビュー用の環境は、タスクのブランチを映さなければならない。**
 *
 * 直す前の姿：マージ前ゲートの経路（`gateVerifyRunner`）は `workdir`（タスクのワークツリー）を
 * 渡していたのに、レビュー用の経路（`provisionEnv`）だけが渡していなかった。
 * Environment Pool は `workdir` を埋めず、ドライバは `workdir ?? repoPath` に落ちる
 * ——つまり**立っていたのは main のチェックアウト**で、実測でも「人が触る環境」6件のうち
 * タスクのワークツリーを映したものは 1 件も無かった。
 *
 * **これは実害が出るまで誰も気づけない種類の穴である。** 環境が立たなければ開いて気づくが、
 * 「立っているが中身が main」は開いても気づけない——PO は変更が映っていない画面を見て承認する。
 * だから**中身まで**見る：ブランチにしか無い内容が、立った環境の中から読めること。
 *
 * ついでに同じ場所で段11c-1（宣言が無ければ既定へ落ちる）と
 * 段11c-3（発火点は `review-ready`）も見る——3つとも「配線はあるのに動いていなかった」不具合。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import {
  EnvironmentPool,
  EnvironmentPoolService,
  createEnvTools,
} from "@banto/environment-pool";

// imp-0012: テスト用の一時 state に隔離
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-review-branch.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("待っていた状態にならなかった");
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/**
 * 立った環境の中から「いま居る場所の `marker.txt`」を書き出すプロファイル。
 *
 * **`workdir` が渡っていなければ、この `cat` は当たらない**（Environment Pool の
 * プロセスの cwd を継承する）。当たったとしても中身は main のものになる。
 */
const PROFILE =
  "profiles:\n" +
  "  dev:\n" +
  "    driver: process\n" +
  "    config:\n" +
  "      cmd: sh -c 'cat marker.txt > seen.txt; sleep 120'\n" +
  "    ttl: 1h\n";

const PROJ = "branch-env-proj";
const TASK = "task-0001";

let daemon: Daemon;
let pool: EnvironmentPool;
let service: EnvironmentPoolService;
let tmpDir: string;
let repoDir: string;
let worktreePath: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-review-branch-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  // main には "main"、タスクのブランチには "branch"。**どちらを映したかが1文字で分かる**
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "meta", "environments.yaml"), PROFILE, "utf-8");
  // 段11c-1: `environment` を宣言しないタスクの落ち先
  fs.writeFileSync(path.join(repoDir, "meta", "config.yaml"), "verify:\n  profile: dev\n", "utf-8");
  fs.writeFileSync(path.join(repoDir, "marker.txt"), "main", "utf-8");
  git(["add", "-A"], repoDir);
  git(["commit", "-m", "init"], repoDir);

  const worktreeBase = path.join(tmpDir, "worktrees");
  worktreePath = path.join(worktreeBase, PROJ, TASK);
  git(["worktree", "add", "-b", `task/${TASK}`, worktreePath], repoDir);
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "branch", "utf-8");
  git(["add", "-A"], worktreePath);
  git(["commit", "-m", "ブランチでしか入っていない変更"], worktreePath);

  pool = new EnvironmentPool({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "kobo-review-branch-pool-")),
    driverTimeoutMs: 20_000,
  });
  service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

  daemon = Daemon.create({
    port: await freePort(),
    dataDir: path.join(tmpDir, "data"),
    watchIntervalMs: 99999,
    tickIntervalMs: 300,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: worktreeBase,
    environmentPoolUrl: service.baseUrl,
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);
});

after(async () => {
  await daemon.stop();
  await service.close();
  pool.stopMaintenance();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

describe("[段11c] PO が触るレビュー用の環境は、ブランチを映す", () => {
  before(async () => {
    // **`environment` は宣言しない**（段11c-1：実測 70 本中 0 本だったのが既定の姿）
    daemon.createTask(PROJ, TASK, "UI を変える", {
      kind: "feature",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動く" }],
    });
    daemon.transition(PROJ, TASK, "queued", "test");
    await until(() => daemon.getTask(PROJ, TASK)?.status === "ready");
    for (const to of ["planning", "implementing", "auditing", "review-ready"]) {
      const r = daemon.transition(PROJ, TASK, to, "test");
      assert.equal(r.ok, true, `${to} へ動かせない: ${JSON.stringify(r)}`);
    }
    await until(() => daemon.getTaskEvents(PROJ, TASK).some((e) => e.type === "env_provisioned"));
  });

  /**
   * **段11c-3。** 以前の発火点は `in-review` だったが、`approveTask` が
   * review-ready → in-review → approved を同じ同期呼び出しで進めるため、
   * in-review の滞在時間は実測で中央値 0.01 秒——立ち上がる頃には必ず終わっていた。
   */
  it("発火点は review-ready（判断待ちが始まったとき）。in-review を通らなくても立つ", () => {
    const status = daemon.getTask(PROJ, TASK)?.status;
    assert.equal(status, "review-ready", "in-review へは進めていない（前提）");
    assert.equal(pool.list({ taskId: TASK }).length, 1, "判断待ちの間に環境が在ること");
  });

  it("[段11c-1] `environment` の宣言が無くても、層B設定の検証プロファイルで立つ", () => {
    assert.equal(pool.list({ taskId: TASK })[0]!.profile, "dev");
  });

  /**
   * **これが回帰の本体。** 台帳に残る `workdir` が「タスクのワークツリー」であること
   * ——`repoPath`（main のチェックアウト）ではないこと。
   */
  it("[段11c-2] 立てるとき `workdir` にタスクのワークツリーを渡している", () => {
    const live = pool.list({ taskId: TASK });
    assert.equal(live.length, 1);
    assert.equal(
      live[0]!.workdir,
      worktreePath,
      "workdir がタスクのワークツリーでない——ドライバは workdir ?? repoPath に落ちるので main が立つ"
    );
    assert.notEqual(live[0]!.workdir, repoDir, "main のチェックアウトを映してはいけない");
  });

  /**
   * 台帳の値だけでは「渡した」ことしか言えない。**実際に動いた場所**まで見る
   * ——環境の中のプロセスが読んだ `marker.txt` は、ブランチのものか main のものか。
   */
  it("[段11c-2] 環境の中から見えるのは**ブランチの中身**（main ではない）", async () => {
    const seen = path.join(worktreePath, "seen.txt");
    await until(() => fs.existsSync(seen));
    assert.equal(
      fs.readFileSync(seen, "utf-8").trim(),
      "branch",
      "環境の中で見えているのが main の中身——PO は変更が映っていない画面を承認することになる"
    );
    assert.equal(
      fs.existsSync(path.join(repoDir, "seen.txt")),
      false,
      "main のチェックアウトの中で動いている（cwd が repoPath に落ちている）"
    );
  });

  it("[決定59] 判断が付いたら畳む（review-ready から通しても残さない）", async () => {
    const approved = daemon.approveTask(PROJ, TASK, { by: "banto", note: "触って確かめた" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    await until(() => pool.list({ taskId: TASK }).length === 0);
    await until(() => daemon.getTaskEvents(PROJ, TASK).some((e) => e.type === "env_torn_down"));
  });
});
