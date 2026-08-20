/**
 * task-0310 a4: 職人ビューア（WorkerViewer）は既定で「いまの会話」に絞って `worker.list`
 * を呼び、絞り込みで0件のときは「別の会話の職人が居ない」のではなく「この会話は誰も
 * 頼んでいない」ことが分かる文言を出す。
 *
 * この repo に React コンポーネントを DOM 付きで描く仕組み（jsdom・testing-library 等）
 * が無いため（`packages/banto-web` に既存の対応が無く、D1＝外部依存の追加は勝手に
 * 決めない）、ここでは `WorkerViewer.tsx` から**判断だけを切り出した純粋関数**
 * （`originsOfFamily`・`emptyStateText`）を直接確かめる。あわせて、
 * その関数が組み立てた `origins` が実物の `worker.list`（Worker Pool）に対して
 * 実際に「幹＋配下の枝は残り、無関係な会話は消える」ことを確認し、
 * 面（WorkerViewer）と Worker Pool の間の取り決め（origin の形）が
 * かみ合っていることを見る。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";
import { WorkerPool } from "../../packages/banto-worker-pool/src/pool.js";
import { createWorkerTools } from "../../packages/banto-worker-pool/src/worker-tools.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";
import { emptyStateText, originsOfFamily } from "../../packages/banto-web/src/views/WorkerViewer.js";

describe("[task-0310/a4] originsOfFamily（threadFamily → worker.list の絞り込み条件）", () => {
  it("threadId の一族を、Worker Pool 側の起動元の形（banto:<threadId>）へ変換する", () => {
    assert.deepEqual(originsOfFamily(["thread-61", "thread-246"]), [
      "banto:thread-61",
      "banto:thread-246",
    ]);
  });

  it("空・未定義は空配列（未解決の幹で全件を出してしまわないための土台）", () => {
    assert.deepEqual(originsOfFamily([]), []);
    assert.deepEqual(originsOfFamily(undefined), []);
  });
});

describe("[task-0310/a4] emptyStateText（0件のときに出す文言）", () => {
  it("この会話に絞っていて0件・畳んだ分も無い：会話の言葉で「居ない」と分かる", () => {
    const text = emptyStateText({ query: "", scopedToThread: true, closedCount: 0, showClosed: false });
    assert.equal(text.title, "この会話では職人を起こしていません");
    assert.match(text.body, /全部/, "他の会話を見る切り替えへの導線があること");
  });

  it("全部見るに切り替えているときは、これまでどおりの文言（別会話が消えたと誤読させない）", () => {
    const text = emptyStateText({ query: "", scopedToThread: false, closedCount: 0, showClosed: false });
    assert.equal(text.title, "動いている職人はいません");
  });

  it("検索語があるときは、絞り込み(scope)の言葉より検索の言葉が優先される", () => {
    const text = emptyStateText({
      query: "task-9999",
      scopedToThread: true,
      closedCount: 3,
      showClosed: false,
    });
    assert.match(text.title, /task-9999/);
  });

  it("畳んだ職人がいるときは、まずそちらへの導線を出す（会話に絞っていても同じ）", () => {
    const text = emptyStateText({ query: "", scopedToThread: true, closedCount: 2, showClosed: false });
    assert.match(text.body, /終わった職人が 2 人/);
  });
});

describe("[task-0310/a4] WorkerViewer が組み立てる origins は、実物の worker.list とかみ合う", () => {
  let dataDir: string;
  let workDir: string;
  let pool: WorkerPool;
  let driver: FakeRuntimeDriver;
  let list: NamespacedToolDefinition;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-viewer-scope-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-viewer-scope-wt-"));
    driver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver,
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      idleTimeoutMs: 0,
      maxConcurrentWorkers: 20,
    });
    const tools = createWorkerTools(pool);
    list = tools.find((t) => t.name === "worker.list")!;
  });

  after(async () => {
    for (const worker of pool.list({ includeClosed: false })) {
      await pool.close(worker.sessionId, "stopped").catch(() => undefined);
    }
    pool.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("幹の threadFamily（幹＋枝）で絞ると、枝が起こした職人は消えない。無関係な会話は消える", async () => {
    const trunkId = "thread-viewer-trunk";
    const branchId = "thread-viewer-branch";
    const unrelatedId = "thread-viewer-unrelated";

    await pool.delegate({
      taskId: "task-viewer-trunk",
      origin: threadOrigin(trunkId),
      worktreePath: workDir,
      instruction: "調べる",
    });
    await pool.delegate({
      taskId: "task-viewer-branch",
      origin: threadOrigin(branchId),
      worktreePath: workDir,
      instruction: "調べる",
    });
    await pool.delegate({
      taskId: "task-viewer-unrelated",
      origin: threadOrigin(unrelatedId),
      worktreePath: workDir,
      instruction: "調べる",
    });

    // App.tsx が組み立てる threadFamily と同じ形（幹自身＋その配下の枝）
    const threadFamily = [trunkId, branchId];
    const result = await list.execute(
      { origins: originsOfFamily(threadFamily), includeClosed: false },
      { toolCallId: "t-scope" }
    );
    const details = result.details as { workers: Array<{ taskId: string }>; total: number };

    assert.equal(details.total, 2, "幹1本＋枝1本");
    const taskIds = details.workers.map((w) => w.taskId).sort();
    assert.deepEqual(taskIds, ["task-viewer-branch", "task-viewer-trunk"]);
  });

  it("threadFamily が誰も職人を起こしていない会話のときは0件——emptyStateText の文言がそのまま使える", async () => {
    const lonelyThreadId = "thread-viewer-lonely";
    const result = await list.execute(
      { origins: originsOfFamily([lonelyThreadId]), includeClosed: false },
      { toolCallId: "t-scope-empty" }
    );
    const details = result.details as { workers: Array<unknown>; total: number };
    assert.equal(details.total, 0);

    const text = emptyStateText({ query: "", scopedToThread: true, closedCount: 0, showClosed: false });
    assert.equal(text.title, "この会話では職人を起こしていません");
  });
});
