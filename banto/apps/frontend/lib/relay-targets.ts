// **まとめて引く口のカード**（追加・2026-10-18、v4-frontend.md「Module 間中継の承認」）。host の中継の承認は、1回で複数の
// 対象を持つ呼び出し（Vault の `resolveAliases`）では `toolInput.対象` を要素ごとの識別子の配列で渡す。画面はそれを
// JSON のまま出さず、1行1件の表（name・group）にする。形の真実は host（`packages/core/src/relay/approval-gate.ts`）

/** 承認のカードの中身の、対象の一覧を分けたもの。`targets` が無ければ、今までどおり中身をそのまま出す */
export interface SplitTargets {
  rest: unknown;
  targets?: { columns: string[]; rows: Record<string, string>[] };
}

const TARGETS_KEY = "対象";

export function splitTargets(input: unknown): SplitTargets {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { rest: input };
  const { [TARGETS_KEY]: raw, ...rest } = input as Record<string, unknown>;
  if (!Array.isArray(raw)) return { rest: input };
  const rows: Record<string, string>[] = [];
  for (const el of raw) {
    // 形が違うものが混ざっていたら表にしない（黙って落とさない——中身をそのまま出す）
    if (typeof el !== "object" || el === null || Array.isArray(el)) return { rest: input };
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(el as Record<string, unknown>)) {
      if (typeof v !== "string") return { rest: input };
      row[k] = v;
    }
    rows.push(row);
  }
  // 列は現れた順（`resolveAlias` なら name・group）
  const columns: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  return { rest, targets: { columns, rows } };
}
