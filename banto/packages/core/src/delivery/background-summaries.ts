// **裏の仕事の要約を core が作る・札の1件に重ねる**（決定・2026-10-20、ユーザー。レビューを反映・2026-10-21。アーキ仕様 §4.2
// 「札の手がかりを Module があとから足す」の 2.・3.、§4.1「4.」、Backlog #489）。
//
// Module（いまはサブエージェント）は人が「いまの様子を要約」を押したときだけ、材料を host の口 `relaySummarizeBackgroundWork` に
// 渡す。core が小さいモデル（`runner/one-shot.ts` の `askSmallModel`、本体の Claude のログイン）で1回だけ作って返す。
// **指示（system prompt）とモデルは core が持つ**——ここ1か所。
//
// - 札（`replyTo`）は `ReplyHandles.get()` で引き、渡してきた Module の札かだけを照らす。`use()` と違って回数を数えない
//   （届けではない）。`finalOnly` の札（起こし直しで覚え直した札）でも受ける。違う Module の札は理由つきで断る
// - まだ返事待ちで宛先が Thread の札なら、要約を下の表に置いて画面に知らせる（`onPlaced`）。宛先が Module の札・済んだ札・
//   札が無いときは、作って返すが置かない（Module の画面には出る）
// - 同じ札（無ければ Module＋`workId`）で同時に1つ、前の要約から 10 秒あける
// - **表は host のメモリだけ**（`replyTo` → `{ summary, summaryAt }`）。札が済んだら消す。Event Store には書かない——起こし直しで
//   消えてよい（人が見る画面の写しは Module の仕事の記録に残る）
// - **AI には見せない**——表を重ねるのは画面に流す一覧だけ（`backgroundItemsOf` の呼び元が渡す）

import {
  BACKGROUND_SUMMARY_INTERVAL_MS,
  BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS,
  BACKGROUND_SUMMARY_WORK_ID_MAX,
} from "@banto/module-contract";
import type { ReplyHandle } from "./reply-handles.js";

/** 要約の指示（§4.1「4.」）。`askSmallModel` は答えの最初の空でない行だけを返すので、1行で答えさせる */
export const BACKGROUND_SUMMARY_SYSTEM_PROMPT = [
  "You summarize a piece of background work that an AI agent is doing, for the person who asked for it.",
  "The user message is what banto can see of the work: the request, the to-do list, recent steps, the latest remarks and the files touched.",
  "Reply in Japanese, on one line, in at most two sentences: what it is doing now and how far it has got.",
  "If you are guessing, say that it is a guess. No preamble, no quotes, no markdown.",
].join("\n");

/** 札の1件に重ねる要約 */
export interface BackgroundSummary {
  summary: string;
  /** 作った時刻（ISO、host が刻む） */
  summaryAt: string;
}

/** 札から重ねる要約を引く（`backgroundItemsOf` に渡す形） */
export type BackgroundSummaryOf = (replyTo: string) => BackgroundSummary | undefined;

/** AI に見せる文を作る呼び元が渡す——要約は重ねない（§4.1「4.」） */
export const WITHOUT_SUMMARIES: BackgroundSummaryOf = () => undefined;

export class BackgroundSummaries {
  private readonly table = new Map<string, BackgroundSummary>();
  private readonly inFlight = new Set<string>();
  /** 鍵 → 前の要約が終わった時刻 */
  private readonly lastAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      handles: { get(id: string): ReplyHandle | undefined };
      /**
       * 小さいモデルを1回呼ぶ（`askSmallModel`。失敗は投げる）。`projectId` は本体のログインの中継の鍵（札の Project、無ければ
       * 呼んだ Module の Project）
       */
      ask: (input: { systemPrompt: string; prompt: string; projectId: string }) => Promise<string>;
      /** 要約をその Thread の札に置いた（画面に `background.changed` を流す） */
      onPlaced: (threadId: string) => void;
      now?: () => number;
      intervalMs?: number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** 札に重ねた要約（画面に流す一覧だけが引く） */
  readonly of: BackgroundSummaryOf = (replyTo) => this.table.get(replyTo);

  /** 札が済んだ（`ReplyHandles.onSettled`） */
  forget(replyTo: string): void {
    this.table.delete(replyTo);
  }

