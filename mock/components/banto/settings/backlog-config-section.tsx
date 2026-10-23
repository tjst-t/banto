"use client";

// Backlog Module 自身の設定(ui://banto.backlog/config、v4-modules.md §4.4)。
// 「窓口1本・バックエンドは複数」のどちらを使うかを、この Project 単位で選ぶ
// ——メタ Project 専用の設定ではない、通常の Module 設定の範囲
// (決定・2026-10-23、レビュー指摘)。
import { GitBranch } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { getBacklogBackend, setBacklogBackend } from "@/lib/mock/backlog";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockBacklogBackendKind } from "@/lib/mock/types";

const BACKLOG_BACKEND_LABEL: Record<MockBacklogBackendKind, string> = {
  "tasks-json": "tasks.json（リポジトリの専用ブランチ）",
  gist: "GitHub Gist（非公開）",
};

export function BacklogConfigSection({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const backend = getBacklogBackend(projectId);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label
          htmlFor="backlog-backend"
          className="flex items-center gap-1.5 text-sm font-medium text-foreground"
        >
          <GitBranch className="size-3.5 text-ink-3" />
          バックエンド
        </Label>
        <p className="mt-0.5 text-xs text-ink-3">
          どちらも dependsOn・parent を含む今の Backlog のモデルをそのまま持ち込む。
          複数 Project をまたぐ計画を持つ場所には Gist を選べる。
        </p>
      </div>
      <Select
        value={backend}
        onValueChange={(v) => setBacklogBackend(projectId, v as MockBacklogBackendKind)}
      >
        <SelectTrigger id="backlog-backend" className="h-8 w-56 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tasks-json">{BACKLOG_BACKEND_LABEL["tasks-json"]}</SelectItem>
          <SelectItem value="gist">{BACKLOG_BACKEND_LABEL.gist}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
