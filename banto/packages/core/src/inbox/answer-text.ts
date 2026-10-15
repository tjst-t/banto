// 判断待ちの答えを、画面に出す一言にする（「許可する」・断った理由）。会話のカードの「回答：…」に出る。
//
// ターンの流れの `answered`（`http/app.ts`）と、ターンをまたぐ知らせの `judgment.answered`（`cli.ts`、追加・2026-10-05）の
// 両方がこれを使う——同じ答えが、届く道によって違う言葉にならないように（規則3）

import { MESSAGE_ALLOW_REMEMBER } from "../delivery/thread-messages.js";
import { AUTO_APPROVED_ANSWER_TEXT } from "./auto-approve.js";

/**
 * `choices` は判断待ちの選択肢。**先頭が許可の言葉**（「許可する」・自動化の確認の「作る」「変える」「再開する」、追加・
 * 2026-10-15）——許したときはそれを出す（「作る」を押したカードが「回答：許可する」にならないように）
 */
export function judgmentAnswerText(answer: unknown, choices?: readonly string[]): string {
  const a = (answer ?? {}) as { behavior?: unknown; remember?: unknown; message?: unknown; autoApproved?: unknown };
  // host が「承認をすべて自動で許可する」で答えたもの（追加・2026-10-05）——人が許可したのとは分けて読めるように
  if (a.behavior === "allow" && a.autoApproved === true) return AUTO_APPROVED_ANSWER_TEXT;
  if (a.behavior === "allow") return a.remember === true ? MESSAGE_ALLOW_REMEMBER : (choices?.[0] ?? "許可する");
  return typeof a.message === "string" && a.message !== "" ? a.message : "拒否する";
}
