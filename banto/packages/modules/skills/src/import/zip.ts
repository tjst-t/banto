// 圧縮ファイル（ZIP）から Skill のフォルダを1つ取り出す（アーキ仕様 §5.7——索引サイトは
// ZIP で配っている）。**ZIP を自分で解かない**（規則12）——fflate を使う。
//
// 取り出す単位は1つの Skill。ZIP の中の置き方はまちまちなので（直下に SKILL.md、
// フォルダ1つの中、さらに入れ子）、**いちばん浅い SKILL.md のあるフォルダ**を
// Skill の根とする。同じ深さに2つあったら、どれか分からないので断る。

import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { SkillSource } from "./source.js";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_TOTAL_BYTES,
  assertSafeRelativePath,
  type ImportedFile,
} from "./limits.js";

/** 圧縮した道具が足す、中身ではないもの（macOS の `__MACOSX/`）。 */
const ARCHIVER_JUNK = /(^|\/)__MACOSX(\/|$)/;

export function readSkillZip(
  bytes: Uint8Array,
  fileName: string,
): { files: ImportedFile[]; source: Extract<SkillSource, { kind: "zip" }> } {
  // 圧縮したままの大きさも見る（展開した合計の上限を超える ZIP は、中身を見るまでもない）
  if (bytes.byteLength > IMPORT_MAX_TOTAL_BYTES) {
    throw new Error(`ZIP が大きすぎます（${bytes.byteLength} バイト、上限 ${IMPORT_MAX_TOTAL_BYTES}）`);
  }
  // 宣言された大きさが嘘でも、展開は宣言の大きさで打ち切られる（fflate は `out` を
  // 渡すと伸ばさない）ので、ここで見る宣言の大きさがそのまま上限になる
  let entries: Record<string, Uint8Array>;
  let count = 0;
  let total = 0;
  try {
    entries = unzipSync(bytes, {
      // **解く前に大きさを見る**（中身を展開してから断ると、爆弾を展開してしまう）
      filter: (file) => {
        if (file.name.endsWith("/") || ARCHIVER_JUNK.test(file.name)) return false;
        count += 1;
        total += file.originalSize;
        if (count > IMPORT_MAX_FILES) throw new Error(`ファイルが多すぎます（上限 ${IMPORT_MAX_FILES}）`);
        if (file.originalSize > IMPORT_MAX_FILE_BYTES) {
          throw new Error(`${file.name} が大きすぎます（${file.originalSize} バイト、上限 ${IMPORT_MAX_FILE_BYTES}）`);
        }
        if (total > IMPORT_MAX_TOTAL_BYTES) throw new Error(`合計が大きすぎます（上限 ${IMPORT_MAX_TOTAL_BYTES} バイト）`);
        return true;
      },
    });
  } catch (err) {
    throw new Error(`ZIP として読めません: ${err instanceof Error ? err.message : String(err)}`);
  }

  const names = Object.keys(entries);
  const skillMds = names.filter((n) => n === "SKILL.md" || n.endsWith("/SKILL.md"));
  if (skillMds.length === 0) throw new Error("ZIP の中に SKILL.md がありません");
  const depth = (n: string) => n.split("/").length;
  const shallowest = Math.min(...skillMds.map(depth));
  const roots = skillMds.filter((n) => depth(n) === shallowest).map((n) => n.slice(0, -"SKILL.md".length));
  if (roots.length > 1) {
    throw new Error(`ZIP に Skill が ${roots.length} つ入っています（${roots.map((r) => r || "/").join("、")}）——1つずつ取り込んでください`);
  }
  const root = roots[0]!;
  const files: ImportedFile[] = [];
  for (const name of names) {
    if (!name.startsWith(root)) continue;
    const path = name.slice(root.length);
    assertSafeRelativePath(path);
    files.push({ path, bytes: entries[name]! });
  }
  return {
    files,
    source: { kind: "zip", fileName, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}
