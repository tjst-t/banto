// **会話の取り直しは差分で**（決定・2026-10-22、ユーザー。v4-frontend.md §6.8「取り直しは差分で」）。
//
// `GET /api/threads/:id` は会話の記録を全部返す。画面はそれを、会話を開く・ターンの始まりと終わり・つなぎ直し・戻って
// きたときに取り直すので、長い会話ほど重い。ここは「足された分だけ」を返すための指紋と切り出しを1か所に置く。
//
// - 指紋は**返す形**（判断待ちのカードの中身を添えた `messages`）から、その都度計る。前の発言が変わったか（取り下げ・
//   表示の印の後付け・判断待ちの答え）を尋ねる印を read model に持たない（規則3）——変わっていれば指紋がずれて全部を返す
// - 最後の1件は指紋に入れない。走っているターンの AI の発言は、その1件に書き足されていく

import { createHash } from "node:crypto";

/** 指紋。`seq` までの発言（`seq` を含む）の SHA-256 */
export interface MessagesCursor {
  seq: number;
  hash: string;
}

/** 画面が渡す「前に受け取ったもの」。無ければ全部を返す */
export interface ThreadDeltaRequest {
  after?: number;
  hash?: string;
  usageSeq?: number;
}

type Seqd = { seq: number };

/** `seq` が `upTo` 以下の発言の指紋（並びは seq の昇順） */
export function messagesHash(messages: readonly Seqd[], upTo: number): string {
  const h = createHash("sha256");
  for (const m of messages) {
    if (m.seq > upTo) break;
    h.update(JSON.stringify(m));
    h.update("\n");
  }
  return h.digest("base64url");
}

/** 応答に付ける指紋——最後から2つ目まで。発言が2件未満なら無い */
export function messagesCursorOf(messages: readonly Seqd[]): MessagesCursor | undefined {
  if (messages.length < 2) return undefined;
  const seq = messages[messages.length - 2]!.seq;
  return { seq, hash: messagesHash(messages, seq) };
}

/** クエリから読む。形が合わないものは無いものとして扱う（全部を返す——取りこぼさない側へ倒す） */
export function parseThreadDeltaRequest(params: URLSearchParams): ThreadDeltaRequest {
  const num = (name: string) => {
    const raw = params.get(name);
    if (raw === null || !/^\d+$/.test(raw)) return undefined;
    return Number(raw);
  };
  const hash = params.get("hash");
  return {
    ...(num("after") !== undefined ? { after: num("after") } : {}),
    ...(hash ? { hash } : {}),
    ...(num("usageSeq") !== undefined ? { usageSeq: num("usageSeq") } : {}),
  };
}

/**
 * 全部の形（`toThreadDetail` の結果）に指紋を付け、頼まれていて前の発言が変わっていなければ差分に切り出す。
 * 差分のときは `messages` が `messagesAfter` より後ろだけになり、usage が同じ番号なら `usage: []` と `usageUnchanged: true`
 */
export function withThreadDelta<T extends { messages: Seqd[]; usage: Seqd[] }>(
  detail: T,
  request: ThreadDeltaRequest,
): T & { messagesCursor?: MessagesCursor; messagesAfter?: number; usageUnchanged?: true } {
  const cursor = messagesCursorOf(detail.messages);
  const base = { ...detail, ...(cursor ? { messagesCursor: cursor } : {}) };
  const { after, hash } = request;
  if (after === undefined || hash === undefined) return base;
  // 画面が持っている最後の発言（`after`）が、いまの記録にもその番号で残っていること。取り下げられていれば全部
  if (!detail.messages.some((m) => m.seq === after)) return base;
  if (messagesHash(detail.messages, after) !== hash) return base;
  const latestUsage = detail.usage[detail.usage.length - 1];
  const usageUnchanged = request.usageSeq !== undefined && latestUsage !== undefined && latestUsage.seq === request.usageSeq;
  return {
    ...base,
    messages: detail.messages.filter((m) => m.seq > after),
    messagesAfter: after,
    ...(usageUnchanged ? { usage: [], usageUnchanged: true as const } : {}),
  };
}
