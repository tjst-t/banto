// **Project ごとの「AI への指示」**（決定・2026-10-09、ユーザー。アーキ仕様 §2.3「Project ごとの『AI への指示』」・
// v4-frontend.md §6.17）。
//
// 人が Project ごとに、土台の指示（system prompt の層3の末尾）へ書き足す自由文。Memory（AI が残す決まったことの一覧）とは
// 別で、人が丸ごと書き直す1枚の文章。**毎ターン読む**——書き換えたら次のターンから、その Project の全 Thread に効く。
// 人の画面からだけ書く（AI から書き換える口は作らない）。CLAUDE.md は読まない（`settingSources: []` のまま）
import type { RuntimeConfigStore } from "../config/runtime.js";

/** Configuration の鍵（文字列）。**Project にだけ置ける**——空なら無し */
export const PROJECT_INSTRUCTION_KEY = "thread.instruction";

/** 長さの上限（字）。超えたら保存を断る（§2.3、仮） */
export const PROJECT_INSTRUCTION_MAX_CHARS = 8_000;

/** その Project の指示。Project の層だけを読む。無い・空なら `undefined` */
export function projectInstructionOf(
  config: Pick<RuntimeConfigStore, "layerValue"> | undefined,
  projectId: string,
): string | undefined {
  const value = config?.layerValue(PROJECT_INSTRUCTION_KEY, projectId);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 保存してよいか。断るなら理由を文で返す。通れば `undefined` */
export function validateProjectInstruction(text: string): string | undefined {
  // 字数は人が数える単位（コードポイント）で数える——サロゲートペアを2字に数えない
  const length = [...text].length;
  if (length > PROJECT_INSTRUCTION_MAX_CHARS) {
    return `AI への指示は ${PROJECT_INSTRUCTION_MAX_CHARS.toLocaleString("en-US")} 字までです（${length.toLocaleString("en-US")} 字あります）`;
  }
  return undefined;
}
