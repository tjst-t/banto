/**
 * task-0273 穴2: **supersede / settle / abandon / close で閉じたタスクに紐づく未解決の取次が、
 * 自動で「古い（superseded 等）」として解決され、判断待ちに残らない。**
 *
 * **踏んだこと**（2026-08-17 実測）。task-0271 を supersede した後も、review-ready 時に
 * 上げた PO レビュー取次（「通す／差し戻す」）が未解決のまま残り、判断待ちとして表示され
 * 続けた。閉じたタスクの札に PO はもう答えられない——タスクは既に降りているから。
 *
 * **正すこと**: ホストの工場イベントの引き取り（`startKoboNotices`）でタスクの終端遷移
 * （`superseded` / `closed`）を検知し、そのタスク id を参照する未解決の札を
 * `Inbox.resolveStale` で「古い（`stale:<状態>`）」として畳む。**解決の記録は取次の履歴に
 * 残す**（黙って消さない・I2）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  Inbox,
  createInboxTools,
  koboAmendTarget,
  koboPoDecisionEffect,
  koboReviewTarget,
  resolveStaleInboxForTask,
} from "@banto/host";
import { Daemon, KOBO_MODULE_PATH, createKoboModule } from "@banto/daemon";
import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";

const PROJ = "stale-inbox-proj";

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
  inbox: Inbox;
  inboxTools: Record<string, ReturnType<typeof createInboxTools>[number]>;
  koboTools: ReturnType<typeof createKoboModule>["tools"];
  tmpDir: string;
  cursorPath: string;
}

async function harness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-stale-inbox-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
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
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    workerPoolUrl: "http://127.0.0.1:1/api/worker-pool",
    disableMergeQueue: true,
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const koboUrl = `http://127.0.0.1:${koboPort}${KOBO_MODULE_PATH}`;
  const koboModule = createKoboModule(koboUrl);

  const inbox = new Inbox(path.join(tmpDir, "inbox.jsonl"));
  const inboxToolList = createInboxTools(inbox, {
    threadId: "t-1",
    resolvePoDecisionEffect: ({ canvasKind, canvasParams, decision, detail, changes }) => {
      const review = koboReviewTarget(canvasKind, canvasParams);
      if (review) {
        if (decision === "approve" || decision === "send_back") {
          return koboPoDecisionEffect(review, decision, detail);
        }
        return undefined;
      }
      const amend = koboAmendTarget(canvasKind, canvasParams);
      if (amend && decision === "amend") {
        return koboPoDecisionEffect(amend, "amend", detail, changes);
      }
      return undefined;
    },
  });
  const inboxTools = Object.fromEntries(inboxToolList.map((t) => [t.name, t]));

  return {
    daemon,
    inbox,
    inboxTools,
    koboTools: koboModule.tools,
    tmpDir,
    cursorPath: path.join(tmpDir, "kobo-cursor.json"),
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** タスクを作り、review-ready まで持って行く。 */
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

/** PO レビュー取次（「通す／差し戻す」）を積む。 */
async function postReviewCard(h: Harness, taskId: string): Promise<string> {
  const result = await h.inboxTools["inbox.post"]!.execute({
    sourceId: "kobo",
    sourceLabel: "工場（テスト）",
    kind: "番頭では決められない",
    rule: "決定57",
    title: `${taskId} を通してよいか`,
    why: "POから「電卓を作って」と言われた",
    what: "実装が終わり、監査を通った",
    ask: "マージしてよいか",
    actions: [
      { id: "approve", label: "通す（マージへ）", tone: "call" },
      { id: "send_back", label: "差し戻す" },
    ],
    canvasKind: "kobo.review",
    canvasParams: { projectTag: PROJ, taskId },
    approveAction: "approve",
    sendBackAction: "send_back",
    sendBackReason: "受け入れ基準 a1 を満たしていない",
  } as never);
  return (result.details as { id: string }).id;
}

/** 条件が満たされるまで待つ。 */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("[task-0273/穴2] supersede で閉じたタスクの取次が自動で古い札として解決される", () => {
  let h: Harness;
  let itemId: string;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("前提：タスクを閉じる前は、紐づく取次は判断待ちのまま（解決されない）", async () => {
    driveToReviewReady(h.daemon, "task-5201");
    itemId = await postReviewCard(h, "task-5201");
    assert.equal(h.inbox.get(itemId)?.resolvedAt, undefined, "閉じる前に札が畳まれている");
  });

  it("supersede 後に、工場イベントの引き取り（startKoboNotices）が古い札を自動解決する", async () => {
    // タスクを supersede で閉じる
    const r = h.daemon.transition(PROJ, "task-5201", "superseded", "task-0272 で置き換え");
    assert.equal(r.ok, true, JSON.stringify(r));

    // 本物の引き取り（bin.ts と同じ結線）を supersede の後に起動する——起動時の即時 tick が
    // 終端遷移を拾い、紐づく未解決の札を「古い」として畳む
    const stop = startKoboNotices({
      tools: h.koboTools,
      notify: async () => {},
      cursorPath: h.cursorPath,
      intervalMs: 99999,
      log: () => {},
      onTaskClosed: ({ projectTag, taskId, to }) => {
        resolveStaleInboxForTask(h.inbox, projectTag, taskId, to);
      },
    });
    try {
      await until(() => h.inbox.get(itemId)?.resolvedAt !== undefined, "古い札が畳まれること");
      // 解決の記録は取次の履歴に残る（黙って消さない・I2）
      assert.equal(h.inbox.get(itemId)?.resolution, "stale:superseded");
    } finally {
      stop();
    }
  });

  it("判断待ち（resolvedAt の無い）には数えられない", () => {
    assert.equal(
      h.inbox.pendingCount(),
      0,
      "閉じたタスクの札が判断待ちとして残っている"
    );
    assert.equal(h.inbox.list().find((i) => i.id === itemId)?.resolvedAt !== undefined, true);
  });

  it("別のタスクに紐づく未解決の札は触らない", async () => {
    driveToReviewReady(h.daemon, "task-5202");
    const other = await postReviewCard(h, "task-5202");
    assert.equal(h.inbox.get(other)?.resolvedAt, undefined, "関係の無い札まで畳んでいる");

    // 直接 resolver を呼んでも、別タスクの札はそのまま
    const closed = resolveStaleInboxForTask(h.inbox, PROJ, "task-5201", "superseded");
    assert.ok(closed.length === 0, "既に畳まれた札がもう一度数えられている");
    assert.equal(h.inbox.get(other)?.resolvedAt, undefined);
  });
});
