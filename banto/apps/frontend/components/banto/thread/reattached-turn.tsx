"use client";

// **開き直しても、走っているものは見える**（`turn-stream-reattach`、2026-09-10）。
//
// 走行中にリロードすると、これまでは出力どころか「走っている」ことすら消えていた
// ——人からは「送ったのに何も起きていない」に見える。host に繋ぎ直して、
// そのターンがここまでに出したものを出す。終われば消え、**記録から組み直した
// 会話**に置き換わる（真実は host、規則3——この帯は途中経過だけを持つ）。

import { useEffect, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import {
  attachIfRunning,
  getReattachedTurn,
  reattachedVersion,
  subscribeReattached,
} from "@/lib/backend/reattached-turn";

export function ReattachedTurn({ threadId }: { threadId: string }) {
  useSyncExternalStore(subscribeReattached, reattachedVersion, () => 0);

  useEffect(() => {
    attachIfRunning(threadId);
  }, [threadId]);

  const running = getReattachedTurn(threadId);
  if (!running) return null;

  return (
    <div
      data-testid="reattached-turn"
      className="border-turn/30 bg-turn-soft/40 my-1.5 flex flex-col gap-1 rounded-lg border p-3"
    >
      <p className="text-turn flex items-center gap-1.5 text-xs font-semibold">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
        このターンは走っています（別の画面で始まったものに繋ぎ直しました）
      </p>
      {running.activity ? (
        <p className="text-ink-3 text-xs">いま動いているもの：{running.activity}</p>
      ) : null}
      {running.text ? (
        <p className="text-foreground text-sm whitespace-pre-wrap">{running.text}</p>
      ) : (
        <p className="text-ink-3 text-xs">まだ出力はありません</p>
      )}
    </div>
  );
}
