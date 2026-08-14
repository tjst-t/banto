/**
 * 段3（凍結中の task-0147 そのもの）: **PO が画面から通せるようにする。**
 *
 * **困っていたこと**（報告 A 表 8・11a）：`po` と判定されたタスク（統治コード・PO 必須の面）は
 * 決定57 により番頭には通せない。にもかかわらずレビュー面には PO 用のボタンが無く、
 * PO が通す手段は**サーバへ入って合言葉つきの curl を手打ちする**しかなかった
 * （帳簿でも `approvedBy: "po"` は 17 件中 2 件）。
 *
 * 直し方は**口を増やすことではない**——`http-server.ts` の PO 専用の承認口は既にある。
 * 足りなかったのは2つ：
 *   1. ブラウザからそこへ**届く経路**（Kobo は 127.0.0.1 にしか出ていない・決定40）。
 *      検証環境で先に踏んだのと同じ中継（決定39）に乗せる
 *   2. 画面の**押す場所**（`KoboReview.tsx`）
 *
 * 守ること（task-0147 の縛り）：
 *   - 番頭ホストは合言葉を**保存しない**（保存すると「番頭が自分で通せる」状態になり決定57 が空文になる）
 *   - Tool の口（`/tools/*`）は中継しない（同じ結果に2つの経路を作らない・D3）
 *   - 通しても関所は飛ばない（この後にマージ前ゲートが回るのは番頭経由と同じ）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon, KOBO_MODULE_PATH } from "../../packages/banto-daemon/src/index.js";
import { createRemoteRelay } from "../../packages/banto-host/src/remote-module.js";

// 合言葉は HTTP ヘッダに載るので ASCII（非 ASCII は fetch が ByteString に変換できない）
const PO_TOKEN = "po-secret-2026-08-13";
const PROJ = "po-approve-proj";

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

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

interface Harness {
  daemon: Daemon;
  /** ブラウザが見る先（番頭ホストの面を模したもの）。 */
  hostUrl: string;
  hostServer: http.Server;
  tmpDir: string;
}

/**
 * Kobo（127.0.0.1）と、その面を中継する番頭ホストを立てる。
 *
 * **中継は本物**（`createRemoteRelay`。bin.ts が工場に付けているのと同じもの）。
 * 偽物にすると「ホストが合言葉を預かっていないか」が検査できない。
 */
async function harness(options: { poToken?: string } = {}): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-po-approve-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
  // 決定57・66: PO 必須の面（この判定表はプロジェクトの持ち物）
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "meta", "config.yaml"),
    "review:\n  po_required_paths:\n    - packages/banto-web/**\n",
    "utf-8"
  );

  const koboPort = await freePort();
  const daemon = Daemon.create({
    port: koboPort,
    dataDir: path.join(tmpDir, "data"),
    watchIntervalMs: 99999,
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    // 稼働中の Environment Pool に触らせない（判断待ちに入ると頼みに行く・段11c）
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    ...(options.poToken !== undefined ? { poToken: options.poToken } : {}),
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const relay = createRemoteRelay(`http://127.0.0.1:${koboPort}${KOBO_MODULE_PATH}`);
  const hostServer = http.createServer((req, res) => {
    if (relay.serve(req, res)) return;
    res.writeHead(404).end("not relayed");
  });
  const hostPort = await freePort();
  await new Promise<void>((resolve) => hostServer.listen(hostPort, "127.0.0.1", resolve));

  return { daemon, hostServer, hostUrl: `http://127.0.0.1:${hostPort}`, tmpDir };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  await new Promise<void>((resolve) => h.hostServer.close(() => resolve()));
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** PO 必須の面に触るタスクを判断待ちまで運ぶ。 */
function driveToReviewReady(daemon: Daemon, taskId: string): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: ["packages/banto-web/src/**"] },
    acceptance: [{ id: "a1", text: "動く" }],
  });
  for (const to of ["queued", "ready", "planning", "implementing", "auditing", "review-ready"]) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
}

