/**
 * 書き込みTool（ADR-0010 決定38・task-0041）。
 *
 * 番頭が**自分の成果物**——決定の記録・`work/` の起票・引き継ぎメモ——をファイルに残すための
 * 道具。決定15 は「番頭が `work/epics`・`work/tasks` を起票する」と定めているのに、番頭は
 * `memory.save` 以外に書き込み手段を持っていなかった（P3）。
 *
 * **既定は読み取り専用。** 場所ごとに PO が許した範囲だけが書ける（決定38a）。許可の宣言は
 * ホスト設定にあり、リポジトリの中には無い——中にあると番頭が宣言を書き換えて自分の権限を
 * 広げられる（決定38b・I1：ずるを不可能にする）。
 *
 * **フレームワークは `docs/` `work/` を知らない**（決定38f）。ここが持つのは「書いてよい範囲が
 * ある」という概念だけで、それが何かは設定が与える。
 *
 * `file-tools.ts` は閲覧専用のまま分けてある。読み取りは場所のルートさえあれば足りるが、
 * 書き込みは場所の**許可の宣言**を見る必要があり、`createFileTools(root)` の形（ルート1つ）
 * では表現できないため（`place-scoped.ts` の包み方が使えない）。
 *
 * D6: node:fs / node:path のみ。
 * I2: 範囲外・許可なし・ディレクトリ上書きは黙って無視せずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";
import { assertWritable, type PlaceRegistry } from "./places.js";

/**
 * 1回に書ける上限。番頭が丸ごと生成したファイルを想定した大きさで、
 * 桁違いの入力（暴走・貼り付け事故）だけを弾く。
 */
const MAX_WRITE_BYTES = 1_000_000;

export interface FileWriteToolOptions {
  /**
   * どの設定でも書けない絶対パス。ホスト自身のデータ置き場を渡す（決定38b・d）。
   * ここを書けると許可の宣言や記憶を書き換えられ、自己昇格が成立する。
   */
  protectedPaths?: readonly string[];
}

/**
 * @param places 場所の帳簿。書き込み範囲は場所ごとに違う（決定38a）
 */
export function createFileWriteTools(
  places: PlaceRegistry,
  options: FileWriteToolOptions = {}
): NamespacedToolDefinition[] {
  const protectedPaths = options.protectedPaths ?? [];

  const write = defineNamespacedTool({
    name: "file.write",
    label: "File: Write",
    description:
      "ファイルを書く（新規作成または全文の上書き）。**書けるのはPOが場所ごとに許した範囲だけ**で、" +
      "既定はどの場所も読み取り専用。許されていなければエラーになり、そのとき何が許されているかも返る。" +
      "自分の成果物（決定の記録・起票・メモ）を残すために使う道具で、実装作業には使わない——" +
      "コードを変えるなら worker.delegate で職人へ委譲すること（D10）。" +
      "コミットはできないので、書いたものは未コミットのまま残りPOのレビューを通る。",
    parameters: Type.Object({
      path: Type.String({
        description: "場所のルートからの相対パス。途中のディレクトリは必要なら作られる",
      }),
      content: Type.String({
        description: "ファイルの中身（全文）。既にあるファイルはこの内容で置き換わる",
      }),
      // `place-scoped.ts` の PLACE_PARAM と同じ名前。番頭にも GUI にも同じ引数に見える
      place: Type.Optional(
        Type.String({
          description:
            "どの場所に書くか。登録されている場所の id。場所が1つだけなら省略できる",
        })
      ),
    }),
    async execute(params) {
      // I2: 複数あるのに省略されたらここで止まる（黙って別の場所に書かない）
      const place = await places.resolve(params.place);
      // I2: 許可の判定。範囲外・読み取り専用・.git/・ホストのデータ置き場はここで落ちる
      const target = assertWritable(place, params.path, protectedPaths);

      const bytes = Buffer.byteLength(params.content, "utf-8");
      if (bytes > MAX_WRITE_BYTES) {
        throw new Error(`content が大きすぎます（${bytes} bytes / 上限 ${MAX_WRITE_BYTES}）。`);
      }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        throw new Error(`${params.path} はディレクトリです。`);
      }

      const existed = fs.existsSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, params.content, "utf-8");

      const relative = path.relative(place.path, target);
      const what = existed ? "上書き" : "新規作成";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${what}: ${place.label} / ${relative}（${bytes} bytes）\n` +
              "未コミットのまま残ります（番頭はコミットできません）。",
          },
        ],
        details: {
          place: { id: place.id, label: place.label },
          path: relative,
          bytes,
          created: !existed,
        },
      };
    },
  });

  return [write];
}
