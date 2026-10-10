"use client";

// **この Project の実行場所——読むだけ**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」。画面はモックの
// `RuntimeReadOnly` の形で決定・2026-10-10）。作るときに決め、あとから変えない——変えると Project のフォルダが別の機械へ
// 移ることになる。別のサーバなら、根はそのサーバのパスで、この機械には無い。
//
// モックでは「セキュリティ境界」の節に置いたが、本物ではその節はまだモックのまま隠れている（`project-settings-content.tsx`
// の MOCK_CATEGORIES）。根を出している「一般」の、Root パスのすぐ上に置く
import { useEffect, useState } from "react";
import { Server, ShieldCheck } from "lucide-react";
import { listRealRuntimes, remoteRuntimeName, type RealRemoteRuntime } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";
import { sshTarget } from "@/components/banto/settings/runtimes-panel";

export function ProjectRuntimeSection({ runtime }: { runtime: string | undefined }) {
  const name = remoteRuntimeName(runtime);
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
      <div className="flex min-w-0 flex-col gap-0.5">
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
            ? `下の根は ${name} の上のフォルダです。サーバ丸ごとがこの Project の箱で、そのサーバの中ではコンテナのような閉じ込めはありません。実行場所はあとから変えられません。`
            : "実行場所はあとから変えられません。"}
        </p>
        {shown?.error ? <p className="text-xs text-stop">別のサーバの登録を読めませんでした：{shown.error}</p> : null}
        {shown && !shown.error && !shown.value ? (
          <p className="text-xs text-stop">実行場所「{name}」の登録が見つかりません。</p>
        ) : null}
      </div>
    </div>
  );
}
