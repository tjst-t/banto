/**
 * base のゲート（要件 R8、ADR-0001 決定4）。
 *
 * **警報ではなくゲートである。** R6 で追記の判断は AI に乗っているが、誤りの向きが
 * 非対称になっている——過小（追記しない）はその枝が老いるだけで済むのに対し、
 * 過大（追記しすぎ）は base が肥え、**A4「分岐が安い」が全ブランチに対して静かに壊れる。**
 * 静かに壊れるものを警報で守ると「見えているのに誰も見なかった」に落ちる。
 *
 * **閾値を超えたときにするのは、追記の拒否だけ。** 自動で新しい会話へ切り替えない。
 * 切り替えは回復できない操作を黙って行うことで、規則2 の「黙って別の経路へ落ちない」に
 * 正面から反する。**拒否は「止まる」、切り替えは「別経路へ落ちる」。** R5 を選ぶのは人で、
 * 機構は選択肢を決定9 のキューに出すところまでをやる。
 *
 * **追記の経路をここに1本化する。** `log.append({ type: 'base.appended' })` を
 * 直接呼ばず `appendBase` を通す——ゲートは、迂回できる場所に置くと迂回される。
 */

import type { NewEvent, ThreadId } from './event.js';
import type { State } from './fold.js';
import { effectiveBase } from './fold.js';
import type { EventLog } from './log.js';

/**
 * 閾値（文字数）。
 *
 * **これは計測値ではなく出発点である**（規則1：測る前に決めない）。導出はこう：
 * 文脈の上限を 200,000 トークン（observer の既定）とし、base はその 5% までに
 * 収まっていてほしいので 10,000 トークン。日本語と英語が混じる文の
 * 1トークンあたり 2 文字を控えめな目安として 20,000 文字。
 *
 * **実際の base が溜まったら測り直す。** そのときまで、この数字を根拠として引用しない。
 */
export const DEFAULT_BASE_LIMIT_CHARACTERS = 20_000;

/**
 * 大きさを**文字数**で測る。
 *
 * 効いてほしいのはトークン数だが、トークナイザを足すと依存が1つ増える（規則10）。
 * base は自然言語なので文字数はトークン数の単調な代理になる。**代理であることを
 * 隠さない**ために、返り値も型も `characters` と名乗る——`tokens` と名乗らせない。
 */
export function baseCharacters(state: State, threadId: ThreadId): number {
  // fork の継承分も費用を持つので、自分の追記分だけでなく実効の base を測る（要件 R4）。
  return effectiveBase(state, threadId).reduce((sum, line) => sum + line.length, 0);
}

export interface BaseAccepted {
  readonly ok: true;
  /** 追記後の版。 */
  readonly baseVersion: number;
  readonly characters: number;
  readonly limit: number;
}

export interface BaseRefused {
  readonly ok: false;
  /** 値で返す理由（教訓13）。黙って落とさない。 */
  readonly reason: string;
  /** 追記前の大きさ。 */
  readonly characters: number;
  /** 追記していたらこうなっていた大きさ。 */
  readonly wouldBe: number;
  readonly limit: number;
}

export type BaseGate = BaseAccepted | BaseRefused;

/** 判断待ちの id。スレッドごとに1つだけ立つ（二重に立てない）。 */
export function baseLimitDecisionId(threadId: ThreadId): string {
  return `base-limit:${threadId}`;
}

/**
 * 追記してよいかを判定する。**書き込まない。**
 *
 * 判定するのは「追記**後**が閾値を超えるか」であって、追記前ではない。
 * 追記前で見ると、1回の巨大な追記が素通りする。
 */
export function checkBaseAppend(
  state: State,
  threadId: ThreadId,
  text: string,
  limit: number = DEFAULT_BASE_LIMIT_CHARACTERS,
): BaseGate {
  const thread = state.threads.get(threadId);
  if (!thread) throw new Error(`知らないスレッドへの追記: ${threadId}`);

  const characters = baseCharacters(state, threadId);
  const wouldBe = characters + text.length;

  if (wouldBe > limit) {
    return {
      ok: false,
      reason:
        `base が閾値を超える（${wouldBe} > ${limit} 文字）ので追記しない。` +
        `base が肥えると、この会話から切るすべてのブランチが高くなる（要件 A4）。` +
        `続けるなら R5——書き換えて新しい会話を始める（そのときブランチは継承しない）。`,
      characters,
      wouldBe,
      limit,
    };
  }

  return { ok: true, baseVersion: thread.baseVersion + 1, characters: wouldBe, limit };
}

/**
 * ゲートを通してから追記する。**base を伸ばす唯一の入口。**
 *
 * 拒否したときは、選択肢としての R5 を決定9 のキューに出す（要件 A6）。
 * **id はスレッドごとに決まるので、何度拒否されても判断は1つしか立たない。**
 *
 * この判断は自動では解決しない——base は追記のみで縮まないので（要件 R2）、
 * 条件が自然に消えることがない。人が R5 を選ぶか、無視するかのどちらかである。
 */
export async function appendBase(
  log: EventLog,
  state: State,
  threadId: ThreadId,
  text: string,
  limit: number = DEFAULT_BASE_LIMIT_CHARACTERS,
): Promise<BaseGate> {
  const gate = checkBaseAppend(state, threadId, text, limit);

  if (!gate.ok) {
    const decisionId = baseLimitDecisionId(threadId);
    if (!state.pendingDecisions.has(decisionId)) {
      const decision: NewEvent = {
        type: 'decision.requested',
        decisionId,
        source: 'observer',
        threadId,
        question: gate.reason,
      };
      await log.append(decision);
    }
    return gate;
  }

  await log.append({ type: 'base.appended', threadId, baseVersion: gate.baseVersion, text });
  return gate;
}
