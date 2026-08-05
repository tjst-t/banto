/**
 * 記憶の自動抽出（提案§3.4、決定28、task-0022）。
 *
 * ## 設計の要——既存の記憶を書き直させない
 *
 * 「Useful Memories Become Faulty When Continuously Updated by LLMs」（arXiv 2605.12978）は、
 * LLM がエピソードを繰り返し統合すると**有用性が上がったあと下がり、記憶なしのベースラインを
 * 下回る**ことを示した。劣化の原因はエピソードではなく**統合ステップ**にある。
 *
 * だからここでは:
 *
 * 1. **差分しか出させない**（ACE の delta 更新）。「新規追加」か「訂正（旧IDつき）」だけで、
 *    記憶全体をまとめ直すプロンプトは作らない
 * 2. **毎回発火させない**。章を閉じるときだけ（決定28 の「会話の区切り」＝明示的なゲート）
 * 3. **生のエピソードは消さない**。トランスクリプトと引き継ぎ資料が一級の証拠として残り、
 *    記憶が疑わしくなったら遡れる
 *
 * ## 汚染対策（決定28 c）
 *
 * 材料は PO の発言と番頭の発話だけ。ツール出力（ファイルの中身・Web ページ）からは
 * 抽出しない——記憶は長生きするので、外部の文字列が「POの好み」として混ざると効き続ける。
 * 絞り込みは `renderTranscript`（chapters.ts）が担う。
 *
 * D5: 判断は「差分だけを受け取る」という形の制約。何を覚えるかはモデルが決める。
 * D6: 依存は pi-ai（既に banto-host の依存）と banto-core の記憶のみ。
 * I2: 抽出の失敗は握りつぶさずログに残す。ただし**会話は止めない**（task-0022 a5）。
 */

import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type { MemoryKind, MemoryRecord, MemoryStore } from "@banto/core";
import { requireAuth, type AuthResolver } from "./llm-auth.js";

/** 抽出器が出せる差分。**これ以外の操作は無い**（全体の書き直しをさせない）。 */
export type MemoryDelta =
  | { op: "add"; kind: MemoryKind; text: string; validFrom?: string }
  | { op: "supersede"; id: string; kind: MemoryKind; text: string };

const SYSTEM_PROMPT = [
  "You extract long-lived facts about the user from a conversation.",
  "You output ONLY deltas: new memories, or corrections to existing ones.",
  "You never rewrite or merge the existing memory set — that destroys detail.",
  "Extract nothing unless it will still be true and useful in a future session.",
].join(" ");

const FORMAT = `既存の記憶を踏まえ、**新しく覚えるべきこと**と**訂正すべきこと**だけを出力する。

出力は1行1件。該当が無ければ「NONE」とだけ書く。

ADD <kind> <本文>
FIX <既存のID> <kind> <訂正後の本文>

- kind は fact / preference / habit のいずれか
  - fact: 名前・役割・許諾範囲など、導出できず変わらないことが期待される属性
  - preference: 好み。文体や見せ方など「そうしてほしい」こと
  - habit: 習慣。手順やチェックのルーティン
- **その場限りの作業メモは書かない**（「今日バグXを直した」等）。次のセッションでも効くことだけ
- **進行中の経緯も書かない**。それは章の引き継ぎ資料が持つ
- 既存の記憶と同じ内容は書かない
- 事実を好みに入れない`;

export interface MemoryExtractorOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の Model は Api で
  // 型付けされており、呼ぶ側はどの Api かを知らないまま解決した実体を渡す (I4)
  model: Model<any>;
  /** モデルの認証を解決する（`ModelRegistry.getApiKeyAndHeaders` を渡す）。 */
  auth: AuthResolver;
  maxTokens?: number;
}

export interface MemoryExtractionInput {
  /** PO の発言と番頭の発話だけの書き起こし。 */
  transcript: string;
  /** いま有効な記憶。**訂正の宛先を知らせるために渡す**（書き直させるためではない）。 */
  existing: readonly MemoryRecord[];
}

