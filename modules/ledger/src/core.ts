/**
 * ledger の core。**イベントログの面**（要件 C13・決定17）。
 *
 * ## 出すのは型の決まった操作だけ
 *
 * 決定7 は「真実は1つのイベントログ」と定めている。ここに
 * **「何でも追記できる」道を開くと、その保証が壊れる**——モジュールが任意の
 * イベント種を積めるなら、ログの形はもう誰にも分からない。
 *
 * だから口は最小にする：**判断を立てる・判断に答える・読む**。この3つは
 * 要件から出ている（A6 の1本のキュー、A8 の読み返し）。
 * **足りないものが出たら、そのとき理由をつけて足す。**
 *
 * ## 書き込みは中核の機構を通る
 *
 * 判断の id は呼び手が決めるが、**二重に立てない**のはここが見ている。
 * base への追記をここに置いていないのは、**ゲート（決定4）を通る入口が
 * `appendBase` に1本化されている**ため——ここに素の追記を生やすと迂回路になる。
 */

import {
  EventLog,
  fold,
  type BantoEvent,
  type DecisionOption,
  type DecisionSource,
} from '@banto/core';

export class LedgerCore {
  constructor(private readonly log: EventLog) {}

  /**
   * 判断を1つ立てる（要件 A6）。**同じ id では二重に立てない。**
   *
   * 選択肢は任意。**出しても、そこで閉じない**——「どれも選べない」は必ず起きる。
   */
  async requestDecision(input: {
    decisionId: string;
    source: DecisionSource;
    threadId: string | null;
    question: string;
    options?: readonly DecisionOption[];
  }): Promise<string> {
    const events = await this.log.read();
    const known = events.some(
      (e) =>
        (e.type === 'decision.requested' || e.type === 'decision.resolved') &&
        e.decisionId === input.decisionId,
    );
    if (known) return `${input.decisionId} は既に立っているか、答えが出ている`;

    await this.log.append({
      type: 'decision.requested',
      decisionId: input.decisionId,
      source: input.source,
      threadId: input.threadId,
      question: input.question,
      ...(input.options === undefined ? {} : { options: input.options }),
    });
    return input.decisionId;
  }

  /**
   * 判断に答える。**立っていないものには答えさせない**（規則2）。
   *
   * ## 選ぶか、書くか
   *
   * `optionId` を渡せば選択肢を選んだことになり、**その id は実在しなければならない**
   * ——知らない id を「たぶんこれ」と読ませない。渡さなければ自由文で、
   * **選択肢が在っても自由文で答えられる**（どれも選べないことは起きる）。
   *
   * ## 答えは、そのスレッドの会話に返る
   *
   * v2 の取次は「押されたときに効く口」（`InboxEffect`）を持っていたが、
   * v3 は**汎用の効果を作らない**。代わりに答えを会話に置く——
   * エージェントは次のターンでそれを読むし、人も読み返せる（要件 A8）。
   * **新しい機構を1つも増やさずに、答えが効く。**
   */
  async resolveDecision(
    decisionId: string,
    answer: string,
    optionId?: string,
  ): Promise<{ decisionId: string; optionId: string | null; deliveredTo: string | null }> {
    const events = await this.log.read();
    const pending = fold(events).pendingDecisions.get(decisionId);
    if (!pending) throw new Error(`立っていない判断には答えられない: ${decisionId}`);

    const requested = events.find(
      (e): e is Extract<BantoEvent, { type: 'decision.requested' }> =>
        e.type === 'decision.requested' && e.decisionId === decisionId,
    );

    if (optionId !== undefined) {
      const known = (requested?.options ?? []).some((o) => o.id === optionId);
      if (!known) {
        const ids = (requested?.options ?? []).map((o) => o.id);
        throw new Error(
          `知らない選択肢: ${optionId}（在るのは ${ids.length === 0 ? 'なし' : ids.join(', ')}）` +
            `。どれも選べないなら optionId を渡さず、自由文で答える`,
        );
      }
    }

    await this.log.append({
      type: 'decision.resolved',
      decisionId,
      optionId: optionId ?? null,
      answer,
    });

    // **答えを会話に返す。** スレッドに紐づいていない判断（機構の警報など）は返す先が無い。
    const threadId = pending.threadId;
    if (threadId !== null) {
      await this.log.append({
        type: 'message.recorded',
        threadId,
        queryId: `decision:${decisionId}`,
        role: 'user',
        text: optionId === undefined ? answer : `${answer}（${optionId}）`,
      });
    }

    return { decisionId, optionId: optionId ?? null, deliveredTo: threadId };
  }

  /** いま立っている判断（要件 A5・A6）。古い順。 */
  async pending(): Promise<{ decisionId: string; question: string; since: string }[]> {
    const state = fold(await this.log.read());
    return [...state.pendingDecisions.values()]
      .sort((a, b) => a.since.localeCompare(b.since))
      .map((d) => ({ decisionId: d.decisionId, question: d.question, since: d.since }));
  }

  /**
   * イベントを読む（要件 A8）。**畳まずにそのまま返す。**
   * 画面用にも呼び手用にも別の形を作らない（規則3）。
   */
  async read(threadId?: string): Promise<BantoEvent[]> {
    const all = await this.log.read();
    if (threadId === undefined) return all;
    return all.filter((e) => 'threadId' in e && e.threadId === threadId);
  }
}
