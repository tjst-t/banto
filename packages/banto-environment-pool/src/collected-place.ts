/**
 * 回収した成果物を「読める場所」として出す（imp-0007 の裁定・2026-08-01）。
 *
 * **回収先を Pool が決めるだけでは足りない。** 置き場所は `<dataDir>/collected` で、
 * そこは場所（Place）として登録されていないので、`file.read` は砦に弾かれる
 * ——**回収したのに読めない**（PO指摘）。
 *
 * そこで回収先を**読み取り専用の場所**として登録する。番頭は返ってきたパスをそのまま
 * `file.*` で読め、書き込みは開かない（`writable` を付けない）。呼び出し側に回収先の
 * パスを書かせる案（＝砦を通らない穴）を避けつつ、読めるようにする形。
 */

import * as fs from "node:fs";
import type { Place, PlaceProvider } from "@banto/core";

/** 場所の id。番頭が `file.list` などで指すときに使う。 */
export const COLLECTED_PLACE_ID = "検証の成果物";

/**
 * @param root `EnvironmentPool.collectedRoot()` の値
 */
export function createCollectedPlaceProvider(root: string): PlaceProvider {
  return {
    name: "environment-pool",
    list: async (): Promise<Place[]> => {
      // まだ何も回収していないなら場所として出さない（空の場所を並べても邪魔なだけ）
      if (!fs.existsSync(root)) return [];
      return [
        {
          id: COLLECTED_PLACE_ID,
          label: "検証の成果物（読み取り専用）",
          path: root,
          // writable を付けない＝読むだけ。回収したものを番頭が書き換える理由はない
        },
      ];
    },
  };
}
