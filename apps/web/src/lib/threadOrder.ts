import type { ThreadStatus } from './types';

/**
 * 状態の並び順（要件 A7 と同じ考え：目立たせるのは滞留・判断待ち）。
 * **数が小さいほど先に出す。** サイドバーの「開いているもの」やダイアログの一覧で共通に使う
 * ——並び順の規則を2箇所に書かない（規則3）。
 */
const ORDER: Record<ThreadStatus, number> = {
  'waiting-on-human': 0,
  blocked: 1,
  working: 2,
  done: 3,
};

export function statusOrder(status: ThreadStatus): number {
  return ORDER[status];
}

/**
 * 画面に出す状態。`ThreadStatus` に `idle` を足しただけ（新しい真実は作らない・規則3）。
 *
 * **`thread.created`／`thread.forked` は、状態を `working` で初期化する**
 * （`packages/core/src/fold.ts`）——「done でも blocked でも waiting でもない」の意味で、
 * 「いま処理が動いている」の意味ではない。だが画面の `working` は青い塗り・「作業中」で
 * **動いていることを示す色**を使っているので、**ターンが1つも無いのに動いて見える**
 * （PO指摘・2026-08-22：「開いた直後のフォークは何もやっていなくても青い塗りになる」）。
 *
 * 直し方は2つあった：①`working` の意味自体を変える（core の話になる・規則7でスコープ外）
 * ②**画面側で「ターンが無い working」を別の見た目にする**。②を採る——
 * `turnCount` は実在する値で、作文していない。
 */
export type DisplayStatus = ThreadStatus | 'idle';

export function displayStatus(status: ThreadStatus, turnCount: number): DisplayStatus {
  return status === 'working' && turnCount === 0 ? 'idle' : status;
}
