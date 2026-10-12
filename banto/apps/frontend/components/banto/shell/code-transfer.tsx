"use client";

// **別のサーバへコードを送っている間の一行**（追加・2026-10-12、Backlog #269）。送り終われば消える（host が
// `code.transfer` を `transfer` 無しで送る）。送れなかったら理由を添えて残る（次に送り始めるまで）。サイドバーの Project の行の下・その Project の会話の入力欄の上・
// 実行場所の設定の行に出す

import { CircleX, CloudUpload } from "lucide-react";
import { cn } from "@/lib/utils";
import { codeTransferText, useProjectCodeTransfer, useRuntimeCodeTransfer } from "@/lib/backend/code-transfers";
import type { RealCodeTransfer } from "@/lib/backend/app-events";

function Line({ transfer, testId, className }: { transfer: RealCodeTransfer; testId: string; className?: string }) {
  const percent = transfer.totalBytes > 0 ? Math.round((transfer.sentBytes / transfer.totalBytes) * 100) : 0;
  const failed = transfer.failed !== undefined;
  return (
    <span
      role={failed ? "alert" : "status"}
      data-testid={testId}
      data-runtime={transfer.runtime}
      data-state={failed ? "failed" : "sending"}
      className={cn("flex min-w-0 flex-col gap-1 text-xs", failed ? "text-stop" : "text-ink-2", className)}
    >
      <span className="flex min-w-0 items-center gap-1">
        {failed ? <CircleX className="size-3 shrink-0" /> : <CloudUpload className="size-3 shrink-0 text-ink-3" />}
        <span className="truncate" data-testid="code-transfer-text">{codeTransferText(transfer)}</span>
      </span>
      {/* 理由は全文を出す（切り詰めると何が起きたか分からない）。次に送り始めたら進み具合に戻る */}
      {failed ? (
        <span data-testid="code-transfer-reason" className="break-words text-ink-2">
          {transfer.failed}
        </span>
      ) : null}
      <span aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full bg-ink-3 transition-[width]" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/** その Project の実行場所へ送っている間（と、送れなかったとき）だけ出す */
export function ProjectCodeTransferLine({ projectId, testId, className }: { projectId: string; testId: string; className?: string }) {
  const transfer = useProjectCodeTransfer(projectId);
  return transfer ? <Line transfer={transfer} testId={testId} className={className} /> : null;
}

/** その実行場所（別のサーバの名前）へ送っている間（と、送れなかったとき）だけ出す */
export function RuntimeCodeTransferLine({ runtime, testId, className }: { runtime: string; testId: string; className?: string }) {
  const transfer = useRuntimeCodeTransfer(runtime);
  return transfer ? <Line transfer={transfer} testId={testId} className={className} /> : null;
}
