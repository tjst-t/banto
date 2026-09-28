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
 *
 * **`host` は banto 自身が Module を起こすために呼ぶとき**（追加・2026-09-16、
 * `${secret:…}` の解決）。人でも AI でもないので、**`canvas` の緩め
 * （admin 可視の宛先は聞かない）は掛けない**——人が押していないものを
 * 「人が押した」に混ぜない。
 */
export type CallOrigin = "turn" | "canvas" | "host";

export class ModuleCallTracker {
  /** Module の接続名 → 走行中の呼び出し（連番 → Thread・Project・出所）。 */
  private readonly inFlight = new Map<
    string,
    Map<number, { threadId?: string; projectId?: string; origin: CallOrigin; forInstance?: boolean }>
  >();
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
  begin(
    connName: string,
    threadId: string | undefined,
    origin: CallOrigin = "turn",
    projectId?: string,
    /** **banto 全体のための呼び出し**（Project が決まらない、が決められないのでもない）。 */
    forInstance = false,
  ): () => void {
    const callId = this.nextCallId++;
    let calls = this.inFlight.get(connName);
    if (!calls) {
      calls = new Map();
      this.inFlight.set(connName, calls);
    }
    calls.set(callId, { threadId, projectId, origin, forInstance });
    return () => {
      const current = this.inFlight.get(connName);
      if (!current) return;
      current.delete(callId);
      if (current.size === 0) this.inFlight.delete(connName);
    };
  }

  /**
   * **いま走っている呼び出しの一覧**（追加・2026-09-28、ユーザー「再起動の頃合いを計りたい」）。
   * 開始時刻は持たない——ターンの中の呼び出しは、ターンの一覧のほうで時刻が分かる
   */
  list(): Array<{ connName: string; threadId?: string; projectId?: string; origin: CallOrigin }> {
    return [...this.inFlight].flatMap(([connName, calls]) =>
      [...calls.values()].map((c) => ({
        connName,
        ...(c.threadId ? { threadId: c.threadId } : {}),
        ...(c.projectId ? { projectId: c.projectId } : {}),
        origin: c.origin,
      })),
    );
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
    const origins = [...calls.values()].map((c) => c.origin);
    // **緩いほうへ倒さない**（規則2）。`canvas` だけが承認を飛ばしうるので、
    // 他が1つでも混ざっていたら `canvas` とは言わない
    if (origins.includes("turn")) return "turn";
    if (origins.includes("host")) return "host";
    return "canvas";
  }

  /**
   * **いま走っている呼び出しの Project**（追加・2026-09-13）。
   *
   * Vault のアクセス制限に要る——「この alias はどの Project から使えるか」を
   * 決めるのは host であって、Module の自己申告ではない。`threadFor` と同じ
   * 規律で、**決められないなら `undefined`**（呼び出し先が fail closed で止まる）。
   */
  projectFor(connName: string): string | undefined {
    const calls = this.inFlight.get(connName);
    if (!calls || calls.size === 0) return undefined;
    const ids = [...new Set([...calls.values()].map((c) => c.projectId).filter((p): p is string => !!p))];
    return ids.length === 1 ? ids[0] : undefined;
  }

  /**
   * **いま走っている呼び出しは、誰のためか**（追加・2026-09-16）。
   *
   * `projectFor` の上位版。Project が決まればそれ、**banto 全体のためだけ**が
   * 走っていれば `{instance:true}`、混ざっていたら **`undefined`（決められない）**
   * ——`{instance:true}` の呼び出しが、たまたま同時に走っている Project の
   * 刻印を借りて広がることを防ぐ。
   */
  callerFor(connName: string): { project: string } | { instance: true } | undefined {
    const calls = this.inFlight.get(connName);
    if (!calls || calls.size === 0) return undefined;
    const values = [...calls.values()];
    const ids = [...new Set(values.map((c) => c.projectId).filter((p): p is string => !!p))];
    const anyInstance = values.some((c) => c.forInstance);
    if (ids.length === 1 && !anyInstance) return { project: ids[0]! };
    if (ids.length === 0 && anyInstance) return { instance: true };
    return undefined;
  }

  /** **banto 全体のための呼び出しか**——宛先へ継ぐときに使う。 */
  instanceFor(connName: string): boolean {
    const caller = this.callerFor(connName);
    return caller !== undefined && "instance" in caller;
  }
}
