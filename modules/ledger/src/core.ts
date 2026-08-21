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

import { EventLog, fold, type BantoEvent, type DecisionSource } from '@banto/core';

export class LedgerCore {
  constructor(private readonly log: EventLog) {}

  /** 判断を1つ立てる（要件 A6）。**同じ id では二重に立てない。** */
  async requestDecision(input: {
    decisionId: string;
    source: DecisionSource;
    threadId: string | null;
    question: string;
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
    });
    return input.decisionId;
  }

  /** 判断に答える。**立っていないものには答えさせない**（規則2）。 */
  async resolveDecision(decisionId: string, answer: string): Promise<string> {
    if (!fold(await this.log.read()).pendingDecisions.has(decisionId)) {
      throw new Error(`立っていない判断には答えられない: ${decisionId}`);
    }
    await this.log.append({ type: 'decision.resolved', decisionId, answer });
    return decisionId;
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
