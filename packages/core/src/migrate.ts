/**
 * 古い版のイベントを、いまの版の形にして読む（ADR-0001 決定7）。
 *
 * 決定7 は2つを同時に定めている——**読めない版に当たったら止まる**ことと、
 * **版を上げたら古い版を読む道を明示的に書く**こと。ここがその「道」である。
 * 道を書かずに版を上げると、それまでのログが読めなくなる。
 *
 * **書き戻さない。** 読むときに形を直すだけで、ファイルは append-only のまま。
 * 書き戻すと、同じ事実が2つの形でログに載る（規則3）。
 *
 * **飛ばさない。** 直せない古い形に当たったら、黙って落とさず呼び手に投げる（規則2）。
 */

/** 版ごとの直しかた。**その版から次の版へ**の1段だけを書く。 */
type Step = (event: Record<string, unknown>) => Record<string, unknown>;

/**
 * 版 1 → 2（2026-08-21）。**Factory を書く前に、語の重なりをまとめて外す。**
 *
 * 1. `run.step` / `runId` → `query.step` / `queryId`。ランタイムへの1回の問い合わせを
 *    指していたのに、Factory の Run と同じ語を使っていた
 * 2. `thread.session.handle` → `sessionHandle`。環境モジュールも handle を返すので、
 *    **鍵になる項目は名前だけで一意**でなければならない
 * 3. `run.step.step` を落とす。常に `'query'` で情報を持たず、しかも Factory は
 *    自分の「段」を持つ（規則3）
 */
const v1ToV2: Step = (event) => {
  const next = { ...event };

  if (next['type'] === 'run.step') {
    next['type'] = 'query.step';
    delete next['step'];
  }
  if ('runId' in next) {
    next['queryId'] = next['runId'];
    delete next['runId'];
  }
  if (next['type'] === 'thread.session' && 'handle' in next) {
    next['sessionHandle'] = next['handle'];
    delete next['handle'];
  }

  return next;
};

/** `UPGRADES[n]` は版 n を版 n+1 にする。**穴を開けない**——開けると静かに素通りする。 */
const UPGRADES: readonly Step[] = [v1ToV2];

/** この実装が読める一番古い版。 */
export const OLDEST_READABLE_VERSION = 1;

/**
 * `from` 版のイベントを、現行版の形にして返す。
 *
 * 返り値の `v` は**現行版に書き換える**。返るのは現行版の形なので、
 * 古い版だと名乗らせると、その先で形と版が食い違う。
 * 原本の版はファイルにそのまま残っている。
 */
export function upgradeEvent(
  event: Record<string, unknown>,
  from: number,
  to: number,
): Record<string, unknown> {
  if (from < OLDEST_READABLE_VERSION) {
    throw new Error(`版 ${from} を読む道が無い（読めるのは ${OLDEST_READABLE_VERSION} 以降）`);
  }

  let current = event;
  for (let v = from; v < to; v += 1) {
    const step = UPGRADES[v - 1];
    // 版が飛んでいる＝道が抜けている。推測して素通りさせない。
    if (!step) throw new Error(`版 ${v} から ${v + 1} への道が無い`);
    current = step(current);
  }
  return { ...current, v: to };
}
