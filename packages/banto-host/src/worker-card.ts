/**
 * **職人を起こしたら、会話に必ず口が立つ**（PO要望 2026-08-11）。
 *
 * 枝を開くと幹に札が1行立つ（決定77）のと同じ形を、職人にも与える。押すと職人ビューアが
 * 開き、いま何をしているかが読める。
 *
 * ## なぜ機構にするか
 *
 * 番頭が `canvas.open` を思い出したときだけ口が立つ形だと、**忘れたときに見えない**。
 * 実際、暴走した枝（thread-69）では職人の様子を見る手立てが会話に無く、番頭は
 * `worker.attach` を繰り返して自分で覗くしかなかった。**PO も同じものを見られない。**
 *
 * 決定77 が枝で立てた不変条件（「どこにも出ていない枝は作れない」）と同じ考え：
 * **どこにも出ていない職人は起こせない。**
 *
 * ## 何を出すか
 *
 * 面への口（決定78 の `open` の器）。既にある仕組みで、押せば `worker.viewer` が開き、
 * 会話に残るので**あとから遡って開き直せる**。新しい器は増やさない（D6）。
 *
 * D5: 判断は無い。起こせたら口を立てるだけ。
 */

import { openUtsuwa } from "./canvas-utsuwa.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import type { UtsuwaView } from "./protocol.js";

/** 職人ビューアの面の種類（Worker Pool のモジュールが出しているもの）。 */
export const WORKER_VIEW = "worker.viewer";

/**
 * `worker.delegate` に、**起こせたら口を立てる**ふるまいを足す。
 *
 * I2: 口を立てられなくても、職人は起きている。**起こしたことを取り消さない**——
 *     握りつぶすと「起きているのに誰も知らない」になる（`thread.open` の種と同じ扱い）。
 */
export function withWorkerCard(
  tool: NamespacedToolDefinition,
  showUtsuwa: (utsuwa: UtsuwaView) => void,
  log: (message: string) => void = (m) => console.error(m)
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args, ctx) {
      const result = await tool.execute(args, ctx);
      const details = (result.details ?? {}) as Record<string, unknown>;
      const sessionId = typeof details["sessionId"] === "string" ? details["sessionId"] : undefined;
      // I2: 識別子が返らないのは工房側の異常。**黙って口を省かない**
      if (!sessionId) {
        log("[banto] 職人の識別子が返らないため、会話に口を立てられませんでした");
        return result;
      }
      const taskId =
        typeof details["taskId"] === "string"
          ? details["taskId"]
          : typeof (args as Record<string, unknown>)?.["taskId"] === "string"
            ? String((args as Record<string, unknown>)["taskId"])
            : "";
      const runtime = typeof details["runtime"] === "string" ? details["runtime"] : undefined;
      const model = typeof details["model"] === "string" ? details["model"] : undefined;
      try {
        showUtsuwa(
          openUtsuwa({
            view: WORKER_VIEW,
            label: taskId ? `職人「${taskId}」の様子を見る` : "職人の様子を見る",
            // 何で動いているかは押す前に分かるようにする（同じ札が並んだとき見分かる）
            ...(runtime || model
              ? { meta: [runtime, model].filter((v) => v).join(" / ") }
              : {}),
            args: { sessionId },
          })
        );
      } catch (err) {
        // 口が立たなくても職人は起きている。起こしたことは取り消さない
        log(`[banto] 職人の口を会話へ積めませんでした: ${String(err)}`);
      }
      return result;
    },
  };
}
