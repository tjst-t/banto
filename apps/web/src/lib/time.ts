/**
 * 時刻の書き方。**画面のどこでも同じ形にする**——同じ時刻が場所によって
 * 「14:05」だったり「14:05:33」だったりすると、読む側は毎回読み替えることになる。
 */

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

/** `14:05`。秒は出さない——会話の速さは秒で読むものではない。 */
export const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

/** `2026年8月21日(金)`。日付の境目にだけ出す。 */
export const dateLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });

/**
 * ここで日付が変わったか。
 *
 * **前の行が無ければ「変わった」**——会話の頭にも日付が要る。
 * どちらかの時刻が読めないときは挟まない（当てずっぽうで線を引かない）。
 */
export function isNewDay(at: string | undefined, prevAt: string | undefined): boolean {
  if (at === undefined) return false;
  if (prevAt === undefined) return true;
  return dateLabel(at) !== dateLabel(prevAt);
}
