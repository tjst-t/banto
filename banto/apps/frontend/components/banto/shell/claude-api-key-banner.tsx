"use client";

// **使える Claude のアカウントが無い**ときの帯（追加・2026-10-24、`docs/specs/v4-distribution.md` §3「初めて起こしたとき API キーが
// 無ければ、画面がキーを入れるところへ導く」）。開いたときに1回だけ host に聞き、既定の並びに使えるアカウントが1つも無ければ、
// 設定「Claude のアカウント」の API キーのダイアログへ導く。読めない（口が無い・人のセッションでない）ときは出さない
import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { fetchClaudeAccounts } from "@/lib/backend/client";

export function ClaudeApiKeyBanner({ hidden }: { hidden?: boolean }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchClaudeAccounts()
      .then((s) => !cancelled && setMissing(s.noUsableAccount === true))
      .catch(() => {
        // 読めないときは出さない（会話の画面の邪魔をしない）
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!missing || hidden) return null;
  return (
    <div role="status" data-testid="claude-api-key-banner" className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-warn/40 bg-surface px-3 py-2 text-sm text-foreground shadow-md">
        <KeyRound className="size-4 shrink-0 text-warn" />
        <span>Claude を使うには API キーが要ります</span>
        <Link
          href="/settings?section=claude-accounts&addKey=1"
          data-testid="claude-api-key-banner-open"
          onClick={() => setMissing(false)}
          className="rounded-md bg-accent px-2 py-1 text-xs text-accent-foreground"
        >
          API キーを入れる
        </Link>
      </div>
    </div>
  );
}
