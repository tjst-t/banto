// **走行中のターンに、あとから繋ぎ直して見せる**（`turn-stream-reattach`、
// 決定・2026-09-10）。
//
// 実測（2026-09-10）：走行中にリロードすると、**出力どころか「走っている」ことすら
// 画面から消える**——ターンのイベント列は `POST …/messages` の応答の中にしか無く、
// 接続が切れたら戻る先が無かった。人からは「送ったのに何も起きていない」に見える。
//
// host が走行中のぶんを覚えるようにしたので（`GET …/stream`）、開き直したときに
// **最初から流し直して、続きもそのまま**受け取れる。
//
// **記録の真実は host のまま**（規則3）——ここが持つのは「まだ記録に落ちていない
// 途中経過」だけ。ターンが終わったら捨てて、host の記録を取り直す。

import { attachRealTurn } from "./client";
import { hasLiveRealRun, syncRestoredThread } from "./adapter";

interface Reattached {
  /** これまでに届いた AI の発言（そのターンの分だけ）。 */
  text: string;
  /** 動いている tool の名前（いま何をしているかを一言で出す）。 */
  activity?: string;
  startedAt?: string;
}

const byThread = new Map<string, Reattached>();
const attaching = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeReattached(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reattachedVersion(): number {
  return version;
}

export function getReattachedTurn(threadId: string): Reattached | undefined {
  return byThread.get(threadId);
}

/**
 * その Thread に走行中のターンがあれば繋ぐ。**このブラウザが走らせている
 * ターンには繋がない**——そちらは元の SSE がそのまま流れている（規則3）。
 */
export function attachIfRunning(threadId: string): void {
  if (attaching.has(threadId) || hasLiveRealRun(threadId)) return;
  attaching.add(threadId);
  void (async () => {
    try {
      for await (const event of attachRealTurn(threadId)) {
        if (event.type === "idle") return; // 走っていない——何も見せない
        // **このブラウザが自分でターンを始めたら、帯は引っ込む**（実測・2026-09-10）。
        // 繋ぎ直しは「他所で始まったターンを見る」ためのもので、自分の走行には
        // 元の SSE がある（規則3——同じものを2つの経路で描かない）
        if (hasLiveRealRun(threadId)) return;
        if (event.type === "attached") {
          byThread.set(threadId, { text: "", startedAt: event.startedAt });
          changed();
          continue;
        }
        const current = byThread.get(threadId) ?? { text: "" };
        if (event.type === "message") {
          const message = event.message as {
            type?: string;
            message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
          };
          if (message.type === "assistant") {
            for (const block of message.message?.content ?? []) {
              if (block.type === "text" && typeof block.text === "string") current.text += block.text;
              if (block.type === "tool_use" && block.name) current.activity = block.name;
            }
          }
          byThread.set(threadId, current);
          changed();
        } else if (event.type === "done" || event.type === "error") {
          // 終わった——**ここから先の真実は host の記録**。取り直して、途中経過は捨てる
          // **ただし、その間に人が次のターンを始めていたら取り直さない**
          // （実測・2026-09-10：取り直すと会話が組み直され、走行中の画面
          //  （Module の Canvas）が作り直されて中身が入れ替わる）
          byThread.delete(threadId);
          changed();
          if (!hasLiveRealRun(threadId)) void syncRestoredThread(threadId);
          return;
        }
      }
    } catch {
      // 繋げなかった＝走行中の様子は見えない。**記録は host に残る**ので、
      // ここで人を止めない（判断待ちは受信箱から辿れる）
    } finally {
      attaching.delete(threadId);
      if (byThread.delete(threadId)) changed();
    }
  })();
}
