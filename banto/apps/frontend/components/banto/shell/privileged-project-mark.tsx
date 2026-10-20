"use client";

// **サイドバーの Project の行の「特権コンテナ」の印**（追加・2026-10-20、`docs/specs/v4-security.md` §1「`containers` で仮想化の
// 実験」の 4.、Backlog 462 番）。この Project の AI はサーバの root になれる——開かなくても分かるように、名前の右に出す（混んでいる印・
// 移している印と並ぶ）。写しの元は host の Project の一覧の `privileged`（`syncRealProjects`）
import { ShieldAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function PrivilegedProjectMark({ projectName }: { projectName: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          data-testid="sidebar-project-privileged"
          aria-label={`${projectName} は特権コンテナです`}
          className="flex size-5 shrink-0 items-center justify-center text-stop"
        >
          <ShieldAlert className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">特権コンテナです——この Project の AI はこのサーバの root になれます</TooltipContent>
    </Tooltip>
  );
}
