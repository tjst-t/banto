// **取ってきた配布物の置き場**（追加・2026-09-21）。
//
// **真実は一箇所**（規則3）——入れるとき（HTTP の口）と起動するとき（`cli.ts`）で
// 別々に組み立てると、いつか食い違って「入れたのに見つからない」になる。

import { join } from "node:path";

/**
 * その Module のプログラムの置き場。
 *
 * **状態の置き場（`modules/<名前>`）とは別**——起動時に渡す権限が違う
 * （こちらは読み取り専用、あちらは読み書き）。同じにすると、動いている Module が
 * 自分のプログラムを書き換えられる。
 *
 * **名前ごとに分ける**——同じパッケージを別の名前で2本入れられる
 * （接続先ごとに1本、`installFromCatalog` と同じ考え方）。
 */
export function modulePackageDirOf(dataDir: string, moduleName: string): string {
  return join(dataDir, "module-packages", moduleName);
}