  /**
   * 要約を作って返す。断る・失敗したら理由（Module はそのまま画面に出す）
   */
  async summarize(
    caller: { moduleName: string; connName?: string; projectId?: string },
    input: { replyTo?: unknown; material?: unknown },
  ): Promise<{ summary: string } | { error: string }> {
    const material = input.material as { workId?: unknown; text?: unknown } | undefined;
    const workId = typeof material?.workId === "string" ? material.workId.trim() : "";
    const text = typeof material?.text === "string" ? material.text : "";
    if (!workId) return { error: "material.workId が要ります" };
    if (workId.length > BACKGROUND_SUMMARY_WORK_ID_MAX) return { error: `material.workId は ${BACKGROUND_SUMMARY_WORK_ID_MAX} 字までです` };
    if (text.trim() === "") return { error: "material.text が空です（要約する材料がありません）" };
    if (input.replyTo !== undefined && (typeof input.replyTo !== "string" || input.replyTo === "")) {
      return { error: "replyTo は host が渡した札（文字列）で渡してください" };
    }
    const replyTo = input.replyTo as string | undefined;

    // **札は持ち主だけを照らす**（回数は数えない）。もう無い札（届け済み・起こし直し）は断らない——要約は作って返す
    const handle = replyTo ? this.deps.handles.get(replyTo) : undefined;
    if (handle && (caller.moduleName !== handle.moduleName || (caller.connName !== undefined && caller.connName !== handle.connName))) {
      return { error: "この返信用の札は、あなたに渡したものではありません" };
    }

    // 本体のログインの中継は Project で鍵を分ける——どの Project の仕事か決められなければ作らない（黙って別のログインで呼ばない）
    const projectId = handle?.projectId ?? caller.projectId;
    if (!projectId) return { error: "どの Project の仕事か決められないので、要約を作れません（札を添えるか、Project ごとの Module から頼んでください）" };

    const key = replyTo ?? `${caller.connName ?? caller.moduleName}\u0000${workId}`;
    const interval = this.deps.intervalMs ?? BACKGROUND_SUMMARY_INTERVAL_MS;
    this.forgetOld(interval);
    if (this.inFlight.has(key)) return { error: "この仕事の要約は、いま作っているところです" };
    const last = this.lastAt.get(key);
    if (last !== undefined && this.now() - last < interval) {
      const wait = Math.ceil((interval - (this.now() - last)) / 1000);
      return { error: `前の要約から ${Math.round(interval / 1000)} 秒あけてください（あと ${wait} 秒）` };
    }

    this.inFlight.add(key);
    let summary: string;
    try {
      summary = cleanSummary(
        await this.deps.ask({
          systemPrompt: BACKGROUND_SUMMARY_SYSTEM_PROMPT,
          prompt: clipChars(text, BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS),
          projectId,
        }),
      );
    } catch (err) {
      return { error: `要約を作れませんでした：${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.inFlight.delete(key);
      this.lastAt.set(key, this.now());
    }
    if (!summary) return { error: "要約を作れませんでした：小さいモデルの答えが空でした" };

    // **置くのは、まだ返事待ちで宛先が Thread の札だけ**——作っている間に済んだかもしれないので引き直す
    const placeOn = replyTo ? this.deps.handles.get(replyTo) : undefined;
    if (replyTo && placeOn?.awaiting && !placeOn.toModule && placeOn.threadId) {
      this.table.set(replyTo, { summary, summaryAt: new Date(this.now()).toISOString() });
      this.deps.onPlaced(placeOn.threadId);
    }
    return { summary };
  }

  private forgetOld(interval: number): void {
    const now = this.now();
    for (const [key, at] of this.lastAt) if (now - at >= interval) this.lastAt.delete(key);
  }
}

/** 字（コードポイント）で頭から切る */
function clipChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** 小さいモデルの答えを要約の形に整える（頭の「要約：」・囲みの引用符を落とす） */
export function cleanSummary(answer: string): string {
  return answer
    .trim()
    .replace(/^(summary|要約)\s*[:：]\s*/i, "")
    .replace(/^["'「『“]+|["'」』”]+$/g, "")
    .trim();
}
