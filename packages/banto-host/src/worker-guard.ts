/**
 * 番頭は**自分が起こしていない職人を畳めない**（ADR-0013 決定63）。
 *
 * Kobo が起こした職人を番頭が畳むと、Kobo の状態機械と実態が食い違う——Kobo は
 * 「実装中」のつもりで、実際には職人が居ない。Kobo は自分の職人を自分で畳む（I3）。
 *
 * **置き場所は Tool を束ねる層**（`guardPathArg` と同じ）で、Worker Pool 側ではない。
 * Worker Pool は呼び出し元を区別できない——`worker.close` を叩いているのが番頭なのか
 * Kobo 自身なのかは、束ねる側にしか分からない。中核がモジュール名（"kobo"）を
 * 知る必要も無くなる：**自分の origin と違えば拒む**、それだけで足りる。
 *
 * D5: 判断は無い。誰が起こしたかを引いて、違えば止める。
 * I2: 拒む理由を呼び出し側へ返す（黙って成功に見せない・黙って何もしないをしない）。
 */

import type { NamespacedToolDefinition } from "./tool-registry.js";
import { BANTO_ORIGIN } from "./worker-notice.js";

/** 職人1人分の、この砦に要るところだけ。 */
interface WorkerOriginView {
  sessionId: string;
  taskId: string;
  origin: string;
}

/**
 * 職人を畳む Tool（`worker.close` / `worker.stop`）を、起動元の一致で守る。
 *
 * @param tool     守る対象
 * @param origin   この会話の起動元（`banto:<threadId>`）
 * @param lookup   sessionId から職人を引く（通常は `worker.list` の Tool を通す）
 */
export function guardWorkerOrigin(
  tool: NamespacedToolDefinition,
  origin: string,
  lookup: (sessionId: string) => Promise<WorkerOriginView | undefined>
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args: unknown, ctx) {
      const params = (args ?? {}) as Record<string, unknown>;
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : "";
      const worker = sessionId ? await lookup(sessionId) : undefined;
      // 見つからない職人はここで判定しない——「知らない職人」のエラーは Worker Pool が
      // 出す方が正確（履歴に無いのか、畳み済みなのかを知っているのは向こう）
      if (worker && !allowed(worker.origin, origin)) {
        throw new Error(
          `${worker.taskId}（${sessionId}）はあなたが起こした職人ではありません（起動元: ${worker.origin}）。` +
            "起こした側が畳みます——Kobo の職人を畳むと、Kobo は動いているつもりのまま実体が消えます。" +
            "様子を見るだけなら worker.attach と worker.events が使えます。"
        );
      }
      return tool.execute(params, ctx);
    },
  } as NamespacedToolDefinition;
}

/**
 * 畳んでよいか。
 *
 * 自分の会話で起こした職人だけ。ただし**スレッド以前の名乗り**（`banto`）は許す
 * ——決定35a より前に起こした職人が、誰にも畳めないまま残るのを避けるため。
 */
function allowed(workerOrigin: string, myOrigin: string): boolean {
  return workerOrigin === myOrigin || workerOrigin === BANTO_ORIGIN;
}
