/**
 * task-0310 a1〜a3: `worker.list` を「起動元の会話」で絞る。
 *
 * 背景（実害）：職人ビューア（WorkerViewer）は会話を問わず全プロジェクト・全会話の職人を
 * 混ぜて出していた。PO が自分の会話で `env.verify` を回したとき、この面に別会話が起こした
 * 職人が並んでいたため「`env.verify` が職人（LLM）を起こしているのでは」という誤った見立て
 * が生まれ、調査が一往復むだになった（`env.verify` は LLM を1本も起こさない）。
 *
 * 面が絞るには、まず `worker.list` 自身が起動元（origin）で絞れて、絞り込み後の
 * `total`/`closedTotal` がページ送りと辻褄が合っている必要がある——20件取って絞り込み後の
 * 分だけ捨てる実装だと、1ページの件数が要求どおりにならない（例: 20件取って18件捨てると
 * 1ページ2件になる）。
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

interface ListDetails {
  workers: Array<{ taskId: string; sessionId: string }>;
  total: number;
  closedTotal: number;
  limit: number;
  offset: number;
}

describe("[task-0310] worker.list を起動元（会話）で絞る", () => {
  let dataDir: string;
  let workDir: string;
  let pool: WorkerPool;
  let driver: FakeRuntimeDriver;
  let list: NamespacedToolDefinition;
  let seq = 0;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-list-origin-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-list-origin-wt-"));
    driver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver,
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      // 安全弁は切る。テストの最中に職人が勝手に畳まれると総数が狂う
      idleTimeoutMs: 0,
      // 既定の同時本数上限（6）だと、ページ送りを見るために複数会話ぶん起こす途中で
      // BANTO_WORKER_LIMIT に当たって断られる。ここで見たいのは絞り込みであって上限ではない
      maxConcurrentWorkers: 30,
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

  /** taskId が衝突しないよう連番を振って n 本まとめて起こす。 */
  async function delegateN(
    n: number,
    taskPrefix: string,
    origin: string
  ): Promise<Awaited<ReturnType<WorkerPool["delegate"]>>[]> {
    const workers: Awaited<ReturnType<WorkerPool["delegate"]>>[] = [];
    for (let i = 0; i < n; i++) {
      seq += 1;
      workers.push(
        await pool.delegate({
          taskId: `${taskPrefix}-${seq}`,
          origin,
          worktreePath: workDir,
          instruction: "調べる",
        })
      );
    }
    return workers;
  }

  it("[a3] origins を渡さなければ、これまでどおり全件が返る（既存呼び出しの振る舞いが変わらない）", async () => {
    const mine = threadOrigin("thread-a3-mine");
    const other = threadOrigin("thread-a3-other");
    await delegateN(2, "task-a3-mine", mine);
    await delegateN(3, "task-a3-other", other);

    const before5 = await list.execute({}, { toolCallId: "t-a3-before" });
    const beforeTotal = (before5.details as ListDetails).total;

    const more = await delegateN(1, "task-a3-more", mine);

    const result = await list.execute({}, { toolCallId: "t-a3-after" });
    const details = result.details as ListDetails;
    assert.equal(
      details.total,
      beforeTotal + 1,
      "origins を渡さなければ、増えた分だけそのまま全件に反映される（絞り込みが暗黙に効いていない）"
    );
    assert.ok(
      details.workers.some((w) => w.sessionId === more[0]!.sessionId),
      "他会話の職人も普通に混ざって出る（既定は絞らない）"
    );
  });

  it("[a1] origins で絞ると、workers・total・closedTotal がすべて絞り込み後の数になる（ページ送りが合う）", async () => {
    const mine = threadOrigin("thread-a1-mine");
    const others = threadOrigin("thread-a1-others");
    const delegated = await delegateN(3, "task-a1-mine", mine);
    await delegateN(4, "task-a1-others", others);

    // 稼働中3本を1ページ2件で取ると2ページに割れる——これがページ送りの検体
    const page0 = await list.execute(
      { origins: [mine], limit: 2, offset: 0 },
      { toolCallId: "t-a1-0" }
    );
    const d0 = page0.details as ListDetails;
    assert.equal(d0.total, 3, "絞り込み後の総数（他会話の4本を含まない）");
    assert.equal(d0.workers.length, 2, "1ページ目は上限どおり2件");
    assert.ok(
      d0.workers.every((w) => w.taskId.startsWith("task-a1-mine")),
      "他会話の職人が混ざっていない"
    );

    const page1 = await list.execute(
      { origins: [mine], limit: 2, offset: 2 },
      { toolCallId: "t-a1-1" }
    );
    const d1 = page1.details as ListDetails;
    assert.equal(d1.total, 3);
    assert.equal(
      d1.workers.length,
      1,
      "2ページ目は残り1件。20件取って絞り込み後の分だけ返す実装だと、この1件が消える"
    );

    // closedTotal も絞り込み後の数であること（他会話を畳んでも増えない・自分の会話を畳んでも他へ漏れない）
    await pool.close(delegated[0]!.sessionId, "done");
    const [otherExtra] = await delegateN(1, "task-a1-others-extra", others);
    await pool.close(otherExtra!.sessionId, "done");

    const afterClose = await list.execute(
      { origins: [mine], includeClosed: false },
      { toolCallId: "t-a1-2" }
    );
    const dAfter = afterClose.details as ListDetails;
    assert.equal(dAfter.total, 2, "畳んだ1本を除いた、稼働中の数");
    assert.equal(
      dAfter.closedTotal,
      1,
      "closedTotal も自分の会話ぶんだけ（他会話で畳んだ1本を含めない）"
    );
  });

  it(
    "[a2] 幹の origin と、その配下の枝の origin を両方渡すと、両方の職人が一覧に含まれる" +
      "（幹だけに絞って枝の職人が消える事故を防ぐ）",
    async () => {
      const trunkOrigin = threadOrigin("thread-a2-trunk");
      const branchOrigin = threadOrigin("thread-a2-branch");
      const unrelated = threadOrigin("thread-a2-unrelated");
      await delegateN(2, "task-a2-trunk", trunkOrigin);
      await delegateN(2, "task-a2-branch", branchOrigin);
      await delegateN(1, "task-a2-unrelated", unrelated);

      const result = await list.execute(
        { origins: [trunkOrigin, branchOrigin], includeClosed: false },
        { toolCallId: "t-a2" }
      );
      const details = result.details as ListDetails;
      assert.equal(details.total, 4, "幹2本＋枝2本＝4本。幹の origin だけに絞ると枝の分が消えてしまう");
      assert.ok(
        details.workers.every(
          (w) => w.taskId.startsWith("task-a2-trunk") || w.taskId.startsWith("task-a2-branch")
        ),
        "無関係の会話（unrelated）の職人が混ざっていない"
      );
    }
  );
});
