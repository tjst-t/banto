"use client";

// **この Project のコンテナ**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。
//
// この Project の Module と AI のコマンドは、この Project 専用のコンテナ（Ubuntu）の中で動く。道具は中で入れられ、
// 入れたものは残る。**中で Docker を使うか**だけを、ここで選ぶ——使うとコンテナの一部の保護（`/proc`・`/sys` への
// 書き込みの制限）が外れるので、要る Project だけで有効にする。
//
// **押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、表示を元に戻す（規則2）。
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fetchRealProjectContainer, setRealProjectContainerNesting, type RealProjectContainer } from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";
import { ProjectContainerLimits } from "@/components/banto/settings/container-limits";

/** Incus の状態を人の言葉に（知らないものはそのまま出す——言い換えで隠さない） */
function statusLabel(c: RealProjectContainer["container"]): string {
  if (!c) return "まだ作られていません（最初に Module を使うときに作ります）";
  if (c.status === "Running") return "動いている";
  if (c.status === "Stopped") return "止まっている（次に使うときに起こします）";
  return c.status;
}

/** どの Project について読んだものか——別の Project に切り替わったら、読み終わるまで「読み込み中」 */
type Loaded = { projectId: string } & ({ value: RealProjectContainer } | { error: string });

export function ProjectContainerSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRealProjectContainer(projectId)
      .then((value) => !cancelled && setLoaded({ projectId, value }))
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const state = current && "value" in current ? current.value : null;
  const error = current && "error" in current ? current.error : null;

  async function toggle(nesting: boolean) {
    if (!state || saving) return;
    const before = state;
    setSaving(true);
    setLoaded({ projectId, value: { ...state, nesting } });
    try {
      await setRealProjectContainerNesting(projectId, nesting);
      setLoaded({ projectId, value: await fetchRealProjectContainer(projectId) });
    } catch (err) {
      setLoaded({ projectId, value: before });
      reportFailure("中で Docker を使う設定を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="project-container-section" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">コンテナ</h2>
      {/* 文を JSX の中で折り返さない——改行が空白になり、日本語の途中に隙間が出る */}
      <p className="mb-3 text-xs text-ink-3">
        {"この Project の Module と AI のコマンドは、この Project 専用のコンテナ（Ubuntu）の中で動きます。" +
          "要る道具は中で入れられ、入れたものは残ります。"}
      </p>
      {error ? (
        <p data-testid="project-container-error" className="text-xs text-stop">
          コンテナの状態を読めませんでした：{error}
        </p>
      ) : !state ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-2">
            状態：<span data-testid="project-container-status">{statusLabel(state.container)}</span>
          </p>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="project-container-nesting">中で Docker を使う</Label>
              <p className="text-xs text-ink-3">
                {"Docker を使う Project だけ有効にしてください。有効にすると、コンテナの一部の保護（/proc・/sys への書き込みの制限）が外れます。" +
                  "切り替えると、この Project の Module は立て直しになります。"}
              </p>
            </div>
            <Switch
              id="project-container-nesting"
              data-testid="project-container-nesting"
              checked={state.nesting}
              disabled={saving}
              onCheckedChange={(v) => void toggle(v)}
            />
          </div>
          {state.limits && (
            <ProjectContainerLimits
              key={`${projectId}:${JSON.stringify(state.limits.override ?? {})}`}
              projectId={projectId}
              limits={state.limits}
              onSaved={(limits) => setLoaded({ projectId, value: { ...state, limits } })}
            />
          )}
        </div>
      )}
    </section>
  );
}
