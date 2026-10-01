"use client";

// **メッセージを受け取ってよい Project**（決定・2026-10-01、アーキ仕様 §4.2「Thread 間・Project 間の送り方」）。
//
// ほかの Project の AI がこの Project へメッセージを送るときは、送るたびに人が承認する。承認画面で「以後聞かない」を
// 選ぶと、その Project がここに載り、次からは聞かずに届く。**ここでは外すだけ**——足すのは、実際に送られてきた
// ときの承認画面（何が送られてくるのかを見てから決める）。
//
// **押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、表示を元に戻す（規則2）。
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listRealProjects, setRealMessageSenders, type RealProject } from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";

type Loaded = { projectId: string } & ({ projects: RealProject[] } | { error: string });

export function ProjectMessageSendersSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listRealProjects()
      .then((projects) => !cancelled && setLoaded({ projectId, projects }))
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const projects = current && "projects" in current ? current.projects : null;
  const error = current && "error" in current ? current.error : null;
  const self = projects?.find((p) => p.id === projectId);
  // この画面が実 Project のものでなければ（台本の Project）、出さない——繋がっていないものを見せない（規則13）
  if (projects && !self) return null;
  const senders = self?.acceptMessagesFrom ?? [];

  async function remove(senderId: string) {
    if (!projects || !self || saving) return;
    const before = projects;
    const next = senders.filter((s) => s !== senderId);
    setSaving(true);
    setLoaded({ projectId, projects: projects.map((p) => (p.id === projectId ? { ...p, acceptMessagesFrom: next } : p)) });
    try {
      const saved = await setRealMessageSenders(projectId, next);
      setLoaded({ projectId, projects: before.map((p) => (p.id === projectId ? saved : p)) });
    } catch (err) {
      setLoaded({ projectId, projects: before });
      reportFailure("メッセージを受け取ってよい Project を外せませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="project-message-senders" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">メッセージを受け取ってよい Project</h2>
      <p className="mb-3 text-xs text-ink-3">
        {"ほかの Project の AI からのメッセージは、送られるたびに確認します。" +
          "確認で「以後聞かない」を選んだ Project がここに並び、そこからは確認なしで届きます。"}
      </p>
      {error ? (
        <p className="text-xs text-stop">Project の一覧を読めませんでした：{error}</p>
      ) : !projects ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : senders.length === 0 ? (
        <p className="text-xs text-ink-3" data-testid="project-message-senders-empty">
          まだありません。
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {senders.map((id) => {
            const p = projects.find((x) => x.id === id);
            return (
              <li key={id} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="project-message-sender">
                <span className="min-w-0 truncate text-sm text-foreground">
                  {p ? p.name : `（見つからない Project ${id.slice(0, 8)}）`}
                  {p?.status === "closed" ? <span className="ml-2 text-xs text-ink-3">閉じています</span> : null}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={saving}
                  onClick={() => void remove(id)}
                  aria-label={`${p?.name ?? id} を外す`}
                >
                  <X className="size-3.5" />
                  外す
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
