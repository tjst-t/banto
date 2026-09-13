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

/**
 * その呼び出しが**誰の意思で始まったか**（追加・2026-09-12）。
 *
 * `turn` は AI のターンの中から。`canvas` は**人が画面で押したところ**から
 * （`/api/.../ui-tool-call`）。承認の要否がここで分かれる——判断の材料は
 * 台帳が持っていて、推測しない（規則3）。
 */
export type CallOrigin = "turn" | "canvas";

export class ModuleCallTracker {
  /** Module の接続名 → 走行中の呼び出し（連番 → Thread と出所）。 */
  private readonly inFlight = new Map<string, Map<number, { threadId?: string; origin: CallOrigin }>>();
  private nextCallId = 1;

  /**
   * 1件の tool 呼び出しの開始。返ってきた関数を必ず finally で呼ぶ。
   *
   * **会話が決まらない呼び出しもある**（追加・2026-09-12）——banto 全体の
   * 設定画面（instance）から Module を呼ぶときは、載せるべき Thread が無い。
   * その場合も**出所だけは記録する**：`threadId` に `undefined` を渡すと、
   * 「人の画面から来た」ことは分かるが「どの会話か」は分からない、という
   * 正直な状態になる（承認が要る中継はそこで fail closed のまま止まる）。
   */
  begin(connName: string, threadId: string | undefined, origin: CallOrigin = "turn"): () => void {
    const callId = this.nextCallId++;
    let calls = this.inFlight.get(connName);
    if (!calls) {
      calls = new Map();
      this.inFlight.set(connName, calls);
    }
    calls.set(callId, { threadId, origin });
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
    // 会話が決まらない呼び出し（instance の画面）は、宛先の候補に入れない
    const threadIds = [...new Set([...calls.values()].map((c) => c.threadId).filter((t): t is string => !!t))];
    if (threadIds.length === 0) return { kind: "none" };
    if (threadIds.length === 1) return { kind: "thread", threadId: threadIds[0]! };
    return { kind: "ambiguous", threadIds };
  }

  /**
   * いま走っている呼び出しの出所。**1つでもターン由来が混ざっていたら `turn`**
   * ——緩いほうへ倒さない（規則2）。走っていなければ `undefined`。
   */
  originFor(connName: string): CallOrigin | undefined {
    const calls = this.inFlight.get(connName);
    if (!calls || calls.size === 0) return undefined;
    return [...calls.values()].some((c) => c.origin === "turn") ? "turn" : "canvas";
  }
}
