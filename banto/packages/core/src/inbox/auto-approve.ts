// **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。docs/specs/v4-frontend.md §6.4「承認をすべて自動で許可する」）。
//
// Project の設定のスイッチがオンなら、人に「許可するか」を聞くもの（tool 呼び出しの確認・Module 間中継の承認・Project を
// またぐメッセージの確認）を人に聞かずに許可する。**新しい記録の形は作らない**——判断待ちは今までどおり出し、出したそばから
// host が答えて決着させる（受信箱に未解決を残さない）。会話のカードは答え済みで出て、何を自動で通したかが後から読める。
//
// 判断はいつも**その時点の設定を引く**——保存した時点で、走っているターンにも次の承認から効く

import type { RuntimeConfigStore } from "../config/runtime.js";
import type { InboxStore } from "./store.js";
import type { JudgmentItem } from "./types.js";

/**
 * Configuration の鍵（真偽値）。**Project にだけ置ける**——instance 既定は読まない（全 Project で一度に人を外す口は作らない）
 */
export const AUTO_APPROVE_ALL_KEY = "approvals.autoApproveAll";

/** host が自分で答えた印。`judgmentAnswerText` がこれを見て、カードの「回答：…」の言葉にする */
export const AUTO_APPROVED_ANSWER = { behavior: "allow", autoApproved: true } as const;
/** カードの「回答：…」に出る言葉 */
export const AUTO_APPROVED_ANSWER_TEXT = "自動で許可しました（承認をすべて自動で許可する がオン）";
/** 中継の記録（`relay.call_recorded`）に残す理由 */
export const AUTO_APPROVED_REASON = "自動で許可（承認をすべて自動で許可する がオン）";

/** その Project でスイッチがオンか。**Project の層だけ**を読む（instance に誰かが書いても効かせない） */
export function isAutoApproveAll(config: Pick<RuntimeConfigStore, "layerValue"> | undefined, projectId: string): boolean {
  return config?.layerValue(AUTO_APPROVE_ALL_KEY, projectId) === true;
}

/**
 * **自動化を作るのを聞かずに許可する**（追加・2026-10-23、Backlog #536。アーキ仕様 §4.3「人と AI の作り方」）。AI の
 * `create_automation` は承認モードにも上の「承認をすべて自動で許可する」にも依らず必ず人に聞くが、**このスイッチがオンの Project
 * だけ**は聞かずに作る（管理する側の Project が、管理される Project の見回りを自分で立てるため。メタ Project の下書き、Backlog project-2）。上のスイッチには
 * 混ぜない——片方をオンにしてももう片方は効かない。変える・再開するは今までどおり聞く。**Project にだけ置ける**、値が無ければオフ
 */
export const AUTO_APPROVE_CREATE_AUTOMATION_KEY = "approvals.autoApproveCreateAutomation";

/** host が「自動化を作るのを聞かずに許可する」で答えた印。どちらのスイッチで通したかをカードで読み分ける */
export const AUTO_APPROVED_CREATE_AUTOMATION_ANSWER = { behavior: "allow", autoApproved: true, by: "createAutomation" } as const;
/** そのときにカードの「回答：…」に出る言葉 */
export const AUTO_APPROVED_CREATE_AUTOMATION_ANSWER_TEXT = "自動で許可しました（自動化を作るのを聞かずに許可する がオン）";

/** その Project で「自動化を作るのを聞かずに許可する」がオンか。**Project の層だけ**を読む */
export function isAutoApproveCreateAutomation(
  config: Pick<RuntimeConfigStore, "layerValue"> | undefined,
  projectId: string,
): boolean {
  return config?.layerValue(AUTO_APPROVE_CREATE_AUTOMATION_KEY, projectId) === true;
}

/** 判断待ちを出し、そのまま自動で許可して決着させる。出した判断待ち（もう答え済み）を返す */
export async function raiseAutoApprovedJudgment(
  inbox: InboxStore,
  input: Parameters<InboxStore["raiseJudgment"]>[0],
  answer: typeof AUTO_APPROVED_ANSWER | typeof AUTO_APPROVED_CREATE_AUTOMATION_ANSWER = AUTO_APPROVED_ANSWER,
): Promise<JudgmentItem> {
  const judgment = await inbox.raiseJudgment(input);
  await inbox.answerJudgment(judgment.id, answer);
  return judgment;
}
