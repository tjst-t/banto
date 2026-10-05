// **起こし直しても続けられる**（追加・2026-10-05、アーキ仕様 §2.5「2. Module の仕事を続ける」）——host → Module の問い。
//
// 印は Module の申告（`dev.banto/module` の `resumesAfterRestart: true`、`meta.ts`）。名乗った Module は、この名前の
// tool を持つ（visibility は admin——AI には見せない）。host は起き直したとき、その Module に「あとで届ける」と約束した
// まま終わっていない仕事（返事待ちの札）を、この tool で1回だけ渡す。Module は1件ずつ「続ける」か「途中で終わりました
// （理由）」を答える。
//
// **約束**：
//   - **続けると答えたら、終わりは必ず札で届ける**（成功も失敗も。`relayDeliverToThread`、最後の届けとして）。host は
//     札を覚え直すが、**使えるのは最後の届け1回だけ**——途中経過は届けられない
//   - 答えに無い札・答えが来ない・答えが読めないものは、host が「途中で終わりました」にする（規則2——来ない返事を
//     AI に待たせない）
//   - 札（`replyTo`）は届けるための推測できない印。Module は答えるのに要る分だけ使い、**平文で置き場に書かない**
//     （照らすなら指紋で——`replyToFingerprint`）

import { createHash } from "node:crypto";

/** 問いの tool の名前（名乗った Module が持つ） */
export const RESUME_AFTER_RESTART_TOOL = "resumeAfterRestart";

/** 約束したまま終わっていない仕事1件（host が渡す） */
export interface ResumeQuestionItem {
  /** 返信用の札（host がその呼び出しに渡したもの。続けるなら、終わりをこれで届ける） */
  replyTo: string;
  /** 呼んだ tool の名前（Module の中の名前）。古い記録には無い */
  toolName?: string;
  /** Runner の tool_use の id（`claudecode/toolUseId`）。Runner が渡さなければ無い */
  toolCallId?: string;
  /** 頼んだ Thread（呼び出しに刻んだ `dev.banto/thread` と同じ形） */
  thread: { projectId?: string; threadId: string };
}

export interface ResumeQuestion {
  items: ResumeQuestionItem[];
}

export type ResumeAnswer = { replyTo: string; resume: true } | { replyTo: string; resume: false; reason: string };

export interface ResumeAnswers {
  answers: ResumeAnswer[];
}

/** 札の指紋（sha256 の頭 32 字）。Module が走っている仕事の記録に札を照らすために残すもの——札そのものは書かない */
export function replyToFingerprint(replyTo: string): string {
  return createHash("sha256").update(replyTo).digest("hex").slice(0, 32);
}

/** 問いを読む（Module 側）。形が違えば投げる——黙って空の問いにしない */
export function parseResumeQuestion(raw: unknown): ResumeQuestion {
  const items = (raw as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) throw new Error("問いの items が配列ではありません");
  return {
    items: items.map((it, i) => {
      const o = it as Record<string, unknown>;
      const thread = o.thread as Record<string, unknown> | undefined;
      if (typeof o.replyTo !== "string" || o.replyTo === "") throw new Error(`items[${i}].replyTo がありません`);
      if (typeof thread?.threadId !== "string") throw new Error(`items[${i}].thread.threadId がありません`);
      return {
        replyTo: o.replyTo,
        ...(typeof o.toolName === "string" ? { toolName: o.toolName } : {}),
        ...(typeof o.toolCallId === "string" ? { toolCallId: o.toolCallId } : {}),
        thread: { threadId: thread.threadId, ...(typeof thread.projectId === "string" ? { projectId: thread.projectId } : {}) },
      };
    }),
  };
}

/**
 * 答えを読む（host 側）。**問いに無い札の答えは捨てる**（Module が知らない札を「続ける」と言っても覚え直さない）。
 * 1件の形が違えばその札は「答えが読めない」——ほかの札の答えは生かす
 */
export function parseResumeAnswers(raw: unknown, asked: readonly string[]): Map<string, ResumeAnswer> {
  const out = new Map<string, ResumeAnswer>();
  const answers = (raw as { answers?: unknown } | undefined)?.answers;
  if (!Array.isArray(answers)) return out;
  const known = new Set(asked);
  for (const a of answers) {
    const o = a as Record<string, unknown>;
    if (typeof o.replyTo !== "string" || !known.has(o.replyTo) || out.has(o.replyTo)) continue;
    if (o.resume === true) out.set(o.replyTo, { replyTo: o.replyTo, resume: true });
    else if (o.resume === false) {
      out.set(o.replyTo, {
        replyTo: o.replyTo,
        resume: false,
        reason: typeof o.reason === "string" && o.reason.trim() !== "" ? o.reason.trim() : "理由は書かれていません",
      });
    }
  }
  return out;
}