/** LLM で差分を取り出す抽出器を作る。 */
export function createLlmMemoryExtractor(
  options: MemoryExtractorOptions
): (input: MemoryExtractionInput) => Promise<MemoryDelta[]> {
  return async (input) => {
    const existing =
      input.existing.length === 0
        ? "（まだ何も覚えていない）"
        : input.existing.map((r) => `${r.id} [${r.kind}] ${r.text}`).join("\n");

    const prompt = [
      "<existing-memories>",
      existing,
      "</existing-memories>",
      "",
      "<conversation>",
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
        maxTokens: options.maxTokens ?? 1000,
        // I2: 鍵が無いまま呼びに行かない
        ...(await requireAuth(options.auth, options.model, "記憶の抽出")),
      }
    );

    if (response.stopReason === "error") {
      throw new Error(`記憶を抽出できませんでした: ${response.errorMessage ?? "不明"}`);
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return parseDeltas(text);
  };
}

const KINDS: readonly MemoryKind[] = ["fact", "preference", "habit"];

/**
 * 抽出器の出力を差分として読む。
 *
 * **読めない行は捨てる。** 記憶は長生きするので、形式を外れた行を無理に解釈して
 * 覚えるより、覚えないほうが安全（覚え損ねは次の章で拾い直せる）。
 */
export function parseDeltas(text: string): MemoryDelta[] {
  const deltas: MemoryDelta[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "NONE") continue;

    const add = /^ADD\s+(\S+)\s+(.+)$/u.exec(line);
    if (add && isKind(add[1])) {
      deltas.push({ op: "add", kind: add[1], text: add[2]!.trim() });
      continue;
    }
    const fix = /^FIX\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (fix && isKind(fix[2])) {
      deltas.push({ op: "supersede", id: fix[1]!, kind: fix[2], text: fix[3]!.trim() });
    }
  }
  return deltas;
}

function isKind(value: string | undefined): value is MemoryKind {
  return value !== undefined && (KINDS as readonly string[]).includes(value);
}

/** 差分を適用した結果。 */
export interface MemoryApplyResult {
  added: MemoryRecord[];
  corrected: MemoryRecord[];
  /** 適用しなかった差分と、その理由。**黙って捨てない**（I2）。 */
  skipped: Array<{ delta: MemoryDelta; reason: string }>;
}

/**
 * 差分を記憶へ適用する。
 *
 * - 抽出したものは `origin: "extracted"` で保存する（決定28：出所を残し PO が消せるように）
 * - **既に覚えていることは足さない**（task-0022 a6）
 * - 知らないIDの訂正は適用しない——存在しない記憶を訂正しようとするのは、
 *   モデルが ID を捏造した印なので、黙って新規作成すると誤りが増える
 */
export function applyMemoryDeltas(
  store: MemoryStore,
  deltas: readonly MemoryDelta[]
): MemoryApplyResult {
  const result: MemoryApplyResult = { added: [], corrected: [], skipped: [] };
  const known = new Map(store.list().map((r) => [normalize(r.text), r]));

  for (const delta of deltas) {
    if (delta.op === "add") {
      const duplicate = known.get(normalize(delta.text));
      if (duplicate) {
        result.skipped.push({ delta, reason: `既に覚えている（${duplicate.id}）` });
        continue;
      }
      const saved = store.save({
        kind: delta.kind,
        text: delta.text,
        origin: "extracted",
        ...(delta.validFrom ? { validFrom: delta.validFrom } : {}),
      });
      known.set(normalize(saved.text), saved);
      result.added.push(saved);
      continue;
    }

    if (!store.get(delta.id)) {
      result.skipped.push({ delta, reason: `知らないID（${delta.id}）` });
      continue;
    }
    const saved = store.supersede(delta.id, {
      kind: delta.kind,
      text: delta.text,
      origin: "extracted",
    });
    known.set(normalize(saved.text), saved);
    result.corrected.push(saved);
  }
  return result;
}

/** 重複判定のための正規化。空白と大小文字の違いで二重に覚えない。 */
function normalize(text: string): string {
  return text.replace(/\s+/gu, "").toLowerCase();
}
