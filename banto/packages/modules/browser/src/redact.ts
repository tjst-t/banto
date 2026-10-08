// **AI に返すときに値を伏せるヘッダ**（v4-modules.md §4.1「通信の記録」）。名前と長さだけ残す。
// 人の画面（admin の口）ではそのまま見せる。**本文の中の秘密は伏せない**（見分けられない）——道具の説明にそう書く。

export const REDACTED_HEADERS = ["cookie", "set-cookie", "authorization", "proxy-authorization"] as const;

export function isRedactedHeader(name: string): boolean {
  return (REDACTED_HEADERS as readonly string[]).includes(name.toLowerCase());
}

/** 伏せた値の書き方。長さは文字数（Set-Cookie が複数行なら行ごとに数える） */
export function redactedValue(value: string): string {
  const lines = value.split("\n");
  if (lines.length > 1) return lines.map((l) => `（伏せた・${l.length} 文字）`).join("\n");
  return `（伏せた・${value.length} 文字）`;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = isRedactedHeader(name) ? redactedValue(value) : value;
  return out;
}
