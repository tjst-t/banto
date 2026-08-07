/**
 * 受け入れテストがタスクを状態機械の上で進めるための道具（task-0069）。
 *
 * **なぜ要るか。** 多くのテストが `queued → planning → implementing → …` と続けて
 * 遷移を叩いていた。ところが状態機械の表に `queued:planning` は**無い**——
 * 途中に `ready` がある（`queued:ready` → `ready:planning`）。
 *
 * それでも通っていたのは、**ゲートが背景で `queued → ready` に上げていた**から。
 * つまりテストは「積んだ直後にはもう ready になっている」に暗黙に頼っていて、
 * ゲートの tick が遅れると `planning` への遷移が 400 で落ちる。実際に、実機の
 * 検証環境が繋がっていたときに問い合わせが遅くなって落ちた（task-0066 の記録）。
 *
 * **時間ではなく状態を待つ。** `ready` になるのを待ってから次へ進める。
 * 上がらないまま時間切れになったら、**そのときの状態を添えて**落とす——
 * 「400 だった」だけだと、何を待てばよかったのかが分からない（I2）。
 */

import assert from "node:assert/strict";

/** タスク1件の状態を引く。 */
export async function taskStatus(base: string, proj: string, taskId: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  assert.equal(res.status, 200, `${taskId} を読めない（${res.status}）`);
  const { task } = (await res.json()) as { task: { status: string } };
  return task.status;
}

/**
 * その状態になるまで待つ。**時間ではなく状態を待つ**（混んでいると tick は遅れる）。
 *
 * @throws 時間切れのときは、待っていた状態と今の状態の両方を出す
 */
export async function waitForStatus(
  base: string,
  proj: string,
  taskId: string,
  want: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let current = await taskStatus(base, proj, taskId);
  while (current !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    current = await taskStatus(base, proj, taskId);
  }
  assert.equal(
    current,
    want,
    `${taskId} が ${timeoutMs}ms 待っても ${want} にならない（いま ${current}）。` +
      (want === "ready" ? "依存ゲートの tick が回っているか確かめること" : "")
  );
}

/** 1手だけ進める。 */
export async function transition(
  base: string,
  proj: string,
  taskId: string,
  to: string
): Promise<void> {
  const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  assert.equal(
    res.status,
    200,
    `${taskId}: ${to} へ遷移できない（${res.status}: ${await res.text()}）`
  );
}

/**
 * 状態機械の上をここまで進める。
 *
 * `queued` を通るときは**その後 `ready` に上がるのを待つ**——上げるのはゲートであって
 * テストではないので、明示的に `ready` へ遷移させると背景の tick と競る。
 *
 * @param path 通る状態（`ready` は書かなくてよい。待つのはこちらでやる）
 */
export async function advanceTask(
  base: string,
  proj: string,
  taskId: string,
  path: readonly string[]
): Promise<void> {
  for (const to of path) {
    if (to === "planning") {
      // 表に `queued:planning` は無い。ゲートが上げるのを待ってから進める
      await waitForStatus(base, proj, taskId, "ready");
    }
    await transition(base, proj, taskId, to);
  }
}

/** タスクを作って、そこまで進める。 */
export async function createAndAdvance(
  base: string,
  proj: string,
  taskId: string,
  path: readonly string[],
  body: Record<string, unknown> = {}
): Promise<void> {
  const res = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, title: `Task ${taskId}`, ...body }),
  });
  assert.equal(res.status, 201, `${taskId} を作れない（${res.status}）`);
  await advanceTask(base, proj, taskId, path);
}
