// 取り込む前に人へ見せるもの（アーキ仕様 §5.7「承認の前に出すもの」）。
//
// - `scripts/` が同梱されているか——banto では**実行しない**（Runner に `Bash` が無い）
// - `Read` / `Bash` を前提にした記述——banto では届かない
//
// **書き換えはしない。** 届かない部分は画面で示すだけ（真実は配り手側、§5.6）。

export interface UnreachableHint {
  /** `SKILL.md` の中の行番号（1 始まり）。 */
  line: number;
  text: string;
}

/** 実行やファイルの直接読み込みを前提にしていそうな行の見分け方（見落としはありうる——目安）。 */
const HINTS: RegExp[] = [
  /```(?:bash|sh|shell|zsh|console)\b/i,
  /\b(?:python3?|node|npx|bash|sh|uv|pip3?|npm)\s+[\w./-]+/,
  /\bscripts\/[\w./-]+/,
  /\b(?:Bash|Read|Write|Edit|Glob|Grep)\s+tool\b/,
  /\buse the (?:Bash|Read|Write|Edit) tool\b/i,
];

export function findUnreachableHints(skillMd: string, max = 20): UnreachableHint[] {
  const out: UnreachableHint[] = [];
  const lines = skillMd.replace(/\r\n/g, "\n").split("\n");
  for (const [i, text] of lines.entries()) {
    if (HINTS.some((re) => re.test(text))) out.push({ line: i + 1, text: text.trim().slice(0, 200) });
    if (out.length >= max) break;
  }
  return out;
}

export function hasScripts(paths: readonly string[]): boolean {
  return paths.some((p) => p.startsWith("scripts/"));
}
