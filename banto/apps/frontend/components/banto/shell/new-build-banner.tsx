"use client";

// 「新しい版の画面があります」の帯（追加・2026-10-05、ユーザー報告）。banto を更新したあと、開いたままの
// タブ・ほかの端末は古い画面のプログラムで動き続ける——読み込み直せば新しくなることを知らせる。
// 自動では読み込み直さない（書きかけ・開いている画面を人の知らないうちに捨てない）。更新した本人の画面だけは
// 設定の「banto の更新」が自動で読み込み直す（update-panel.tsx）
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNewFrontendBuild } from "@/lib/backend/frontend-build";

export function NewBuildBanner() {
  const build = useNewFrontendBuild();
  if (build === null) return null;
  return (
    <div
      role="status"
      data-testid="new-build-banner"
      className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center px-3"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground shadow-md">
        <span>新しい版の画面があります</span>
        <Button size="sm" onClick={() => window.location.reload()}>
          <RefreshCw className="size-3.5" />
          読み込み直す
        </Button>
      </div>
    </div>
  );
}
