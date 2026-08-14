/**
 * 章の引き継ぎ資料を書く要約器（提案§3.2、決定28）。
 *
 * **本セッションとは別の呼び出し**にする。独立したプロンプトなので、番頭の会話の
 * プレフィックスに触らず、プロンプトキャッシュを壊さない（決定28 の要点）。
 * **安いモデルを指定できる**（LLMプロバイダ層はプラガブル）。
 *
 * 入力は PO の発言と番頭の発話だけ（`renderTranscript` が絞る）。ツール出力は入れない
 * ——外部の文字列が引き継ぎ資料を汚すと、それが次の章の前提として効き続ける（決定28 c）。
 *
 * **出力上限に当たって空で返ったら、一度やり直す**（inc-0068）。要約は会話と別の
 * モデルで走るので、出力予算・思考の有無・文脈長が会話側とは別に決まる。1回で
 * 諦めると、**章を畳む道が塞がったまま文脈だけが伸び続ける**——長い会話ほど
 * 起きやすく、長い会話ほど畳めないと困る、という向きに効いてしまう。
 *
 * D5: 判断は無い。プロンプトと、返ってきたものの読み取りだけ。
 * D6: 依存は pi-ai（既に banto-host の依存）のみ。
 * I2: LLM が失敗したら例外にする——引き継ぎ無しで章を畳むのがいちばん困る。
 */

import { completeSimple, type Model } from "@earendil-works/pi-ai/compat";
import type { ChapterHandoff, ChapterInput } from "./chapters.js";
import { requireAuth, type AuthResolver } from "./llm-auth.js";
import type { HandoffSummary } from "./handoffs.js";

const SYSTEM_PROMPT = [
  "You write handoff notes that let a colleague resume an in-progress conversation.",
  "You are NOT summarizing for a reader — you are writing the working state that the next",
  "session will start from. Preserve specifics: names, ids, paths, decisions, numbers.",
  "Never invent facts that are not in the conversation. Write the note in Japanese.",
].join(" ");

const FORMAT = `次の形式で厳密に出力すること。前後に余計な文章を書かない。

TOPIC: <この章で何をしていたかを一行で>
DECIDED:
- <決まったこと。無ければ「なし」>
NEXT:
- <次の一手。無ければ「なし」>
OPEN:
- <保留・未決。無ければ「なし」>
---BODY---
<ここに詳細な引き継ぎ。経緯・前提・試したこと・つまずき・参照すべきIDやパスを、
次の担当がこれだけ読めば再開できる密度で書く。長さの上限は気にしなくてよい。>`;

/**
 * やり直しで使う、**短い**形式（inc-0068）。
 *
 * 1回目が出力上限に当たって空だったということは、予算が本文に届いていない。
 * 同じ密度をもう一度頼んでも同じところで止まるので、**要点だけ**を頼み直す。
 * 考えを書かせないのも同じ理由——本文の前に予算を使わせない。
 */
const COMPACT_FORMAT = `次の形式で厳密に出力すること。**考えたことは書かず、いきなり TOPIC: から書き始める。**

TOPIC: <この章で何をしていたかを一行で>
DECIDED:
- <決まったこと。無ければ「なし」>
NEXT:
- <次の一手。無ければ「なし」>
OPEN:
- <保留・未決。無ければ「なし」>
---BODY---
<引き継ぎの要点だけを箇条書きで。2000字以内。名前・ID・パス・数値は落とさない。>`;

/**
 * 資料の長さの上限（トークン）の既定。
 *
 * **4000 から上げた**（inc-0068）。実機（thread-59）の資料本文は実測 5,800字前後で、
 * 日本語なら 3,000〜4,800トークン——思考トークンを1つも使わなくても 4000 の天井に
 * 当たる大きさだった（実機のモデルへ同じ形で投げると `stopReason: length` で返る）。
 * 本文に届く前に予算が尽きると「空で返る＝畳めない」になるので、既定を広げる。
 */
export const DEFAULT_CHAPTER_MAX_TOKENS = 8000;

/** やり直しで出力予算を何倍にするか（モデル自身の上限で頭打ち）。 */
const RETRY_BUDGET_FACTOR = 4;

/**
 * やり直しで書き起こしをここまで削る（文字）。**新しい側を残す**。
 *
 * 入力が要約器のモデルの文脈長に近づくと、pi は出力予算を
 * `contextWindow - 入力 - 4096` まで切り詰める（pi-ai の `simple-options.ts`）。
 * 際どいところでは残り1トークンまで落ちる——即 `length`・本文ゼロになる。削れば戻る。
 */
const RETRY_TRANSCRIPT_CHARS = 60_000;

