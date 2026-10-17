"use client";

// **別のサーバに繋がらない Project の頭文字の左上の「!」**（追加・2026-10-17、ユーザー要望。Backlog #383）。
// 開かなくても「どこで困っているか」が分かるように、いま開いている Project の行にも、畳んだレール・携帯の Drawer にも出す。
// 判定は受信箱の「<実行場所> に繋げません」と同じ1つ（host の `remote-outage.ts`、3 分続いたら出し、繋がったら消える）。
// 右下は裏の仕事の数（`background-work.tsx`）・Fork の印は右上なので、左上に置く。押すと Project の設定の実行場所（全般の節）
import { usePathname, useSearchParams } from "next/navigation";
import { UrlLink as Link } from "@/components/banto/url-link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProjectUnreachable } from "@/lib/backend/unreachable-runtimes";
import { settingsOpenHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";

export function UnreachableProjectMark({
  projectId,
  className,
  onNavigate,
}: {
  projectId: string;
  /** 置く位置（行とレールで頭文字の場所が違う） */
  className: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const unreachable = useProjectUnreachable(projectId);
  if (!unreachable) return null;
  // 別の Project なら、下の画面もその Project の会話にする（設定を開いているときの行き先と同じ——`settings-link.ts`）
  const here = pathname === `/p/${projectId}` || pathname.startsWith(`/p/${projectId}/`);
  const href = here
    ? settingsOpenHref(pathname, searchParams, { project: projectId, section: "project-general" })
    : settingsOpenHref(`/p/${projectId}`, new URLSearchParams(), { project: projectId, section: "project-general" });
  const label = `${unreachable.runtime} に繋げません（${unreachable.reason}）`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          data-testid="sidebar-project-unreachable"
          data-runtime={unreachable.runtime}
          onClick={onNavigate}
          className={cn(
            "absolute z-10 flex size-3.5 items-center justify-center rounded-full bg-turn text-xs leading-none font-bold text-on-color ring-2 ring-sidebar hover:brightness-110",
            className,
          )}
        >
          !
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-80">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
