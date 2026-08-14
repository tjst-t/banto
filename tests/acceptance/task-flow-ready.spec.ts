/**
 * task-0069: 「積んだ直後にはもう ready」に頼らない（task-0066 の残していた弱さ）。
 *
 * ## 何が弱かったか
 *
 * 多くの受け入れテストが `queued → planning → …` と続けて遷移を叩いていた。ところが
 * 状態機械の表に **`queued:planning` は無い**（間に `ready` がある）。それでも通っていたのは、
 * ゲートが背景で `queued → ready` に上げていたから。
 *
 * その昇格は**同期ではない**。`daemon.ts` の遷移後フックは
 *
 *   this.refreshEnvQuotaView().then(() => this.runGateReeval())
 *
 * という形で、**検証環境への HTTP 往復を待ってから**ゲートを回す（決定60：昇格は戻せないので
 * 古い写しで判定しない）。だから検証環境が遅いと `ready` への昇格が遅れ、直後の `planning`
 * が 400 で落ちる。実機の検証環境を常駐させた途端に audit-*.spec.ts が落ちたのがこれ。
 *
 * ## ここで確かめること
 *
 * **検証環境をわざと遅くしても、流れが通る。** 到達先を「遅く応える本物の HTTP サーバ」に
 * して、昇格が確実に後になる状況を作る。`advanceTask`（`ready` を待つ）を使えば通り、
 * 待たずに叩けば 400 になる——**直したことと、何が壊れていたかの両方**を1つの検体で見る。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { advanceTask, taskStatus } from "./task-flow.js";

/** 応答をわざと遅らせる検証環境の到達先。**本物の HTTP**（偽の fetch では経路が変わる）。 */
const SLOW_MS = 800;

let tmpDir: string;
let daemon: Daemon;
let base: string;
let slowServer: http.Server;
const proj = "proj-ready-wait";

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  git("add", "-A");
  git("commit", "-m", "initial");
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ready-wait-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);

  slowServer = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      // env.list の形。中身は空でよい——遅いことがここでの主題
      res.end(JSON.stringify({ content: [], details: { environments: [] } }));
    }, SLOW_MS);
  });
  await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", () => resolve()));
  const slowPort = (slowServer.address() as { port: number }).port;

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    // **定期の掃きは止める。** 遷移後のフックだけで昇格が起きる状況にする
    tickIntervalMs: 99999,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    environmentPoolUrl: `http://127.0.0.1:${slowPort}/api/environment-pool`,
  });
  await daemon.start();
  base = `http://localhost:${daemon.port}`;

  const projRes = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: proj, repoPath: repoDir }),
  });
  assert.equal(projRes.status, 201, "プロジェクトが登録できない");
});

after(async () => {
  await daemon.stop();
  await new Promise<void>((resolve) => slowServer.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createTask(taskId: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, title: `Task ${taskId}` }),
  });
  assert.equal(res.status, 201, `${taskId} を作れない`);
}

describe("[task-0069] ready への昇格は同期ではない", () => {
  it("検証環境が遅いと、queued の直後はまだ ready になっていない", async () => {
    await createTask("t-not-yet");
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/t-not-yet/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "queued" }),
    });
    assert.equal(res.status, 200);

    // **遷移が返った直後**の状態。昇格は検証環境への往復の後なので、まだ queued のはず
    assert.equal(
      await taskStatus(base, proj, "t-not-yet"),
      "queued",
      "この検体は「昇格が後になる」ことに依っている。同期で上がるなら検体が成立していない"
    );
  });

  it("待たずに planning を叩くと落ちる（これが元の暗黙の前提）", async () => {
    await createTask("t-eager");
    await fetch(`${base}/api/v1/projects/${proj}/tasks/t-eager/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "queued" }),
    });
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/t-eager/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "planning" }),
    });
    assert.notEqual(
      res.status,
      200,
      "queued から直に planning へ行けてしまうなら、状態機械の表が変わっている"
    );
  });

  it("ready を待てば通る（advanceTask）", async () => {
    await createTask("t-patient");
    await advanceTask(base, proj, "t-patient", ["queued", "planning", "implementing"]);
    assert.equal(await taskStatus(base, proj, "t-patient"), "implementing");
  });
});
