/**
 * 段3（task-0147）: **PO が画面から通せるようにする。**
 *
 * **困っていたこと**（報告 A 表 8・11a）：`po` と判定されたタスク（統治コード・PO 必須の面）は
 * 決定57 により番頭には通せない。にもかかわらずレビュー面には PO 用のボタンが無く、
 * PO が通す手段は**サーバへ入って curl を手打ちする**しかなかった
 * （帳簿でも `approvedBy: "po"` は 17 件中 2 件）。
 *
 * 直し方は**口を増やすことではない**——`http-server.ts` の PO 専用の承認口は既にある。
 * 足りなかったのは2つ：
 *   1. ブラウザからそこへ**届く経路**（Kobo は 127.0.0.1 にしか出ていない・決定40）。
 *      検証環境で先に踏んだのと同じ中継（決定39）に乗せる
 *   2. 画面の**押す場所**（`KoboReview.tsx`）
 *
 * **合言葉は廃止した**（ADR-0023 決定113・imp-0034）。task-0147 の当時は「PO 本人か」を
 * 名乗りで確かめていたが、PO からは「自分専用の画面でなぜ毎回名乗らされるのか」＝
 * **OK を出せないのと同じ**と見えていた。分ける境界を「合言葉の有無」から
 * 「**Tool の経路か、人が押した経路か**」へ移し、監査可能性は記録（`via`）で担保する。
 *
 * 守ること：
 *   - 番頭（LLM）の口（`kobo.approve`）は PO 必須のタスクを断り続ける（決定57）
 *   - Tool の口（`/tools/*`）は中継しない（同じ結果に2つの経路を作らない・D3）
 *   - 通しても関所は飛ばない（この後にマージ前ゲートが回るのは番頭経由と同じ）
 *   - **出どころの無い PO 承認は受けない**（`via` が要る）
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
 * 偽物にすると「ブラウザからの経路が本当に通っているか」が検査できない。
 */
async function harness(): Promise<Harness> {
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
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    // 稼働中の器に触らせない（判断待ちに入ると頼みに行く・段11c）。
    // `npm test` は env で塞いでいるが、1本だけ走らせたときも同じであること
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    workerPoolUrl: "http://127.0.0.1:1/api/worker-pool",
    disableMergeQueue: true,
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
async function decideViaHost(
  h: Harness,
  taskId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${h.hostUrl}${KOBO_MODULE_PATH}/projects/${PROJ}/tasks/${taskId}/po-decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

describe("[段3/task-0147] PO はブラウザから通せる（番頭には通せないものを）", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
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

  it("**合言葉なしで**中継を通って届き、PO の名前で帳簿に残る（決定113）", async () => {
    const r = await decideViaHost(h, "task-3001", {
      decision: "approve",
      via: "ui:kobo.review",
      note: "実物を触って確かめた",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(h.daemon.getTask(PROJ, "task-3001")?.status, "approved");

    const approved = h.daemon
      .getTaskEvents(PROJ, "task-3001")
      .find((e) => e.type === "task_approved") as {
      approvedBy: string;
      note?: string;
      via?: string;
    };
    assert.equal(approved.approvedBy, "po", "書き手の名前を変えない（task-0147 の縛り5）");
    assert.equal(approved.note, "実物を触って確かめた");
    assert.equal(
      approved.via,
      "ui:kobo.review",
      "どこから通したかが帳簿に無い（合言葉をやめた代わりの担保・決定113）"
    );
  });

  it("出どころ（via）が無ければ 400。状態は動かない（決定113）", async () => {
    driveToReviewReady(h.daemon, "task-3002");

    const none = await decideViaHost(h, "task-3002", { decision: "approve" });
    assert.equal(none.status, 400);
    assert.equal(none.body["error"], "via_required", "画面が理由で出し分けられる形であること");
    const blank = await decideViaHost(h, "task-3002", { decision: "approve", via: "   " });
    assert.equal(blank.status, 400, "空白だけの出どころを通さない");

    // I2: 知らない判断を承認へ倒さない（緩い側へ落ちるのが一番たちが悪い）
    const unknown = await decideViaHost(h, "task-3002", { decision: "merge", via: "ui:kobo.review" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body["error"], "unknown_decision");

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

/**
 * **合言葉の設定は要らなくなった**（決定113）。かつては `BANTO_PO_TOKEN` が未設定だと
 * この口が 503 で閉じており、設定を持たない環境では PO が一切通せなかった。
 */
describe("[決定113] 合言葉を設定しなくても PO は通せる", () => {
  it("何も設定していないホストで通り、`approvedBy: \"po\"` が残る", async () => {
    const h = await harness();
    try {
      driveToReviewReady(h.daemon, "task-3003");
      const r = await decideViaHost(h, "task-3003", {
        decision: "approve",
        via: "ui:kobo.review",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(h.daemon.getTask(PROJ, "task-3003")?.status, "approved");
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

  it("PO 専用の口へ配線されている（番頭の Tool ではない）", () => {
    assert.match(source, /\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/po-decision/);
    assert.match(source, /PO として通す/, "PO が押せるボタンが無い");
  });

  /**
   * **合言葉を画面から要求しない**（決定113・PO の明確な要望）。
   * 名乗りを条件にするなら、PO にとっては「OK を出せない」のと同じ。
   */
  it("合言葉の入力も保存もしていない", () => {
    assert.doesNotMatch(source, /Bearer/, "画面が合言葉を送っている");
    assert.doesNotMatch(source, /PO の合言葉/, "合言葉の入力欄が残っている");
    assert.doesNotMatch(source, /(local|session)Storage/, "合言葉を置く場所が残っている");
  });

  it("どこから通したかを添えている（監査は記録で担保・決定113）", () => {
    assert.match(source, /via: "ui:kobo\.review"/);
    assert.match(source, /decision: "approve"/);
  });

  it("[段2] 差し戻すボタンが在り、`kobo.send_back` を呼んでいる", () => {
    assert.match(source, /差し戻す/);
    assert.match(source, /"kobo\.send_back"/);
  });
});
