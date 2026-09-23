// 取り込む大きさの上限。**他人のものを置き場に入れる**ので、際限なく受けない。
// 超えたら**理由を言って断る**——黙って一部だけ取り込まない（規則2）。

import { MAX_FILES_PER_SKILL } from "../store.js";

/** 1つの Skill のファイル数。置き場が配る上限と揃える（取り込めても配れない、を作らない）。 */
export const IMPORT_MAX_FILES = MAX_FILES_PER_SKILL;
/** 1ファイルの大きさ。 */
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 1つの Skill の合計。 */
export const IMPORT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export interface ImportedFile {
  /** Skill のフォルダからの相対パス（`/` 区切り）。 */
  path: string;
  bytes: Uint8Array;
}

/** 相対パスとして安全か——置き場の外を指さない、隠しファイルの書き換えにならない。 */
export function assertSafeRelativePath(path: string): void {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(path)) {
    throw new Error(`取り込めないパスが含まれています: ${path}`);
  }
}

/** 数と大きさを見る。**超えていたら、どれが・どれだけかを言う。** */
export function assertWithinLimits(files: ReadonlyArray<{ path: string; size: number }>): void {
  if (files.length > IMPORT_MAX_FILES) {
    throw new Error(`ファイルが多すぎます（${files.length} 個、上限 ${IMPORT_MAX_FILES}）`);
  }
  let total = 0;
  for (const f of files) {
    if (f.size > IMPORT_MAX_FILE_BYTES) {
      throw new Error(`${f.path} が大きすぎます（${f.size} バイト、上限 ${IMPORT_MAX_FILE_BYTES}）`);
    }
    total += f.size;
  }
  if (total > IMPORT_MAX_TOTAL_BYTES) {
    throw new Error(`合計が大きすぎます（${total} バイト、上限 ${IMPORT_MAX_TOTAL_BYTES}）`);
  }
}
