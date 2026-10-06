// **ターンの終わりのまとめ**（決定・2026-10-06、ユーザー。アーキ仕様 §2.2「ターンの終わりのまとめ」・v4-frontend.md §6.35）。
//
// Fork を何本も並べると、各 Thread の最後を見ても「何を頼んで、何が出てきたのか」が分からない。AI が人に返すターンの
// 最後に core の tool `report_turn` を1回呼び、「頼んだこと（文脈から書き直す）・結果・人が決めること（返答の候補つき）」を
// 決まった形で渡す。画面はそれを会話のそのターンの一番下に、普通の発言と見分けのつく票として出す。
//
//  - **Project ごとのスイッチ**（既定はオフ、ユーザー）。オフなら tool も指示も Stop hook も渡さない
//  - **呼び忘れは Stop hook で一度だけ差し戻す**（ユーザー）。SDK の `stop_hook_active` が立っていれば止めない——毎回
//    差し戻すと終わらなくなる（偽の API の実測、`probes/turn-summary-stop-hook.mjs`）
//  - **形に合わないものは断って直させる**（理由を文で返す）
//  - **元の人の発言は AI に引用させない**——画面が会話の記録から取る（言い換えが混ざらない）
import { z } from "zod";
import type { RuntimeConfigStore } from "../config/runtime.js";

/** Configuration の鍵（真偽値）。**Project にだけ置ける**——既定はオフ */
export const TURN_SUMMARY_KEY = "thread.turnSummary";

export const REPORT_TURN_TOOL_NAME = "report_turn";

/** その Project でオンか。Project の層だけを読む */
export function isTurnSummaryEnabled(
  config: Pick<RuntimeConfigStore, "layerValue"> | undefined,
  projectId: string,
): boolean {
  return config?.layerValue(TURN_SUMMARY_KEY, projectId) === true;
}

export const TURN_SUMMARY_LIMITS = {
  points: 3,
  decisions: 4,
  optionsMin: 2,
  optionsMax: 4,
  nextSuggestions: 4,
} as const;

const option = z.object({
  label: z.string().describe("ボタンに出す短い言葉（例「反映して」）"),
  reply: z
    .string()
    .describe("押すと人の入力欄に入る文。そのまま送れば通じる具体的な文にする（「A で」ではなく「案A で。○○して」）"),
  recommended: z.boolean().optional().describe("あなたのおすすめ。1つの問いに1つまで"),
});

/** tool の引数の形（SDK の tool() に渡す） */
export const reportTurnShape = {
  request: z
    .string()
    .describe(
      "人に頼まれたことを具体的に1〜2文で。人の言葉をなぞらない——「それでお願い」「さっきの直して」なら、何を指すかを前の話から補って書く",
    ),
  outcome: z
    .object({
      status: z.enum(["done", "partial", "failed"]).describe("done=頼まれたことは終わった／partial=途中まで／failed=できなかった"),
      headline: z.string().describe("結果を1文で。作業を見ていない・前の話を覚えていない人にも分かる言葉で"),
      points: z.array(z.string()).describe(`分かったこと・変えたこと（${TURN_SUMMARY_LIMITS.points}つまで、無ければ空）`),
      notVerified: z.array(z.string()).optional().describe("確かめていないこと・残っていること。確かめたように書かない"),
      artifacts: z
        .array(z.object({ label: z.string().describe("種類（例「コミット」「URL」）"), detail: z.string() }))
        .optional()
        .describe("できたもの（コミット・ファイル・URL など）"),
    })
    .describe("結果"),
  decisions: z
    .array(
      z.object({
        question: z.string().describe("人が決めることを問いの形で1文"),
        context: z.string().optional().describe("決めるのに要る背景（1〜2文）。無くても決められるなら省く"),
        options: z
          .array(option)
          .describe(`返答の候補（${TURN_SUMMARY_LIMITS.optionsMin}〜${TURN_SUMMARY_LIMITS.optionsMax}個）`),
      }),
    )
    .describe("人が答えないと先へ進めないことだけ。無ければ空"),
  nextSuggestions: z
    .array(option)
    .optional()
    .describe(`決めることが無いときの「次に頼めること」（${TURN_SUMMARY_LIMITS.nextSuggestions}個まで）`),
};

const reportTurnSchema = z.object(reportTurnShape);
export type TurnSummary = z.infer<typeof reportTurnSchema>;

/** 記録に残す形（`message.appended` の `turnSummary`）。時刻は host が付ける */
export interface TurnSummaryEntry {
  summary: TurnSummary;
  /** 受け付けた時刻（ISO） */
  at: string;
}

const blank = (s: string | undefined) => s === undefined || s.trim() === "";

