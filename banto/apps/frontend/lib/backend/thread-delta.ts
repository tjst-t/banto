// **会話の取り直しは差分で**（決定・2026-10-22、ユーザー。v4-frontend.md §6.8「取り直しは差分で」）。
//
// host は `GET /api/threads/:id` の応答に指紋（`messagesCursor`）を付け、次の取り直しでそれを渡すと、前の発言が変わって
// いなければ後ろの発言だけ（`messagesAfter`）を返す。ここは、届いた差分を手元の全部に重ねて**今までと同じ形の記録**に
// 戻す——使う側（組み直し・写し・文脈のメーター）は差分を知らない。覚えるのはメモリだけで、リロードしたら最初は全部を取る。

/** host が付ける指紋。`seq` までの発言の SHA-256 */
export interface MessagesCursor {
  seq: number;
  hash: string;
}

/** 差分の欄（全部の形には残さない） */
export interface ThreadDeltaFields {
  messagesCursor?: MessagesCursor;
  messagesAfter?: number;
  usageUnchanged?: true;
}

type Record_ = { messages: Array<{ seq: number }>; usage: Array<{ seq: number }> };

/** 次の取り直しで渡すクエリ（`?after&hash&usageSeq`）。前に受け取ったものが無い・指紋が無ければ空（全部を取る） */
export function threadDeltaQuery(known: (Record_ & { messagesCursor?: MessagesCursor }) | undefined): string {
  const cursor = known?.messagesCursor;
  if (!cursor) return "";
  const params = new URLSearchParams({ after: String(cursor.seq), hash: cursor.hash });
  const latestUsage = known.usage[known.usage.length - 1];
  if (latestUsage) params.set("usageSeq", String(latestUsage.seq));
  return `?${params.toString()}`;
}

/**
 * 届いたものを全部の形に戻す。差分（`messagesAfter`）なら、手元の `messagesAfter` 以下の発言に届いた発言を続け、usage が
 * 変わっていなければ手元のものを使う。差分なのに手元に前のものが無い（起こりえないが）なら、そのまま返さずに投げる
 * ——欠けた記録を出さない（規則2）。返す形には指紋だけを残す（次の取り直しで使う）
 */
export function mergeThreadDelta<T extends Record_ & ThreadDeltaFields>(known: T | undefined, received: T): T {
  const { messagesAfter, usageUnchanged, ...rest } = received;
  if (messagesAfter === undefined) return rest as T;
  if (!known) throw new Error("差分が届きましたが、手元に前の記録がありません");
  return {
    ...rest,
    messages: [...known.messages.filter((m) => m.seq <= messagesAfter), ...received.messages],
    usage: usageUnchanged ? known.usage : received.usage,
  } as T;
}
