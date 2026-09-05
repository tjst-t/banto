"use client";

// 「/」の中身（決定・2026-09-03）——固定のデモProjectへ決め打ちで飛ばしていた
// 旧実装を撤去した後の置き換え。実Projectの読み込み（hydrateRealProjects、
// real-projects-bootstrap.tsx）を待ち、1件以上あれば先頭のProjectへ、
// 0件なら新規作成を促す空状態を出す。読み込み中と「本当に0件」を区別する
// （読み込み中に空状態を一瞬見せない）。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { getActiveProjects, hydrateRealProjects } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";

export function HomeContent() {
  useMockStoreVersion();
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  useEffect(() => {
    hydrateRealProjects().then(() => setHydrated(true));
  }, []);

  const projects = getActiveProjects();

  useEffect(() => {
    if (hydrated && projects.length > 0) {
      router.replace(`/p/${projects[0]!.id}`);
    }
  }, [hydrated, projects, router]);

  if (!hydrated || projects.length > 0) {
    // 読み込み中、または遷移が起きるまでの一瞬——何も見せない
    return null;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <FolderPlus className="size-10 text-ink-3" strokeWidth={1.5} />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">まだ Project がありません</p>
        <p className="text-xs text-ink-3">最初の Project を作って始めます</p>
      </div>
      <Button onClick={() => setShowNewProject(true)}>新しい Project を作る</Button>
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </div>
  );
}
