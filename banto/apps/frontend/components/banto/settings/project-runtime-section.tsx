"use client";

// **この Project の実行場所**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」。画面はモックの
// `RuntimeReadOnly` の形で決定・2026-10-10）。ここで書き換えはしない——変えるのは「別の実行場所へ移す…」から
// （フォルダと Module の状態を写して切り替える。決定・2026-10-11、§1「Project を別の実行場所へ移す」）。
// 別のサーバなら、根はそのサーバのパスで、この機械には無い。
//
// モックでは「セキュリティ境界」の節に置いたが、本物ではその節はまだモックのまま隠れている（`project-settings-content.tsx`
// の MOCK_CATEGORIES）。根を出している「一般」の、Root パスのすぐ上に置く
import { useEffect, useState } from "react";
import { ArrowRightLeft, Server, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listRealRuntimes, remoteRuntimeName, type RealRemoteRuntime } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";
import { sshTarget } from "@/components/banto/settings/runtimes-panel";
import { MoveRuntimeDialog } from "@/components/banto/settings/move-runtime-dialog";

export function ProjectRuntimeSection({ projectId, runtime }: { projectId: string; runtime: string | undefined }) {
  const name = remoteRuntimeName(runtime);
  const [moving, setMoving] = useState(false);
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
        data-testid="project-runtime-move"
      >
        <ArrowRightLeft className="size-3.5" /> 別の実行場所へ移す…
      </Button>
      <MoveRuntimeDialog projectId={projectId} open={moving} onOpenChange={setMoving} />
    </div>
  );
}
