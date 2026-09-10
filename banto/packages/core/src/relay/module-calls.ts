// **いま、どのターンのために Module が動いているか**を持つ。
//
// なぜ要るか：Module 間中継の承認（docs/specs/v4-frontend.md「Module 間中継の承認
// （入れ子の承認）」）は、**外側の tool 呼び出しのハンドラが動いている内側**で
// 発生する。人に見せる場所は会話（と受信箱）なので、中継の呼び出し元がどの
// Thread の仕事をしているのかが要る。ところが Module→host の中継接続
// （host-relay-endpoint.ts）は Module プロセス単位で、Thread を知らない。
//
// **推測しない。** Runner が代理サーバへ繋ぐときに host 自身が渡した Thread
// （agent-relay-endpoint.ts の `x-banto-thread-id`）だけを使い、走っている
// 呼び出しが無い・複数のターンから同時に呼ばれていて決められない、のどちらも
// **「決められない」として返す**（規則2——黙って片方に寄せない）。

export type ModuleCallThread =
  | { kind: "thread"; threadId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; threadIds: string[] };

export class ModuleCallTracker {
  /** Module の接続名 → 走行中の呼び出し（連番 → Thread）。 */
  private readonly inFlight = new Map<string, Map<number, string>>();
  private nextCallId = 1;

  /** 1件の tool 呼び出しの開始。返ってきた関数を必ず finally で呼ぶ。 */
  begin(connName: string, threadId: string): () => void {
    const callId = this.nextCallId++;
    let calls = this.inFlight.get(connName);
    if (!calls) {
      calls = new Map();
      this.inFlight.set(connName, calls);
    }
    calls.set(callId, threadId);
    return () => {
      const current = this.inFlight.get(connName);
      if (!current) return;
      current.delete(callId);
      if (current.size === 0) this.inFlight.delete(connName);
    };
  }

  threadFor(connName: string): ModuleCallThread {
    const calls = this.inFlight.get(connName);
    if (!calls || calls.size === 0) return { kind: "none" };
    const threadIds = [...new Set(calls.values())];
    if (threadIds.length === 1) return { kind: "thread", threadId: threadIds[0]! };
    return { kind: "ambiguous", threadIds };
  }
}
