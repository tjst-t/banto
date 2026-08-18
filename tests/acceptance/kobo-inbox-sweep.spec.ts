/**
 * task-0277: **起動時スイープが kobo.list の100件切り詰めを迂回して、全終端タスクを取得し、
 * 100件を超えたタスクに紐づく未解決取次も stale として畳める。**
 *
 * **踏んだこと**（実測）。task-0276 が導入した起動時残存取次スイープ
 * （`sweepStaleInboxForTerminalTasks`）は bin.ts の `sweepStaleOnStartup` で
 * `invoke("kobo.list", { state })` を1回だけ引き、`kobo.list` は `MAX_ROWS=100` で
 * 打ち切るため、閉じたタスクが100件を超えると100件目以降の終端タスクが一覧に載らず、
 * 紐づく未解決の取次が「古い」として畳まれずに残った（task-0270 の in-961f7dd2 が
 * 未解決のまま残った）。
 *
 * **正すこと**: `kobo.list` に `offset` を足してページングで全件を引き、起動時スイープは
 * offset を進めて**全終端タスクを引き切る**まで列挙する（a1）。これにより、閉じたタスクが
 * 100件を超えていても、100件目以降のタスクに紐づく未解決取次も `stale:<状態>` として
 * 畳まれる（a2）。畳んだ記録は取次の履歴に残る（黙って消さない・I2）。
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
  koboPoDecisionEffect,
  koboReviewTarget,
  sweepStaleInboxForTerminalTasks,
} from "@banto/host";
import { Daemon, KOBO_MODULE_PATH, createKoboModule } from "@banto/daemon";

const PROJ = "inbox-sweep-proj";
const MAX_ROWS = 100;
// 閉じたタスクを100件を超えて作る（+1 は取次の札を載せるタスク）
const CLOSED_COUNT = MAX_ROWS + 31;
const CARD_TASK_ID = `closed-${CLOSED_COUNT}`;

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
}

async function harness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-inbox-sweep-"));
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
    resolvePoDecisionEffect: ({ canvasKind, canvasParams, decision, detail }) => {
      const review = koboReviewTarget(canvasKind, canvasParams);
      if (review) {
        if (decision === "approve" || decision === "send_back") {
          return koboPoDecisionEffect(review, decision, detail);
        }
        return undefined;
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
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** kobo.list を実 daemon へ引き、details を返す（bin.ts の invoke と同じ結線）。 */
async function invokeKoboList(
  h: Harness,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = h.koboTools.find((t) => t.name === "kobo.list");
  if (!tool) throw new Error("kobo.list がありません");
  const result = await tool.execute(params, { toolCallId: `test-${Date.now()}-${Math.random()}` });
  return (result.details ?? {}) as Record<string, unknown>;
}

/**
 * bin.ts（sweepStaleOnStartup）と同じ結線の起動時スイープ: offset を進めて
 * `kobo.list` から終端タスクを**全件**引き切る。
 */
async function listTerminalTasksAll(
  h: Harness,
  state: string
): Promise<Array<{ taskId: string; projectTag: string; status: string }>> {
  const tasks: Array<{ taskId: string; projectTag: string; status: string }> = [];
  let offset = 0;
  while (true) {
    const details = await invokeKoboList(h, { state, offset });
    const rows = ((details["tasks"] ?? []) as Array<{
      taskId: string;
      projectTag: string;
      status: string;
    }>);
    tasks.push(...rows);
    if (rows.length === 0) break;
    const total = details["total"] as number | undefined;
    offset += rows.length;
    if (total === undefined || offset >= total) break;
  }
  return tasks;
}

/** PO レビュー取次を積む。 */
async function postReviewCard(h: Harness, taskId: string): Promise<string> {
  const result = await h.inboxTools["inbox.post"]!.execute({
    sourceId: "kobo",
    sourceLabel: "工場（テスト）",
    kind: "番頭では決められない",
    rule: "決定57",
    title: `${taskId} を通してよいか`,
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

/** タスクを作ってすぐ closed で畳む（終端）。 */
function closeTask(daemon: Daemon, taskId: string): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: ["packages/banto-web/src/**"] },
    acceptance: [{ id: "a1", text: "動く" }],
  });
  const r = daemon.settleTaskOutside(PROJ, taskId, {
    reason: "別の経路で入った",
    by: "テスト",
    outcome: "landed_elsewhere",
  });
  assert.equal(r.ok, true, `${taskId} を閉じられない: ${JSON.stringify(r)}`);
}

describe("[task-0277] 起動時スイープが kobo.list の100件切り詰めを迂回して全終端タスクを畳む", () => {
  let h: Harness;

  // 閉じたタスクを100件を超えて作り、その最後の1件（必ず100件目以降に並ぶ）に
  // 未解決の取次を載せる（task-0270 の実測と同じ形）。
  before(async () => {
    h = await harness();
    for (let i = 1; i <= CLOSED_COUNT; i++) {
      closeTask(h.daemon, `closed-${i}`);
    }
  });

  after(async () => {
    await teardown(h);
  });

  it("kobo.list が offset ページングで100件を超えた終端タスクを全件列挙できる（a1）", async () => {
    // 既定（offset 無し・state 指定）は100件で切られる——最後のタスクは一覧に載らない
    const page0 = await invokeKoboList(h, { state: "closed" });
    assert.equal(page0["total"], CLOSED_COUNT, "終端タスクの総数が閉じた件数と一致しない");
    const firstPage = (page0["tasks"] ?? []) as Array<{ taskId: string }>;
    assert.equal(firstPage.length, MAX_ROWS, "既定の1頁目が100件でない");
    assert.ok(
      firstPage.every((t) => t.taskId !== CARD_TASK_ID),
      "100件目以降のタスクが1頁目に載っている（＝切り詰めが無い状態）"
    );

    // offset を進めれば全件に届く
    const all = await listTerminalTasksAll(h, "closed");
    assert.equal(all.length, CLOSED_COUNT, "offset を進めても全終端タスクが列挙できない");
    assert.ok(
      all.some((t) => t.taskId === CARD_TASK_ID),
      "100件目以降のタスクが全件列挙に含まれない"
    );
  });

  it("閉じたタスクが100件超でも100件目以降の取次が stale として畳まれる（a2）", async () => {
    // 100件目以降（必ず最終頁）に並ぶタスクに取次を積む
    const cardId = await postReviewCard(h, CARD_TASK_ID);
    assert.equal(
      h.inbox.get(cardId)?.resolvedAt,
      undefined,
      "積んだ直後に札が畳まれている"
    );

    // bin.ts と同じ結線（offset ページングを listTerminalTasks に載せる）で起動時スイープを回す
    await sweepStaleInboxForTerminalTasks(
      h.inbox,
      (state) => listTerminalTasksAll(h, state),
      () => {}
    );
    // 未解決取次が stale:closed として畳まれ、履歴に理由が残る（黙って消さない・I2）
    assert.equal(h.inbox.get(cardId)?.resolvedAt === undefined, false, "取次が畳まれていない");
    assert.equal(h.inbox.get(cardId)?.resolution, "stale:closed");
    assert.equal(h.inbox.pendingCount(), 0, "畳み損ねた札が残っている");
  });
});
