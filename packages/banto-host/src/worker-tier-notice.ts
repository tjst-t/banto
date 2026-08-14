/**
 * **等級に割り当てが無くて職人が起きなかったことを、取次へ積む**（ADR-0021 決定104）。
 *
 * 決定104 は「候補が無いときは黙って落ちない。**取次へ一通積む**」だが、
 * **工房は取次を知らない**（決定27：Banto をブローカーにしない）。だから工房は
 * 合印つきで断るだけで、積むのは取次を持っているこの層——`guardWorkerOrigin` を
 * 工房ではなくここに置いたのと同じ理由で、**束ねる側にしか出来ないことがある**。
 *
 * ## なぜ会話のエラーだけでは足りないか
 *
 * 番頭の道具の失敗は会話に出るが、**直せるのは PO だけ**（役の割り当ては設定の面で、
 * 番頭には設定の口を渡していない・決定41c）。会話に出して終わりだと、番頭は
 * 「起こせません」を読んで別の手を探し、**設定が空いたままなのは誰にも届かない**。
 * 取次は「POに用がある」の1本の口（決定73）なので、そこへ出す。
 *
 * D5: 判断は無い。断りの合印を見て、一通を組むだけ。
 * I2: 積めなくても、断りはそのまま呼び出し側へ返す（握りつぶさない）。
 */

import { tierFromUnassignedError } from "@banto/worker-pool";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import type { Inbox } from "./inbox.js";

/** 等級の呼び名（取次の文言に出す）。工房の等級と同じ3つ。 */
const TIER_LABELS: Record<string, string> = {
  reasoning: "高精度（reasoning）",
  standard: "通常（standard）",
  fast: "高速（fast）",
};

export interface WorkerTierNoticeOptions {
  inbox: Inbox;
  /** 押して設定へ移ったあと、会話へ戻れるようにする（決定35a と同じ宛先の考え方）。 */
  threadId?: string;
  log?(message: string): void;
}

/**
 * `worker.delegate` に、**断られたら取次へ積む**ふるまいを足す。
 *
 * 合印の無い失敗（届かない・引数が違う・起動に失敗した）は素通しする——ここで拾うのは
 * 「設定が空いている」ときだけで、それ以外を取次へ流すと札が意味を失う。
 */
export function withTierUnassignedNotice(
  tool: NamespacedToolDefinition,
  options: WorkerTierNoticeOptions
): NamespacedToolDefinition {
  const log = options.log ?? ((m: string) => console.error(m));
  return {
    ...tool,
    async execute(args, ctx) {
      try {
        return await tool.execute(args, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const tier = tierFromUnassignedError(message);
        if (!tier) throw err;
        const label = TIER_LABELS[tier] ?? tier;
        const taskId =
          typeof (args as Record<string, unknown>)?.["taskId"] === "string"
            ? String((args as Record<string, unknown>)["taskId"])
            : undefined;
        try {
          options.inbox.post({
            /**
             * **同じ等級で札を積み増さない。** 起こし損ねるたびに1枚増えると、
             * 直すべき設定は1つなのに取次が埋まる（`branch-stale` と同じ扱い）。
             */
            key: `worker-tier-unassigned:${tier}`,
            source: { id: "worker", label: "工房" },
            kind: "設定が空いている",
            rule: "決定104",
            title: `等級「${label}」にモデルが割り当てられていません`,
            ...(taskId ? { why: `「${taskId}」を職人に委譲しようとしました。` } : {}),
            what:
              `${label} で頼まれましたが、その等級にモデルが当たっていないため職人を起こしませんでした。` +
              "**別の等級へ勝手に落としていません**——以前は落ちる先が `reasoning` だったので、" +
              "安いつもりで一番高いモデルが走っていました（ADR-0021 決定104）。",
            ask: "この等級にどのモデルを当てますか",
            actions: [
              { id: "assign", label: "「役ごとのモデル」を開いて当てる", tone: "call" },
              { id: "later", label: "いまは当てない（この仕事は止まったまま）", tone: "quiet" },
            ],
            opens: {
              ...(options.threadId ? { threadId: options.threadId } : {}),
              settings: { section: "roles" },
            },
          });
        } catch (postErr) {
          // I2: 積めなかったことを黙らない。断り自体は下で投げ直す
          log(`[banto] 等級の空きを取次へ積めませんでした: ${String(postErr)}`);
        }
        throw err;
      }
    },
  };
}
