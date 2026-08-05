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
 * D5: 判断は無い。プロンプトと、返ってきたものの読み取りだけ。
 * D6: 依存は pi-ai（既に banto-host の依存）のみ。
 * I2: LLM が失敗したら例外にする——引き継ぎ無しで章を畳むのがいちばん困る。
 */

import { completeSimple, type Model } from "@mariozechner/pi-ai";
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

export interface ChapterSummarizerOptions {
  /** 要約に使うモデル。**本セッションと別のものを指定してよい**（決定28）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の Model は Api で
  // 型付けされており、呼ぶ側はどの Api かを知らないまま解決した実体を渡す (I4)
  model: Model<any>;
  /** モデルの認証を解決する（`ModelRegistry.getApiKeyAndHeaders` を渡す）。 */
  auth: AuthResolver;
  /** 資料の長さの上限（トークン）。既定 4000。 */
  maxTokens?: number;
}

/** LLM で引き継ぎ資料を書く要約器を作る。 */
export function createLlmChapterSummarizer(
  options: ChapterSummarizerOptions
): (input: ChapterInput) => Promise<ChapterHandoff> {
  return async (input) => {
    // I2: 鍵が無いまま呼びに行かない
    const auth = await requireAuth(options.auth, options.model, "章の引き継ぎ資料");
    const prompt = [
      `<conversation chapter="${input.chapter}">`,
      input.transcript,
      "</conversation>",
      "",
      FORMAT,
    ].join("\n");

    const response = await completeSimple(
      options.model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: options.maxTokens ?? 4000,
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
      }
    );

    // I2: 失敗を握りつぶさない。呼び出し側（ChapterKeeper）が章を畳まずに済む
    if (response.stopReason === "error") {
      throw new Error(`章の引き継ぎ資料を作れませんでした: ${response.errorMessage ?? "不明"}`);
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return parseHandoff(text);
  };
}

/**
 * 要約器の出力を読み取る。
 *
 * **形式どおりでなくても捨てない。** 読めなかったときは全文を本文として残し、
 * 見出しだけを最小限に組み立てる——資料の中身は失われない（要約を作り直せる方が、
 * 中身を落とすより安い）。
 */
export function parseHandoff(text: string): ChapterHandoff {
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
