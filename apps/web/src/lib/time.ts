/** 「since からどれだけ経ったか」を日本語で。滞留の長さが要点（要件 A7）。 */
export function elapsedLabel(sinceIso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(sinceIso));
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間${min % 60 > 0 ? `${min % 60}分` : ''}`;
  const day = Math.floor(hour / 24);
  return `${day}日${hour % 24 > 0 ? `${hour % 24}時間` : ''}`;
}

/** 滞留の長さの段階。表示の強さに使う（要件 A7：発生ではなく滞留で目立たせる）。 */
export function stalenessLevel(sinceIso: string, nowMs: number): 'fresh' | 'aging' | 'stale' {
  const min = (nowMs - Date.parse(sinceIso)) / 60_000;
  if (min >= 120) return 'stale';
  if (min >= 30) return 'aging';
  return 'fresh';
}
