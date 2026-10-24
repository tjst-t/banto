// **API キーのアカウントの金額の目安**（`docs/specs/v4-distribution.md` §3「使用量」）。値段の表は banto に版つきで持つ
// （出どころと更新の仕方は §10 の未決——当面は人が Anthropic の値段の表を見て、この表と版を書き換える）。
//
// 目安であって請求ではない：表に無いモデルは金額に入れず（トークンは数える）、どのモデルが表に無かったかを残す。

/** この表の版（書き換えたら上げる。画面が「何の値段で数えたか」を出す） */
export const PRICE_TABLE_VERSION = "2026-10-24";

/** 100万トークンあたりの米ドル */
interface ModelPrice {
  input: number;
  output: number;
  /** キャッシュの書き（寿命5分） */
  cacheWrite: number;
  /** キャッシュの書き（寿命1時間） */
  cacheWrite1h: number;
  cacheRead: number;
}

/** 書きは入力の 1.25 倍（5分）・2 倍（1時間）、読みは 0.1 倍——読みの値段が違うモデルは個別に書く */
function price(input: number, output: number, cacheRead = input * 0.1): ModelPrice {
  return { input, output, cacheWrite: input * 1.25, cacheWrite1h: input * 2, cacheRead };
}

/**
 * 頭が合う最初の行を使う（`claude-opus-4-5-20251101`・`claude-opus-5-5[1m]` のような尻尾がつく）。長い名前を先に置く
 * （`claude-opus-5-5` を `claude-opus-5` より前に）
 */
const PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ["claude-fable-5-1", price(10, 50, 0.25)],
  ["claude-fable-5", price(10, 50)],
  ["claude-mythos-5", price(10, 50)],
  ["claude-opus-5-5", price(4, 20, 0.2)],
  ["claude-opus-5", price(5, 25)],
  ["claude-opus-4-8", price(5, 25)],
  ["claude-opus-4-7", price(5, 25)],
  ["claude-opus-4-6", price(5, 25)],
  ["claude-opus-4-5", price(5, 25)],
  ["claude-sonnet-5", price(2, 10)],
  ["claude-sonnet-4", price(3, 15)],
  ["claude-haiku-4-5", price(1, 5)],
];

export function priceOf(model: string): ModelPrice | undefined {
  return PRICES.find(([prefix]) => model.startsWith(prefix))?.[1];
}

/** 応答1つ分の使ったトークン（`usage` の形をそのまま読んだもの） */
export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
  /** キャッシュの書き（寿命を問わず全部） */
  cacheWriteTokens: number;
  /** そのうち寿命1時間のもの（分からなければ 0——全部5分の値段で数える） */
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

/** 金額の目安（米ドル）。表に無いモデルは undefined */
export function costOf(model: string, t: TokenCount): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const write5m = Math.max(0, t.cacheWriteTokens - t.cacheWrite1hTokens);
  return (
    (t.inputTokens * p.input + t.outputTokens * p.output + write5m * p.cacheWrite + t.cacheWrite1hTokens * p.cacheWrite1h + t.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}
