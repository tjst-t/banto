// **その根を選ぶと、何が見えるようになるか**（決定・2026-09-11、ユーザー）。
//
// Project の根は、そのまま閉じ込めの範囲になる（`docs/specs/v4-security.md`）。
// **広い根を選ぶこと自体は止めない**——home を根にして AI に色々やらせたい、
// という使い方を banto が禁じる理由は無い。ただし**選ぶ前に、何が見えるように
// なるかを見せる**（規則13——「見えているものは、繋がっている」の裏返しで、
// 「効いているつもりで効いていない」を作らない）。
//
// 判断はここ1箇所（規則3）——画面が home の場所を推測しない。

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface RootScope {
  /** 閉じ込めが実質的に効かない広さか */
  wide: boolean;
  /** 広いとき、その中に入ってしまうもの（人に見せる用の説明） */
  includes: string[];
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isAncestorOrSelf(candidate: string, of: string): boolean {
  return of === candidate || of.startsWith(candidate.endsWith("/") ? candidate : `${candidate}/`);
}

/**
 * その根が「広い」か——**banto 自身の置き場や資格情報を含んでしまう**かで決める。
 * home かどうかを直接見ない（banto の置き場は設定で動かせる）。
 */
export function describeRootScope(
  root: string,
  opts: { dataDir: string; configDir: string },
): RootScope {
  const real = tryRealpath(root);
  const home = tryRealpath(homedir());
  const sensitive: Array<{ path: string; label: string }> = [
    { path: tryRealpath(opts.configDir), label: "banto の設定とアクセストークン" },
    { path: tryRealpath(opts.dataDir), label: "banto のデータ（全 Project の会話・Memory）" },
    { path: tryRealpath(`${home}/.claude`), label: "Claude の認証情報" },
  ];
  const includes = sensitive.filter((s) => isAncestorOrSelf(real, s.path)).map((s) => s.label);
  return { wide: includes.length > 0, includes };
}
