"use client";

// 受信箱の「まとめて確認」（`inbox-page.tsx` の見出しの右）。
import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { getRealJudgments, getRealNotices, getRealReviews, refreshRealInbox, useRealInboxVersion } from "@/lib/backend/real-inbox";
import { acknowledgeRealNotice } from "@/lib/backend/client";

/**
 * **まとめて確認**（追加・2026-10-02、ユーザー要望。位置は同日に見出しの右へ改める）——お知らせとレビュー待ちを
 * 一度に「見た」にする。受信箱の見出しの右（閉じるボタンの左）に置く——通知の一覧によくある形
 * （見出しの右端に一括の操作、片づけるものが無いときは出さない）。全面の受信箱（§6.41、2026-10-15）でも同じ場所に残す。
 * **判断待ちは対象にしない**（答えないと AI が進まない）。
 */
export function RealInboxAcknowledgeAll() {
  useRealInboxVersion();
  const [busy, setBusy] = useState(false);
  const targets = [...getRealNotices().map((n) => n.id), ...getRealReviews().map((r) => r.id)];
  if (targets.length === 0) return null;
  const waiting = getRealJudgments().length;
  return (
    <button
      type="button"
      data-testid="inbox-acknowledge-all"
      disabled={busy}
      title={
        waiting > 0
          ? `お知らせと終わったターン（${targets.length} 件）を確認済みにします。判断待ち ${waiting} 件は残ります`
          : `お知らせと終わったターン（${targets.length} 件）を確認済みにします`
      }
      onClick={() => {
        setBusy(true);
        // 1件ずつの失敗で止めない——残ったものは取り直したときにまた出る
        void Promise.allSettled(targets.map((id) => acknowledgeRealNotice(id)))
          .then(() => refreshRealInbox())
          .finally(() => setBusy(false));
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-accent hover:text-foreground disabled:opacity-60"
    >
      <CheckCheck className="size-3.5" />
      {busy ? "確認しています…" : "まとめて確認"}
    </button>
  );
}
