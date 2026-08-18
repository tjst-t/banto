/**
 * task-0276: **仕組導入前に残った stale 取次も、起動時スイープで自動解決される。**
 *
 * **踏んだこと**（PO 指摘 2026-08-17）。task-0273（`resolveStaleInboxForTask`）が導入した
 * 「閉じたタスクの取次を自動解決」は**今後タスクが終端遷移したイベントでしか発火しない**。
 * task-0270（abandon）・task-0271（supersede）などはその仕組の導入前に閉じたため、紐づく
 * 取次（PO レビュー依頼・amend 依頼）が誰にも解決されずに残った。PO UI で「通す／
 * 差し戻す」を押しても、タスクが review-ready でないためエラーになる。
 *
 * **正すこと**: 起動時に一度、工場が終端（closed / superseded）としているタスクを全部挙げ、
 * それぞれに紐づく未解決の取次を `Inbox.resolveStale` で「古い（`stale:<状態>`）」として
 * 畳む（`sweepStaleOnStartup`）。**解決の記録は取次の履歴に残す**（黙って消さない・
 * I2）。生きているタスク（review-ready 等）の取次は巻き込んで**は**いけない（a2）。
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
  sweepStaleInboxForTerminalTasks,
} from "@banto/host";
import { Daemon, KOBO_MODULE_PATH, createKoboModule } from "@banto/daemon";
import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";

const PROJ = "stale-sweep-proj";

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-stale-sweep-"));
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

/** amend 取次（「この改訂を適用してよいか」）を積む。 */
async function postAmendCard(h: Harness, taskId: string): Promise<string> {
  const result = await h.inboxTools["inbox.post"]!.execute({
    sourceId: "kobo",
    sourceLabel: "工場（テスト）",
    kind: "番頭では決められない",
    rule: "task-0273",
    title: `${taskId} の改訂を適用してよいか`,
    what: "レビューで詰まった",
    ask: "適用してよいか",
    actions: [{ id: "go", label: "適用する", tone: "call" }],
    canvasKind: "kobo.amend",
    canvasParams: { projectTag: PROJ, taskId },
    amendAction: "go",
    amendChanges: { acceptance: [{ id: "a1", text: "動く" }] },
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

/**
 * bin.ts と同じ結線の起動時スイープを、本物の引き取り（startKoboNotices）に載せて起動する。
 * tools に `h.koboTools` を渡すので、内部の `invoke` が本物の `kobo.list`（実 daemon へ）
 * を引き、閉じたタスクの列挙が行われる。
 */
function startWithSweep(h: Harness): () => void {
  return startKoboNotices({
    tools: h.koboTools,
    notify: async () => {},
    cursorPath: h.cursorPath,
    intervalMs: 99999,
    log: () => {},
    sweepStaleOnStartup: async (invoke) => {
      await sweepStaleInboxForTerminalTasks(h.inbox, async (state) => {
        const details = await invoke("kobo.list", { state });
        return ((details["tasks"] ?? []) as Array<{
          taskId: string;
          projectTag: string;
          status: string;
        }>);
      });
    },
  });
}

describe("[task-0276] 仕組導入前に残った stale 取次が起動時スイープで解決される", () => {
  let h: Harness;

  before(async () => {
    h = await harness();
  });

  after(async () => {
    await teardown(h);
  });

  it("導入前に閉じたタスクの古い取次が起動時スイープで解決され、履歴に理由が残る（a1・a3）", async () => {
    // **仕組導入前の状態を再現**する: タスクを閉じてから、終端遷移の自動解決
    // （onTaskClosed）無しで取次だけが積まれたまま
    driveToReviewReady(h.daemon, "task-6001");
    const reviewId = await postReviewCard(h, "task-6001");
    const r = h.daemon.transition(PROJ, "task-6001", "superseded", "task-6002 で置き換え");
    assert.equal(r.ok, true, JSON.stringify(r));
    // まだ何も起動していないので、札は未解決のまま
    assert.equal(h.inbox.get(reviewId)?.resolvedAt, undefined, "導入前に積まれた札が既に畳まれている");

    // amend 依頼も同様に、settle（closed）で閉じたタスクに紐づく古い取次として残す
    driveToReviewReady(h.daemon, "task-6003");
    const amendId = await postAmendCard(h, "task-6003");
    const s = h.daemon.settleTaskOutside(PROJ, "task-6003", {
      reason: "別の経路で入った",
      by: "テスト",
      outcome: "landed_elsewhere",
    });
    assert.equal(s.ok, true, JSON.stringify(s));

    // 起動時スイープを載せた引き取りを起動すると、導入前に残った古い取次が掃かれる
    const stop = startWithSweep(h);
    try {
      await until(
        () =>
          h.inbox.get(reviewId)?.resolvedAt !== undefined &&
          h.inbox.get(amendId)?.resolvedAt !== undefined,
        "導入前の古い取次が起動時スイープで畳まれること"
      );
      // 解決の記録は取次の履歴に残る（黙って消さない・a3）——marker はタスクの現状
      assert.equal(h.inbox.get(reviewId)?.resolution, "stale:superseded");
      assert.equal(h.inbox.get(amendId)?.resolution, "stale:closed");
      // 判断待ち（resolvedAt の無い）には数えられない
      assert.equal(h.inbox.pendingCount(), 0);
    } finally {
      stop();
    }
  });

  it("生きているタスク（review-ready）の取次は巻き込まれず、判断待ちとして残る（a2）", async () => {
    driveToReviewReady(h.daemon, "task-6004");
    const liveId = await postReviewCard(h, "task-6004");
    // review-ready のまま（閉じない）。起動時スイープは別途起動する
    const stop = startWithSweep(h);
    try {
      // 少し待っても（スイープが1周回っても）生きている札は畳まれない
      await until(() => h.inbox.pendingCount() === 1, "生きているタスクの札が1枚立っていること");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(h.inbox.get(liveId)?.resolvedAt, undefined, "生きているタスクの札が畳まれた");
      assert.equal(h.inbox.pendingCount(), 1);
    } finally {
      stop();
    }
  });

  it("解決済みの取次は起動時スイープで二度畳まれない（冪等・a3）", async () => {
    // 導入前に畳まれた札（reviewId / amendId）が既に解決されている。もう一度スイープを
    // 直に回しても、巻き込むものは無く、既存の解決記録（理由）を上書きしない
    const sweepAgain = await sweepStaleInboxForTerminalTasks(h.inbox, async (state) => {
      const details = await startKoboNoticesListStub(h, state);
      return ((details["tasks"] ?? []) as Array<{
        taskId: string;
        projectTag: string;
        status: string;
      }>);
    });
    assert.equal(sweepAgain.length, 0, "既に畳まれた札を二度目のスイープが再解決している");
    const resolved = h.inbox.list().filter((i) => i.resolvedAt);
    assert.ok(resolved.some((i) => i.resolution === "stale:superseded"), "superseded の理由が残っていない");
    assert.ok(resolved.some((i) => i.resolution === "stale:closed"), "closed の理由が残っていない");
    // 生きているタスク（task-6004）の札は巻き込まれず判断待ちのまま
    assert.equal(h.inbox.pendingCount(), 1);
  });
});

/** kobo.list（state 指定）を実 daemon へ引く共通のスタブ（sweepStaleOnStartup と同じ結線）。 */
async function startKoboNoticesListStub(
  h: Harness,
  state: string
): Promise<Record<string, unknown>> {
  const tool = h.koboTools.find((t) => t.name === "kobo.list");
  if (!tool) throw new Error("kobo.list がありません");
  const result = await tool.execute({ state }, { toolCallId: `test-${Date.now()}` });
  return (result.details ?? {}) as Record<string, unknown>;
}
