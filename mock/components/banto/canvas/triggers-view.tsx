"use client";

// 「自動で動かす」の Canvas（決定・2026-10-15、ユーザー「Canvas にする」）。core の画面だが、設定ではなく Canvas に出す
// ——作ったあとも直近の回・今すぐ動かす・一時停止と日々触り、会話と並べて見たいため。
// Module の MCP App ではなく、画面のコードが直に描く（Canvas の枠に core の画面の枝を足す。iframe・CSP は通らない）
import { useParams } from "next/navigation";
import { TriggersPanel } from "@/components/banto/settings/triggers-panel";

export function TriggersView() {
  const params = useParams<{ projectId?: string }>();
  // 別タブの Canvas（/canvas-window）には Project が無い——そのときは banto の見本を出す
  const projectId = params.projectId ?? "banto";
  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4">
      <TriggersPanel projectId={projectId} />
    </div>
  );
}