/** 要約器が LLM から受け取るもの（pi の `AssistantMessage` のうち、ここで要る部分だけ）。 */
export interface ChapterCompletion {
  stopReason?: string;
  errorMessage?: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * LLM を呼ぶ口。**既定は pi の `completeSimple`**。
 *
 * 差し替えられるようにしてあるのは、上限に当たったときの筋書き（inc-0068）を
 * 本物のモデルを叩かずに試験で押さえるため。
 */
export type ChapterCompleter = (request: {
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
}) => Promise<ChapterCompletion>;

export interface ChapterSummarizerOptions {
  /** 要約に使うモデル。**本セッションと別のものを指定してよい**（決定28）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の Model は Api で
  // 型付けされており、呼ぶ側はどの Api かを知らないまま解決した実体を渡す (I4)
  model: Model<any>;
  /** モデルの認証を解決する（`ModelRegistry.getApiKeyAndHeaders` を渡す）。 */
  auth: AuthResolver;
  /** 資料の長さの上限（トークン）。既定 `DEFAULT_CHAPTER_MAX_TOKENS`。 */
  maxTokens?: number;
  /** LLM を呼ぶ口。渡さなければ pi の `completeSimple`（試験で差し替える）。 */
  complete?: ChapterCompleter;
}

/** 1回分の試みの記録。断りの文言に載せる（inc-0068 の4番）。 */
interface Attempt {
  label: string;
  transcriptChars: number;
  maxTokens: number;
  stopReason: string;
}

/** LLM で引き継ぎ資料を書く要約器を作る。 */
export function createLlmChapterSummarizer(
  options: ChapterSummarizerOptions
): (input: ChapterInput) => Promise<ChapterHandoff> {
  const complete = options.complete ?? piCompleter(options);
  // モデル自身の出力上限。これを超えて頼んでも通らない（プロバイダによっては弾かれる）
  const modelCap = positiveNumber((options.model as { maxTokens?: unknown }).maxTokens);
  const modelName = `${String((options.model as { provider?: unknown }).provider ?? "?")}/${String(
    (options.model as { id?: unknown }).id ?? "?"
  )}`;

  return async (input) => {
    const attempts: Attempt[] = [];

    /**
     * 1回投げて、本文（text ブロック）だけを取り出す。
     *
     * **空で返ってきたら「書けた」ことにしない**（I2・inc-0050）。`stopReason` が
     * `error` でなくても本文が1文字も無いことがある（考えるだけ考えて何も出さない・
     * 上限に当たって出力が空、等）。素通しすると `parseHandoff` が「TOPIC: 前の章の
     * 続き／詳細は空」という**中身の無い資料**を作り、それが書き出されて文脈だけが
     * 畳まれる——実際に thread-50 の第1章がこれで空になった。
     */
    const run = async (
      label: string,
      transcript: string,
      wantTokens: number,
      format: string
    ): Promise<string> => {
      const maxTokens = modelCap === undefined ? wantTokens : Math.min(wantTokens, modelCap);
      const prompt = [
        `<conversation chapter="${input.chapter}">`,
        transcript,
        "</conversation>",
        "",
        format,
      ].join("\n");

      const response = await complete({ systemPrompt: SYSTEM_PROMPT, prompt, maxTokens });

      // I2: 失敗を握りつぶさない。呼び出し側（ChapterKeeper）が章を畳まずに済む
      if (response.stopReason === "error") {
        throw new Error(`章の引き継ぎ資料を作れませんでした: ${response.errorMessage ?? "不明"}`);
      }

      attempts.push({
        label,
        transcriptChars: transcript.length,
        maxTokens,
        stopReason: String(response.stopReason ?? "不明"),
      });

      return response.content
        .filter(
          (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string"
        )
        .map((c) => c.text)
        .join("\n")
        .trim();
    };

    const budget = options.maxTokens ?? DEFAULT_CHAPTER_MAX_TOKENS;
    const first = await run("1回目", input.transcript, budget, FORMAT);
    if (first !== "") return parseHandoff(first);

    /**
     * **上限に当たったからといって、そのまま諦めない**（inc-0068）。
     *
     * 空で返る＝本文に予算が届いていない。手当ては3つとも同時に打つ:
     * ①出力予算を上げる（モデル自身の上限まで）②書き起こしを削る（古い方から。
     * 入力が減れば pi が切り詰める出力予算も戻る）③より短い形式で頼む。
     *
     * それでも空なら、今までどおり**畳まずに断る**——引き継ぎ無しで文脈だけ消すのが
     * いちばん困る、という決め（I2）は変えない。
     */
    const retryBudget = Math.max(
      budget,
      Math.min(budget * RETRY_BUDGET_FACTOR, modelCap ?? Number.POSITIVE_INFINITY)
    );
    const trimmed = trimTranscript(input.transcript, RETRY_TRANSCRIPT_CHARS);
    const second = await run("2回目", trimmed, retryBudget, COMPACT_FORMAT);

    if (second !== "") {
      /**
       * **やり直しで書いたことを資料に残す**（I2）。1回目と密度が違う（短い形式・
       * 書き起こしを削った）ので、読む側が「なぜ薄いのか」を辿れるようにする。
       */
      const handoff = parseHandoff(second);
      const note =
        "\n\n---\n（この資料は2回目の試みで書いた。1回目は出力上限に当たって空だったため、" +
        (trimmed.length < input.transcript.length ? "書き起こしの古い部分を省き、" : "") +
        "短い形式で書き直している。元の書き起こしは会話のセッションに残っている）";
      return { summary: handoff.summary, body: `${handoff.body}${note}` };
    }

    throw new Error(describeEmpty(modelName, modelCap, attempts));
  };
}

/** pi の `completeSimple` を呼ぶ既定の口。 */
function piCompleter(options: ChapterSummarizerOptions): ChapterCompleter {
  return async (request) => {
    // I2: 鍵が無いまま呼びに行かない
    const auth = await requireAuth(options.auth, options.model, "章の引き継ぎ資料");
    const response = await completeSimple(
      options.model,
      {
        systemPrompt: request.systemPrompt,
        messages: [
          { role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: request.maxTokens,
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
      }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の content は
    // ブロックの直和で、ここで見るのは type と text だけ (I4)
    return response as any as ChapterCompletion;
  };
}

/** 書き起こしを後ろ（新しい側）から `limit` 字だけ残す。短ければそのまま。 */
export function trimTranscript(transcript: string, limit: number): string {
  if (transcript.length <= limit) return transcript;
  return (
    `（前略：書き起こしは全体で ${transcript.length} 字あり、出力上限に当たったため` +
    `新しい側の ${limit} 字だけを渡している）\n` +
    transcript.slice(transcript.length - limit)
  );
}

/**
 * **何が使われていたかを断りに載せる**（inc-0068 の4番）。
 *
 * 「BANTO_CHAPTER_MODEL を見直してください」だけでは見直す先が分からない——
 * 指定が無ければ会話のモデルへ落ち、それも解決できなければ番頭の標準へ落ちるので、
 * **実際に使われたモデルは名乗らないと分からない**（実機ではそれが起きていた）。
 * モデル・入力の大きさ・出力上限・やり直したかを書けば、触る設定が読んだ側で決まる。
 */
function describeEmpty(
  modelName: string,
  modelCap: number | undefined,
  attempts: readonly Attempt[]
): string {
  const detail = attempts
    .map(
      (a) =>
        `${a.label}: 書き起こし ${a.transcriptChars}字・出力上限 ${a.maxTokens}トークン・` +
        `stopReason ${a.stopReason}`
    )
    .join("／");
  return (
    "章の引き継ぎ資料が空で返りました（やり直しても空）。章は畳みません。" +
    `使ったモデル: ${modelName}` +
    (modelCap === undefined ? "" : `（このモデルの出力上限 ${modelCap}トークン）`) +
    `。${detail}。` +
    "2回目は出力予算を上げ・書き起こしを削り・短い形式で頼み直している" +
    "——それでも空なので、要約に使うモデル（BANTO_CHAPTER_MODEL）を替えてください"
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 要約器の出力を読み取る。
 *
 * **形式どおりでなくても捨てない。** 読めなかったときは全文を本文として残し、
 * 見出しだけを最小限に組み立てる——資料の中身は失われない（要約を作り直せる方が、
 * 中身を落とすより安い）。
 *
 * **ただし空は別**（I2・inc-0050）。捨てないものが何も無いので、読み取れる形に
 * 仕立てると「TOPIC: 前の章の続き／詳細は空」という中身の無い資料になってしまう。
 * それを書いて文脈を畳むと、引き継ぎ無しで畳んだのと同じ——例外にして畳ませない。
 */
export function parseHandoff(text: string): ChapterHandoff {
  if (text.trim() === "") {
    throw new Error("章の引き継ぎ資料が空です（中身の無い資料は書きません）");
  }
  const [head, body] = splitOnce(text, "---BODY---");

  const topic = matchLine(head, /^TOPIC:\s*(.+)$/mu);
  const decided = matchList(head, "DECIDED");
  const next = matchList(head, "NEXT");
  const open = matchList(head, "OPEN");

  if (topic === undefined) {
    // 形式が読めなかった。全文を本文として残し、見出しは先頭行から作る
    const firstLine = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "前の章の続き";
    return {
      summary: { topic: truncate(firstLine, 120), decided: [], next: [] },
      body: text,
    };
  }

  const summary: HandoffSummary = {
    topic: truncate(topic, 120),
    decided,
    next,
    ...(open.length > 0 ? { open } : {}),
  };
  return { summary, body: (body ?? "").trim() };
}

function splitOnce(text: string, marker: string): [string, string | undefined] {
  const at = text.indexOf(marker);
  if (at === -1) return [text, undefined];
  return [text.slice(0, at), text.slice(at + marker.length)];
}

function matchLine(text: string, pattern: RegExp): string | undefined {
  const m = pattern.exec(text);
  return m?.[1]?.trim();
}

/**
 * `LABEL:` の直後に続く箇条書きを拾う。「なし」だけの行は空として扱う。
 *
 * 正規表現ではなく行で走査する——`LABEL:` から次の見出しまで、という範囲は
 * 行の並びそのもので、regex にすると `\Z` のような方言に足をすくわれる。
 */
function matchList(text: string, label: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${label}:`);
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // 次の見出し（`DECIDED:` 等）に当たったら終わり
    if (/^[A-Z]+:/u.test(line.trim())) break;
    const item = line.replace(/^\s*[-*]\s*/u, "").trim();
    if (item === "" || item === "なし") continue;
    items.push(item);
  }
  return items;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
