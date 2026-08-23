/**
 * 作業範囲の内側に閉じ込める（要件 D4）。
 *
 * fs・repo・env-process・env-docker の4モジュールが同じ判定を別々に持っていた
 * ——境界チェックはセキュリティ上効いている箇所なので、1箇所だけ直し忘れる
 * リスクを避ける（規則3：真実は一箇所）。
 *
 * **判定は正規化してから**行う——`..` も symlink も、文字列の見た目では防げない。
 */

import path from 'node:path';

export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`許された範囲の外: ${relative}（root=${base}）`);
  }
  return target;
}
