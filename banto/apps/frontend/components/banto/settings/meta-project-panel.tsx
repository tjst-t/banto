"use client";

// **メタ Project の設定**（追加・2026-10-23、アーキ仕様 §4.6、Backlog #538）。メタ Project（`kind: "meta"`）だけが持つ
// 設定——管理対象の Project の一覧と、release の扱い。見た目はモック（fork/meta-project の `meta-project-panel.tsx`）。
//
// Backlog の置き場（tasks.json・Gist）はここに置かない——Backlog Module 自身の設定面で選ぶ、普通の Module 設定の範囲
// （モックのレビュー指摘・2026-10-23）。
//
// 管理対象の候補は、サイドバーと同じ順序・グループ構造で出す（グループなし → グループ → スリープ中）。自分自身と
// メタ Project は出さない（host も断る）。**押したらすぐ保存する**——管理対象は一覧そのものを host に渡し、host が
// 専用の Fork を立てる・閉じる。表示するのは host が返した一覧（規則3）。失敗したら言い、表示は host の値のまま（規則2）
import { useEffect, useState } from "react";
import { Moon, Network, Rocket } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  fetchRealMetaRelease,
  listRealProjects,
  setRealManagedProjects,
  setRealMetaRelease,
  type RealMetaRelease,
} from "@/lib/backend/client";
import { GROUP_DOT_CLASS, projectSections, useProjectGroups } from "@/lib/backend/project-groups";
import { getAwakeProjects, getSleepingProjects, syncRealForks } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockProject } from "@/lib/mock/types";
import { reportFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";

type Loaded = { projectId: string } & ({ managed: string[]; release: RealMetaRelease } | { error: string });

export function MetaProjectPanel({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const groups = useProjectGroups();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listRealProjects(), fetchRealMetaRelease(projectId)])
      .then(([projects, release]) => {
        if (cancelled) return;
        const self = projects.find((p) => p.id === projectId);
        if (!self) throw new Error("host にこの Project がありません");
        setLoaded({ projectId, managed: self.managedProjectIds ?? [], release });
      })
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const state = current && "managed" in current ? current : null;
  const error = current && "error" in current ? current.error : null;

  const isCandidate = (p: MockProject) => p.id !== projectId && p.kind !== "meta";
  const sections = projectSections(getAwakeProjects().filter(isCandidate), groups).filter((s) => s.projects.length > 0);
  const sleeping = getSleepingProjects().filter(isCandidate);
  const candidateCount = sections.reduce((n, s) => n + s.projects.length, 0) + sleeping.length;

  async function toggleManaged(targetId: string, on: boolean) {
    if (!state || saving) return;
    const next = on ? [...state.managed, targetId] : state.managed.filter((id) => id !== targetId);
    setSaving(true);
    try {
      const saved = await setRealManagedProjects(projectId, next);
      setLoaded({ projectId, managed: saved.managedProjectIds ?? [], release: state.release });
      // host が立てた・閉じた専用の Fork をサイドバーへ
      await syncRealForks(projectId);
    } catch (err) {
      reportFailure("管理対象の Project を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRelease(delegate: boolean) {
    if (!state || saving) return;
    setSaving(true);
    try {
      const release = await setRealMetaRelease(projectId, delegate ? "delegate" : "human");
      setLoaded({ projectId, managed: state.managed, release });
    } catch (err) {
      reportFailure("release の扱いを保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  function ProjectRow({ project }: { project: MockProject }) {
    const on = state?.managed.includes(project.id) ?? false;
    return (
      <div className="flex items-center justify-between gap-3 py-2" data-testid="meta-managed-row" data-project-id={project.id}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-ink-2">
            {project.initial}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm text-foreground" data-testid="meta-managed-name">
              {project.name}
            </p>
            <p className="truncate text-xs text-ink-3" data-testid="meta-managed-state">
              {on ? "専用 Fork を1本持つ" : "管理していない"}
            </p>
          </div>
        </div>
        <Switch
          id={`meta-managed-${project.id}`}
          data-testid="meta-managed-switch"
          checked={on}
          disabled={saving}
          onCheckedChange={(v) => void toggleManaged(project.id, v)}
          aria-label={`${project.name} を管理対象にする`}
        />
      </div>
    );
  }

  return (
    <div data-testid="meta-project-panel">
      <h1 className="mb-0.5 flex items-center gap-1.5 text-lg font-semibold text-foreground">
        <Network className="size-4 text-ink-3" />
        メタ Project
      </h1>
      <p className="mb-4 text-xs text-ink-3">複数の管理対象 Project を横断してオーケストレーションする、この Project だけの設定。</p>

      {error ? (
        <p data-testid="meta-project-error" className="text-xs text-stop">
          メタ Project の設定を読めませんでした：{error}
        </p>
      ) : !state ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <>
          {/* 管理対象——それぞれに専用 Fork が1本対応する。並びはサイドバーと同じ（探す手間を増やさない） */}
          <section className="mb-5 rounded-md border border-border px-3" data-testid="meta-managed-section">
            <h2 className="flex items-center gap-1.5 py-2.5 text-sm font-semibold text-foreground">
              <Network className="size-3.5 text-ink-3" />
              管理対象の Project
            </h2>
            <p className="mb-2 text-xs text-ink-3">
              {"選んだ Project ごとに専用 Fork を1本持ち、やり取りはその Fork 経由で行います" +
                "（書くのは新規メッセージの送信だけ・読むのは Thread 全体）。並びはサイドバーと同じです。"}
            </p>
            <div className="flex flex-col divide-y divide-border">
              {sections.map(({ group, projects }) =>
                group ? (
                  <div key={group.id} data-testid="meta-managed-group" data-group-id={group.id}>
                    <div className="flex items-center gap-1.5 pt-2.5 pb-1 text-xs font-medium text-ink-3">
                      <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[group.color])} />
                      <span data-testid="meta-managed-group-name">{group.name}</span>
                    </div>
                    <div className="flex flex-col divide-y divide-border pl-3">
                      {projects.map((p) => (
                        <ProjectRow key={p.id} project={p} />
                      ))}
                    </div>
                  </div>
                ) : (
                  projects.map((p) => <ProjectRow key={p.id} project={p} />)
                ),
              )}

              {sleeping.length > 0 ? (
                <div data-testid="meta-managed-sleeping">
                  <div className="flex items-center gap-1.5 pt-2.5 pb-1 text-xs font-medium text-ink-3">
                    <Moon className="size-3 shrink-0" />
                    スリープ中
                  </div>
                  <div className="flex flex-col divide-y divide-border pl-3">
                    {sleeping.map((p) => (
                      <ProjectRow key={p.id} project={p} />
                    ))}
                  </div>
                </div>
              ) : null}

              {candidateCount === 0 ? (
                <p className="py-3 text-xs text-ink-3" data-testid="meta-managed-empty">
                  ほかに選べる Project がありません。
                </p>
              ) : null}
            </div>
          </section>

          {/* release の扱い——既定は「任せる」（アーキ仕様 §4.6「権限」） */}
          <section className="rounded-md border border-border px-3 py-2.5" data-testid="meta-release-section">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="meta-release-policy" className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Rocket className="size-3.5 text-ink-3" />
                  release（main → release の取り込み）
                </Label>
                <p className="mt-0.5 text-xs text-ink-3" data-testid="meta-release-description">
                  {state.release === "delegate"
                    ? "このメタ Project に任せます（既定）。"
                    : "人に残します——release への取り込みは、このメタ Project の AI が自分では決めません。"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-ink-3" data-testid="meta-release-state">
                  {state.release === "delegate" ? "任せる" : "人に残す"}
                </span>
                <Switch
                  id="meta-release-policy"
                  data-testid="meta-release-switch"
                  checked={state.release === "delegate"}
                  disabled={saving}
                  onCheckedChange={(v) => void toggleRelease(v)}
                />
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
