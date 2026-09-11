"use client";

// 「/」の中身（決定・2026-09-03）——固定のデモProjectへ決め打ちで飛ばしていた
// 旧実装を撤去した後の置き換え。実Projectの読み込み（hydrateRealProjects、
// real-projects-bootstrap.tsx）を待ち、1件以上あれば先頭のProjectへ、
// 0件なら新規作成を促す空状態を出す。読み込み中と「本当に0件」を区別する
// （読み込み中に空状態を一瞬見せない）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, PlugZap } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { getActiveProjects, hydrateRealProjects } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { describeFailure } from "@/lib/report-failure";

export function HomeContent() {
  useMockStoreVersion();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);

  // **読み込めなかったことを、画面に出す**（改訂・2026-09-10）。以前は
  // `.then(setHydrated)` だけだったので、host に届かないと `hydrated` が
  // false のまま——**ホームが永遠に真っ白**で、何が起きているか分からなかった
  // （規則2・規則13）。
  // **効果の中で同期に state を触らない**（修正・2026-09-10、lint が拾った）
  // ——「読み込み中」の解除も失敗の消去も、読み込みが返ってから
  const load = useCallback(() => {
    hydrateRealProjects()
      .then(() => {
        setLoadError(null);
        setHydrated(true);
      })
      .catch((err: unknown) => {
        setLoadError(describeFailure(err));
        setHydrated(true); // 「読み込み中」のまま止めない
      });
  }, []);
  useEffect(load, [load]);

  const projects = getActiveProjects();

  // **飛ばすのは一度だけ**（修正・2026-09-06）。getActiveProjects()は毎レンダー
  // 新しい配列を返すので、これを依存に置くと再描画のたびにrouter.replaceが
  // 走っていた——「新しい Project」のダイアログを開いて入力している最中に
  // Projectの読み込みやThreadの登録が入ると、そのたびに遷移が起きて
  // **ダイアログごと入力が消える**（E2Eが「作成する」を押せずに落ちるのが
  // これだった。実測・2026-09-06、docs/notes/2026-09-06-home-redirect-loop.md）。
  const redirected = useRef(false);
  useEffect(() => {
    if (!hydrated || redirected.current) return;
    const first = getActiveProjects()[0];
    if (!first) return;
    redirected.current = true;
    router.replace(`/p/${first.id}`);
  }, [hydrated, router]);

  if (!hydrated || (projects.length > 0 && !loadError)) {
    // 読み込み中、または遷移が起きるまでの一瞬——何も見せない
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* モバイルはサイドバーが無いので、この画面にもナビの入口を置く
          ——Project が0件でも設定・受信箱へ行けるようにする（決定・2026-09-09） */}
      {isMobile ? (
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <MobileNavDrawer projectId={null} />
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">banto</p>
        </header>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {loadError ? (
          // **繋がらないことを言う**（真っ白にしない）。押せば取り直す
          <div data-testid="home-load-error" className="flex flex-col items-center gap-3">
            <PlugZap className="size-10 text-stop" strokeWidth={1.5} />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">banto に繋がりません</p>
              <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
            </div>
            <Button variant="outline" onClick={load}>
              もう一度読み込む
            </Button>
          </div>
        ) : (
          <>
            <FolderPlus className="size-10 text-ink-3" strokeWidth={1.5} />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">まだ Project がありません</p>
              <p className="text-xs text-ink-3">最初の Project を作って始めます</p>
            </div>
            <Button onClick={() => setShowNewProject(true)}>新しい Project を作る</Button>
          </>
        )}
      </div>
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </div>
  );
}
