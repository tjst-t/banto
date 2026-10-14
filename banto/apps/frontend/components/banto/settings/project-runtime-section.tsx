"use client";

// **この Project の実行場所**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」。画面はモックの
// `RuntimeReadOnly` の形で決定・2026-10-10）。ここで書き換えはしない——変えるのは「別の実行場所へ移す…」から
// （フォルダと Module の状態を写して切り替える。決定・2026-10-11、§1「Project を別の実行場所へ移す」）。
// 別のサーバなら、根はそのサーバのパスで、この機械には無い。
//
// モックでは「セキュリティ境界」の節に置いたが、本物ではその節はまだモックのまま隠れている（`project-settings-content.tsx`
// の MOCK_CATEGORIES）。根を出している「一般」の、Root パスのすぐ上に置く
//
// **移している間の進み具合と、終わりの結果もここに出す**（追加・2026-10-14、Backlog #293）——移す小窓は押したら閉じる
// （写すのは数分〜1時間。小窓のままだと下の画面ごと触れなくなる）。会話の面の帯と同じ知らせ（`runtime-moves.ts`）を見る
import { useEffect, useState } from "react";
import { ArrowRightLeft, CircleCheck, CircleX, Server, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listRealRuntimes, remoteRuntimeName, type RealRemoteRuntime } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";
import { sshTarget } from "@/components/banto/settings/runtimes-panel";
import { MoveRuntimeDialog } from "@/components/banto/settings/move-runtime-dialog";
import { MoveDoneText } from "@/components/banto/thread/runtime-move-banner";
import {
  MOVE_PHASE_LABEL,
  dismissRuntimeMoveDone,
  dismissRuntimeMoveFailure,
  formatMoveSize,
  useProjectMoving,
  useRuntimeMove,
  useRuntimeMoveDone,
  useRuntimeMoveFailure,
} from "@/lib/backend/runtime-moves";

export function ProjectRuntimeSection({ projectId, runtime }: { projectId: string; runtime: string | undefined }) {
  const name = remoteRuntimeName(runtime);
  const [moving, setMoving] = useState(false);
  // 移している間は押せない（進み具合は下の欄。進むたびにこの欄ごと描き直さない）
  const busyMoving = useProjectMoving(projectId);
  const [remote, setRemote] = useState<{ name: string; value?: RealRemoteRuntime; error?: string } | null>(null);
  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    listRealRuntimes().then(
      (list) => !cancelled && setRemote({ name, value: list.find((r) => r.name === name) }),
      (err: unknown) => !cancelled && setRemote({ name, error: describeFailure(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [name]);
  const shown = remote?.name === name ? remote : null;

  return (
    <div className="flex flex-col gap-2">
    <div
      className="flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5"
      data-testid="project-runtime"
      data-runtime={runtime ?? "host-container"}
    >
      {name ? <Server className="mt-0.5 size-4 shrink-0 text-ink-3" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink-3" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm text-foreground" data-testid="project-runtime-where">
          {name ? (
            <>
              {name}{" "}
              {shown?.value ? <span className="font-mono text-xs text-ink-3">{sshTarget(shown.value)}</span> : null} で動いています
            </>
          ) : (
            "この機械のコンテナで動いています"
          )}
        </p>
        <p className="text-xs text-ink-3">
          {name
            ? `下の根は ${name} の上のフォルダです。サーバ丸ごとがこの Project の箱で、そのサーバの中ではコンテナのような閉じ込めはありません。`
            : "banto と同じ機械の、この Project 専用のコンテナです。"}
        </p>
        {shown?.error ? <p className="text-xs text-stop">別のサーバの登録を読めませんでした：{shown.error}</p> : null}
        {shown && !shown.error && !shown.value ? (
          <p className="text-xs text-stop">実行場所「{name}」の登録が見つかりません。</p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1 px-2 text-xs"
        onClick={() => setMoving(true)}
        disabled={busyMoving}
        data-testid="project-runtime-move"
      >
        <ArrowRightLeft className="size-3.5" /> 別の実行場所へ移す…
      </Button>
      <MoveRuntimeDialog projectId={projectId} open={moving} onOpenChange={setMoving} />
    </div>
    <MoveStatus projectId={projectId} />
    </div>
  );
}

/** 移している間の進み具合・終わりの結果（移せなかった理由） */
function MoveStatus({ projectId }: { projectId: string }) {
  const move = useRuntimeMove(projectId);
  const failure = useRuntimeMoveFailure(projectId);
  const done = useRuntimeMoveDone(projectId);

  if (move) {
    const ratio = move.totalBytes && move.totalBytes > 0 ? Math.min(1, (move.copiedBytes ?? 0) / move.totalBytes) : 0;
    return (
      <div className="flex flex-col gap-1.5 rounded-md bg-surface-2 px-3 py-2.5 text-xs text-ink-2" role="status" data-testid="project-runtime-moving">
        <p className="text-sm text-foreground">
          {move.from.label} から {move.to.label}（<span className="font-mono text-xs">{move.to.root}</span>）へ移しています
        </p>
        <p data-testid="project-runtime-moving-phase">
          {move.phase ? MOVE_PHASE_LABEL[move.phase] : "移しています"}…
          <span data-testid="project-runtime-moving-size">{formatMoveSize(move)}</span>
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full bg-turn transition-[width]" style={{ width: `${ratio * 100}%` }} />
        </div>
        <p className="text-ink-3">この Project の会話は、終わるまで止まっています。ほかの Project は普通に使えます。</p>
      </div>
    );
  }

  if (failure) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-stop-soft px-3 py-2.5 text-xs text-ink-2" role="alert" data-testid="project-runtime-move-failed">
        <CircleX className="mt-0.5 size-3.5 shrink-0 text-stop" />
        <p className="min-w-0 flex-1 break-words">
          移せませんでした：<span data-testid="project-runtime-move-failed-reason">{failure.reason}</span>
          元の {failure.from.label}（{failure.from.root}）のまま動いています
        </p>
        <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label="この知らせを閉じる" onClick={() => dismissRuntimeMoveFailure(projectId)}>
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-xs text-ink-2" role="status" data-testid="project-runtime-moved">
        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" />
        <p className="min-w-0 flex-1 break-words">
          <MoveDoneText done={done} testIdPrefix="project-runtime-moved" />
        </p>
        <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label="この知らせを閉じる" onClick={() => dismissRuntimeMoveDone(projectId)}>
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return null;
}