/** 中身を確かめる。断る理由を文で返す（AI が読んで直せるように）。通れば `undefined` */
export function validateTurnSummary(input: TurnSummary): string | undefined {
  const problems: string[] = [];
  if (blank(input.request)) problems.push("request（頼まれたこと）が空です。");
  if (blank(input.outcome.headline)) problems.push("outcome.headline（結果の1文）が空です。");
  if (input.outcome.points.length > TURN_SUMMARY_LIMITS.points) {
    problems.push(`outcome.points は ${TURN_SUMMARY_LIMITS.points} つまでです（${input.outcome.points.length} つあります）。大事なものに絞ってください。`);
  }
  if (input.outcome.points.some((p) => blank(p))) problems.push("outcome.points に空のものがあります。");
  if (input.decisions.length > TURN_SUMMARY_LIMITS.decisions) {
    problems.push(`decisions は ${TURN_SUMMARY_LIMITS.decisions} つまでです。`);
  }
  input.decisions.forEach((d, i) => {
    const at = `decisions[${i}]`;
    if (blank(d.question)) problems.push(`${at}.question が空です。`);
    if (d.options.length < TURN_SUMMARY_LIMITS.optionsMin || d.options.length > TURN_SUMMARY_LIMITS.optionsMax) {
      problems.push(`${at}.options は ${TURN_SUMMARY_LIMITS.optionsMin}〜${TURN_SUMMARY_LIMITS.optionsMax} 個にしてください（${d.options.length} 個あります）。`);
    }
    if (d.options.filter((o) => o.recommended === true).length > 1) problems.push(`${at} のおすすめ（recommended）は1つまでです。`);
    if (d.options.some((o) => blank(o.label) || blank(o.reply))) problems.push(`${at}.options に label か reply が空のものがあります。`);
  });
  const next = input.nextSuggestions ?? [];
  if (next.length > TURN_SUMMARY_LIMITS.nextSuggestions) problems.push(`nextSuggestions は ${TURN_SUMMARY_LIMITS.nextSuggestions} 個までです。`);
  if (next.some((o) => blank(o.label) || blank(o.reply))) problems.push("nextSuggestions に label か reply が空のものがあります。");
  if (problems.length === 0) return undefined;
  return `まとめを受け付けられませんでした。直してもう一度 report_turn を呼んでください：\n${problems.map((p) => `- ${p}`).join("\n")}`;
}

/** そのターンで受け付けたまとめ（turn-runner が Stop hook で見る） */
export interface TurnSummaryState {
  accepted?: TurnSummaryEntry;
}

export const REPORT_TURN_DESCRIPTION = [
  "このターンのまとめを人に渡す。人に返すターンの最後に必ず1回呼ぶ（短い受け答えでも）。",
  "人は作業を見ておらず、前の話を覚えていないこともある——頼まれたこと・結果・人が決めること（返答の候補つき）を、",
  "それだけ読めば分かるように書く。画面はこれを会話のそのターンの一番下に出す。呼んだらターンを終える。",
].join("");

export const REPORT_TURN_ACCEPTED_TEXT = "記録した。これでターンを終える——このあとに文や tool の呼び出しを続けない。";

/** Stop hook の差し戻しの理由（モデルに「Stop hook feedback」として見える） */
export const REPORT_TURN_MISSING_REASON =
  "まだこのターンのまとめを出していません。report_turn を1回呼んでから終えてください（前の話を覚えていない人にも分かるように）。";

/**
 * Stop hook の判断。差し戻すなら理由を返す。**`stop_hook_active` なら差し戻さない**（一度だけ）
 */
export function turnSummaryStopDecision(state: TurnSummaryState, stopHookActive: boolean): string | undefined {
  if (stopHookActive) return undefined;
  if (state.accepted) return undefined;
  return REPORT_TURN_MISSING_REASON;
}

/** システムプロンプトに足す節（スイッチがオンの Project だけ） */
export const TURN_SUMMARY_PROMPT_SECTION = `# 人に返すとき（ターンの終わりのまとめ）

人に返すターンの最後に、必ず report_turn を1回呼ぶ。短い受け答えでも呼ぶ。呼んだらターンを終える——後ろに文や tool の呼び出しを続けない。報告の本文はいつもどおり書き、report_turn はその要約にする。

- request：人の言葉をなぞらず、何を頼まれたかを具体的に書く。「それでお願い」「さっきの直して」なら、何を指すかを前の話から補う。
- outcome：作業を見ていない人が、前の話を覚えていなくても分かるように書く。確かめていないことは notVerified に書き、確かめたように書かない。
- decisions：人が答えないと先へ進めないことだけを書く。options の reply は、そのまま送れば通じる文にする（「A で」ではなく「案A で。○○して」）。
- 人に聞くことが無ければ decisions は空にし、次に頼めることを nextSuggestions に書く。`;
