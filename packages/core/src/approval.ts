/**
 * 承認の台帳（ADR-0001 決定16 の安全上の②、要件 A6）。
 *
 * **リポジトリが持ち込んだ実行可能なものを、人が承認するまで走らせない。**
 * 最初の用途は環境スクリプト——エージェントはそのリポジトリで作業するので、
 * `script/env-create` を書き換えれば**自分を閉じ込めている箱の作り手を書き換えられる。**
 *
 * **新しい機構を作らない。** 承認は決定9 のキューに立つ `decision.requested` と、
 * それに答える `decision.resolved` そのものである。台帳は**イベントを畳んで作る**
 * ので、保存された「承認済み一覧」は存在しない（規則3）。
 *
 * **承認の単位は内容そのもの**（指紋）であって、ファイル名ではない。名前で承認すると、
 * 一度通ったファイルが以後どう書き換わっても通ってしまう。
 */

import { createHash } from 'node:crypto';

import type { BantoEvent, NewEvent } from './event.js';
import type { EventLog } from './log.js';

/**
 * 承認の答え。**この文字列と完全一致したものだけを承認とみなす。**
 *
 * 「はい」「ok」なども通すような曖昧な判定をしない——判定を緩めた分だけ、
 * 承認していないものが通る道ができる。
 */
export const APPROVE = 'approve';

/** 内容の指紋。**内容が1バイト変われば別物になる。** */
export function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 承認を求める判断の id。**主題と指紋の両方から決まる。**
 *
 * 決まっているので、同じ内容について何度聞かれても判断は1つしか立たない。
 * 内容が変われば id も変わる——つまり**書き換えたら承認はやり直しになる。**
 */
export function approvalId(subject: string, print: string): string {
  return `approval:${subject}:${print}`;
}

/**
 * いま承認されているものの一覧。**畳んで作る**（規則3）。
 *
 * 却下（`answer` が `APPROVE` でない解決）は「承認していない」として扱う
 * ——解決済みだから通す、ではない。
 */
export function foldApprovals(events: readonly BantoEvent[]): ReadonlySet<string> {
  const approved = new Set<string>();
  for (const event of events) {
    if (event.type !== 'decision.resolved') continue;
    if (!event.decisionId.startsWith('approval:')) continue;
    if (event.answer === APPROVE) approved.add(event.decisionId);
    else approved.delete(event.decisionId);
  }
  return approved;
}

/** 承認されているかを聞く口。モジュールにはこれだけを渡す。 */
export interface ApprovalLedger {
  isApproved(subject: string, print: string): boolean;
}

/**
 * 何も承認されていない台帳。**既定はこれ。**
 *
 * 「台帳を渡し忘れたら全部通る」形にしない——安全に関わる既定は、
 * 忘れられたときに**厳しい側**へ倒れていなければならない（要件 C8c と同じ考え）。
 */
export const NOTHING_APPROVED: ApprovalLedger = { isApproved: () => false };

export function ledgerOf(approved: ReadonlySet<string>): ApprovalLedger {
  return { isApproved: (subject, print) => approved.has(approvalId(subject, print)) };
}

/**
 * 承認を求める判断を立てる。**同じ内容について二重に立てない。**
 *
 * 立てるだけで、待たない。走らせようとした側は**その場で断られる**
 * ——承認を待って止まるのではなく、断って人に上げる（要件 A7 の段1）。
 */
export async function requestApproval(
  log: EventLog,
  events: readonly BantoEvent[],
  subject: string,
  print: string,
  question: string,
): Promise<string> {
  const decisionId = approvalId(subject, print);

  // 立っているか、すでに答えが出ているかのどちらかなら、重ねない。
  const known = events.some(
    (e) =>
      (e.type === 'decision.requested' || e.type === 'decision.resolved') &&
      e.decisionId === decisionId,
  );
  if (!known) {
    const decision: NewEvent = {
      type: 'decision.requested',
      decisionId,
      // 出所は機構。会話でも Factory でもなく、承認の仕組みが立てている。
      source: 'observer',
      threadId: null,
      question,
    };
    await log.append(decision);
  }
  return decisionId;
}
