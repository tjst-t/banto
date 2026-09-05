"use client";

// Shell Module の runCommand（v4-modules.md §2.3）——会話内のインラインカード。
// resource を持たない Shell は、FileSystem/Repo のような Canvas コンテンツへの
// inline 参照（InlineModuleView）を経由せず、この専用カードでその場に描く。
//
// **同じ tool の2段階を1つのカードで見せる**：承認ゲート（実行前）では
// command と「使われる alias の一覧」だけを見せて許可/拒否を待ち、許可されたら
// そのまま同じカードが stdout/stderr/exitCode に変わる。Shell の tool は
// runCommand 1本だけ（v4-modules.md §2.3）なので、承認用の別 tool は無い
// ——承認ゲートは tool の種類ではなく、呼び出しの状態である。
// alias は名前だけ（envSecrets/secretFiles のキーと alias 名、sshIdentity の
// 名前）を出し、値は一切表示しない。
import { useState } from "react";
import { Ban, ChevronDown, KeyRound, Loader2, ShieldAlert, Terminal } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getApprovalResult,
  getDeliveredResult,
  isApprovalGated,
  isPendingRelayResult,
  wasApprovalBypassed,
} from "@/lib/mock/adapter";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { cn } from "@/lib/utils";

interface ShellRunCommandArgs {
  command: string;
  cwd?: string;
  timeout?: number;
  envSecrets?: Record<string, string>;
  secretFiles?: Record<string, string>;
  sshIdentity?: string;
}

interface ShellRunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

const COLLAPSE_AFTER_LINES = 12;

function OutputBlock({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: "ink-2" | "stop";
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const lines = text.split("\n");
  const isLong = lines.length > COLLAPSE_AFTER_LINES;
  const shown = expanded || !isLong ? lines : lines.slice(0, COLLAPSE_AFTER_LINES);

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <pre
        className={cn(
          "overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-xs",
          tone === "stop" ? "text-stop" : "text-ink-2",
        )}
      >
        {shown.join("\n")}
      </pre>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-fit items-center gap-1 text-xs text-ink-3 hover:text-foreground"
        >
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
          {expanded ? "折りたたむ" : `残り${lines.length - COLLAPSE_AFTER_LINES}行を表示`}
        </button>
      ) : null}
    </div>
  );
}

export const ShellCommandCard: ToolCallMessagePartComponent = (props) => {
  // 中継の決着まで待たせている結果は、後からこちら側の store に届く
  // （assistant-ui のメッセージは追記しかできない）——変化を拾うために購読する
  useMockStoreVersion();
  const args = props.args as unknown as ShellRunCommandArgs;
  // ハンドラの内側で別 Module を呼んでいる間、result には「保留中」の印が入っている
  const awaitingRelay = isPendingRelayResult(props.result);
  const rawResult = awaitingRelay ? getDeliveredResult(props.toolCallId) : props.result;
  const isDeclined =
    rawResult !== undefined && typeof rawResult === "object" && rawResult !== null && "error" in rawResult;
  const declineMessage =
    isDeclined && typeof (rawResult as { error?: unknown }).error === "string"
      ? ((rawResult as { error: string }).error)
      : "拒否しました——コマンドは実行していません";
  const result = isDeclined ? undefined : (rawResult as ShellRunCommandResult | undefined);
  // 承認ゲート経由の呼び出しは、人が許可するまで実行されていない
  const awaitingApproval = rawResult === undefined && !awaitingRelay && isApprovalGated(props.toolCallId);
  const isRunning =
    !awaitingApproval && rawResult === undefined && (awaitingRelay || props.status?.type === "running");
  // permissionMode が bypassPermissions のため、確認を出さずに実行した呼び出し
  const bypassed = wasApprovalBypassed(props.toolCallId);

  const secretBadges = [
    ...Object.entries(args.envSecrets ?? {}).map(([env, alias]) => `${env}=alias:${alias}`),
    ...Object.entries(args.secretFiles ?? {}).map(([path, alias]) => `${path}←alias:${alias}`),
    ...(args.sshIdentity ? [`sshIdentity:${args.sshIdentity}`] : []),
  ];

  return (
    <div
      className={cn(
        "my-1.5 flex flex-col gap-2 overflow-hidden rounded-lg border",
        awaitingApproval ? "border-warn/30 bg-warn-soft/50" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-1.5",
          awaitingApproval ? "border-warn/30" : "border-border bg-surface-2",
        )}
      >
        {awaitingApproval ? (
          <ShieldAlert className="size-3.5 shrink-0 text-warn" />
        ) : (
          <Terminal className="size-3.5 shrink-0 text-ink-3" />
        )}
        <span className={cn("text-xs", awaitingApproval ? "font-semibold text-warn" : "text-ink-3")}>
          {awaitingApproval ? `実行前の確認——${props.toolName}` : props.toolName}
        </span>
        {args.cwd ? (
          <Badge variant="outline" className="font-mono text-xs">
            cwd: {args.cwd}
          </Badge>
        ) : null}
        {args.timeout ? (
          <Badge variant="outline" className="text-xs">
            timeout: {args.timeout}s
          </Badge>
        ) : null}
        {bypassed ? (
          <Badge variant="outline" className="border-warn/40 text-warn">
            <ShieldAlert className="size-3" />
            確認をスキップ（bypassPermissions）
          </Badge>
        ) : null}
        {isRunning ? <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-ink-3" /> : null}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <pre className="overflow-auto rounded-md bg-surface p-2 font-mono text-xs text-foreground">
          $ {args.command}
        </pre>
        {secretBadges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <KeyRound className="size-3 shrink-0 text-ink-3" />
            {secretBadges.map((b) => (
              <Badge key={b} variant="outline" className="font-mono text-xs">
                {b}
              </Badge>
            ))}
            <span className="text-xs text-ink-3">
              {awaitingApproval
                ? "実行時に注入される alias。値はここにも AI の文脈にも出ない"
                : "値は AI の文脈に出ない（alias 名のみ）"}
            </span>
          </div>
        ) : null}
        {awaitingApproval ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => props.addResult?.(getApprovalResult(props.toolCallId))}>
              許可する
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.addResult?.({ error: "ユーザーが拒否しました" })}
            >
              拒否する
            </Button>
          </div>
        ) : null}
        {isDeclined ? (
          <p className="flex items-center gap-1.5 text-xs text-ink-3">
            <Ban className="size-3.5" />
            {declineMessage}
          </p>
        ) : null}
        {result ? (
          <>
            <OutputBlock label="stdout" text={result.stdout} tone="ink-2" />
            <OutputBlock label="stderr" text={result.stderr} tone="stop" />
            <div className="flex items-center gap-2">
              <Badge className={result.exitCode === 0 ? "bg-ok-soft text-ok" : "bg-stop-soft text-stop"}>
                exit {result.exitCode}
              </Badge>
              {result.timedOut ? (
                <Badge variant="outline" className="text-warn">
                  タイムアウト
                </Badge>
              ) : null}
            </div>
          </>
        ) : isRunning ? (
          <p className="text-xs text-ink-3">
            {awaitingRelay ? "実行中…（別 Module への呼び出しを確認中）" : "実行中…"}
          </p>
        ) : null}
      </div>
    </div>
  );
};