/** ブラウザがするのと同じ呼び出し（中継を通す）。 */
async function approveViaHost(
  h: Harness,
  taskId: string,
  headers: Record<string, string>,
  note?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${h.hostUrl}${KOBO_MODULE_PATH}/projects/${PROJ}/tasks/${taskId}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(note ? { note } : {}),
    }
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("[段3/task-0147] PO はブラウザから通せる（番頭には通せないものを）", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ poToken: PO_TOKEN });
  });
  after(async () => {
    await teardown(h);
  });

  it("前提：この面に触るタスクは番頭では通せない（決定57）", () => {
    driveToReviewReady(h.daemon, "task-3001");
    const banto = h.daemon.approveTask(PROJ, "task-3001", { by: "banto" });
    assert.equal(banto.ok, false);
    assert.match(
      (banto as { reason: string }).reason,
      /PO の判断が要ります/,
      "前提が崩れている（PO 必須と判定されていない）"
    );
  });

  it("合言葉つきなら中継を通って届き、**PO の名前で**帳簿に残る", async () => {
    const r = await approveViaHost(
      h,
      "task-3001",
      { Authorization: `Bearer ${PO_TOKEN}` },
      "実物を触って確かめた"
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(h.daemon.getTask(PROJ, "task-3001")?.status, "approved");

    const approved = h.daemon
      .getTaskEvents(PROJ, "task-3001")
      .find((e) => e.type === "task_approved") as { approvedBy: string; note?: string };
    assert.equal(approved.approvedBy, "po", "書き手の名前を変えない（task-0147 の縛り5）");
    assert.equal(approved.note, "実物を触って確かめた");
  });

  it("名乗りが無い／違うときは 401。状態は動かない", async () => {
    driveToReviewReady(h.daemon, "task-3002");

    const none = await approveViaHost(h, "task-3002", {});
    assert.equal(none.status, 401);
    const wrong = await approveViaHost(h, "task-3002", { Authorization: "Bearer wrong-secret" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body["error"], "unauthorized", "画面が理由で出し分けられる形であること");

    assert.equal(
      h.daemon.getTask(PROJ, "task-3002")?.status,
      "review-ready",
      "断ったのに状態が動いている"
    );
  });

  /**
   * **Tool の口は中継しない**（同じ結果に2つの経路を作らない・D3）。
   * `kobo.*` はモジュールの写しが HTTP で呼ぶので、ホストの面から素通しする必要が無い。
   */
  it("`/tools/*` は中継の対象外（番頭の道具はモジュールの写しが呼ぶ）", async () => {
    const res = await fetch(`${h.hostUrl}${KOBO_MODULE_PATH}/tools/kobo.list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    assert.equal(res.status, 404, "中継してしまうと、同じ Tool に2本の道ができる");
  });
});

describe("[段3/task-0147] 合言葉が未設定なら口は閉じたまま（I2）", () => {
  it("503 と `po_token_not_configured` が返る（「失敗しました」に潰さない）", async () => {
    const h = await harness();
    try {
      driveToReviewReady(h.daemon, "task-3003");
      const r = await approveViaHost(h, "task-3003", { Authorization: "Bearer anything" });
      assert.equal(r.status, 503);
      assert.equal(r.body["error"], "po_token_not_configured");
      assert.equal(h.daemon.getTask(PROJ, "task-3003")?.status, "review-ready");
    } finally {
      await teardown(h);
    }
  });
});

/**
 * 画面の側は React を Node のテストから描かずに**ソースで見る**
 * （`canvas-view-components.spec.ts` と同じやり方）。ここで見たいのは
 * 「配線が在るか」であって描画結果ではない。
 */
describe("[段3・段2] レビュー面に押す場所が在る", () => {
  const source = fs.readFileSync(
    new URL("../../packages/banto-web/src/views/KoboReview.tsx", import.meta.url).pathname,
    "utf-8"
  );

  it("PO 専用の承認口へ配線されている（番頭の Tool ではない）", () => {
    assert.match(source, /\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/approve/);
    assert.match(source, /Authorization: `Bearer \$\{token\}`/);
    assert.match(source, /PO として通す/, "PO が押せるボタンが無い");
  });

  it("合言葉を `localStorage` に置いていない（task-0147 の縛り4）", () => {
    assert.doesNotMatch(
      source,
      /localStorage\s*\.\s*(get|set)Item/,
      "タブを閉じても残る場所に合言葉を置かない"
    );
    assert.match(source, /sessionStorage\s*\.\s*setItem/);
  });

  it("閉じている（503）と名乗り違い（401）を区別して出す", () => {
    assert.match(source, /po_token_not_configured/);
    assert.match(source, /res\.status === 401/);
  });

  it("[段2] 差し戻すボタンが在り、`kobo.send_back` を呼んでいる", () => {
    assert.match(source, /差し戻す/);
    assert.match(source, /"kobo\.send_back"/);
  });
});
