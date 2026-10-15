// **人の画面で、音を映像の時刻に合わせて鳴らす**（v4-modules.md §4.1「動画で流す」の段4「音」、Backlog #283）。
//
// 画面の中の script（view-app.ts）にそのまま埋め込む（`toString()`）——ここに書くのは関数の宣言だけで、外の名前は引数で
// 受ける（埋め込んだ先に import は無い）。単体の試験はこのファイルを直に読む。
//
// 時計：音と映像の頭の `ts` は Module の機械の CLOCK_MONOTONIC（µs）で、画面の時計（performance.now、ms）とは原点が違う。
// そこで**届いた時刻と ts の差の最小**（`base`——時計の差＋いちばん速く届いたときの道のり）を基準にする。
// - 映像は届いたらすぐ描く。描いた時刻と ts の差から base を引いたもの（`videoLag`——復号と、道のりの揺れ）を、滑らかにして持つ
// - 音は「取り込んだ時刻＋base＋遅らせる分」に鳴らす。遅らせる分は `max(AUDIO_MIN_DELAY_MS, videoLag)`——映像が描かれるのと同じ
//   ころに鳴らす。最低でも AUDIO_MIN_DELAY_MS 遅らせる：Opus の1包み（20ms）がそろうまでと、道のりの揺れを吸う分
//
// **ずれの許し方**（ITU-R BT.1359 の「気づく」境目）：音が映像より **45ms 先**・**125ms 後**まで。続けて鳴らしている音の次の
// 1包みが、目標の時刻より 45ms を越えて早くなるなら目標まで待ち（間に無音が入る）、125ms を越えて遅くなるならその包みを捨てて
// 追いつく。捨て続ける（道のりが遅くなったまま戻らない・時計がずれた）なら基準を取り直す。
//
// 静止で映像の流れが止まっている間（XDamage）は videoLag を最後の値のまま持つ——流れ直した最初の絵も同じころに描かれる。

/** 音が映像より先に鳴ってよい上限（ms） */
export const AUDIO_LEAD_MS = 45;
/** 音が映像より後に鳴ってよい上限（ms） */
export const AUDIO_LAG_MS = 125;
/** 音を最低これだけ遅らせて鳴らす（ms）——1包み 20ms＋道のりの揺れ */
export const AUDIO_MIN_DELAY_MS = 80;
/** 続けてこれだけ捨てたら（ms 分）基準を取り直す */
export const AUDIO_RESYNC_MS = 400;

export interface AudioSyncState {
  /** 届いた時刻（画面の ms）− ts（ms）の最小 */
  base: number | undefined;
  /** 映像の描いた遅れ（base から、ms）。描いていなければ undefined */
  videoLag: number | undefined;
  /** 続けて鳴らしている音の終わり（音の時計の ms）。途切れたら undefined */
  next: number | undefined;
  /** 続けて捨てた長さ（ms） */
  dropped: number;
}

export function newAudioSync(): AudioSyncState {
  return { base: undefined, videoLag: undefined, next: undefined, dropped: 0 };
}

/** 1通が届いた（音でも映像でも）：基準を更新する。arrivedMs は画面の時計、tsMs は Module の時計 */
export function syncArrived(s: AudioSyncState, arrivedMs: number, tsMs: number): void {
  const d = arrivedMs - tsMs;
  if (s.base === undefined || d < s.base) s.base = d;
}

/** 映像の1枚を描いた：描いた遅れを滑らかにして持つ */
export function syncDrawn(s: AudioSyncState, drawnMs: number, tsMs: number): void {
  if (s.base === undefined) return;
  const lag = Math.max(0, drawnMs - tsMs - s.base);
  s.videoLag = s.videoLag === undefined ? lag : s.videoLag * 0.9 + lag * 0.1;
}

/**
 * 音の1包みを鳴らす時刻を決める。nowMs は音の時計の今、offsetMs は「音の時計 − 画面の時計」（いまの写し）、
 * outputMs は鳴らしてから耳に届くまで（AudioContext の outputLatency）。鳴らす時刻（音の時計の ms）か、捨てるなら undefined
 */
export function syncPlan(s: AudioSyncState, tsMs: number, durMs: number, nowMs: number, offsetMs: number, outputMs: number): number | undefined {
  if (s.base === undefined) return undefined;
  const delay = Math.max(AUDIO_MIN_DELAY_MS, s.videoLag ?? 0);
  const want = tsMs + s.base + delay + offsetMs - outputMs;
  let at = s.next ?? want;
  // 先に鳴りすぎる（途切れた後・遅れが縮んだ）——目標まで待つ
  if (at < want - AUDIO_LEAD_MS) at = want;
  // 過ぎた時刻には鳴らせない
  at = Math.max(at, nowMs + 5);
  if (at > want + AUDIO_LAG_MS) {
    // 遅れすぎ——捨てて追いつく。捨て続けるなら基準を取り直す（次の1通から）
    s.dropped += durMs;
    if (s.dropped >= AUDIO_RESYNC_MS) {
      s.base = undefined;
      s.next = undefined;
      s.dropped = 0;
    }
    return undefined;
  }
  s.dropped = 0;
  s.next = at + durMs;
  return at;
}
