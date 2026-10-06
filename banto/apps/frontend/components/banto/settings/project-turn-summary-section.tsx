"use client";

// **ターンの終わりのまとめ**（決定・2026-10-06、ユーザー。v4-frontend.md §6.35）の Project ごとのスイッチ。既定はオフ。
//
// オンの Project では、AI が人に返すターンの最後に「頼んだこと・結果・決めること（返答の候補つき）」のまとめを出す。
// 次のターンから効く（走っているターンには効かない）。**押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、
// 表示を元に戻す（規則2）
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fetchRealTurnSummary, setRealTurnSummary } from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";

type Loaded = { projectId: string } & ({ enabled: boolean } | { error: string });

export function ProjectTurnSummarySection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRealTurnSummary(projectId)
      .then((enabled) => !cancelled && setLoaded({ projectId, enabled }))
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const enabled = current && "enabled" in current ? current.enabled : null;
  const error = current && "error" in current ? current.error : null;

  async function toggle(next: boolean) {
    if (enabled === null || saving) return;
    setSaving(true);
    setLoaded({ projectId, enabled: next });
    try {
      setLoaded({ projectId, enabled: await setRealTurnSummary(projectId, next) });
    } catch (err) {
      setLoaded({ projectId, enabled });
      reportFailure("ターンの終わりのまとめ の設定を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="project-turn-summary-section" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">会話</h2>
      <p className="mb-3 text-xs text-ink-3">この Project の AI の返し方です。</p>
      {error ? (
        <p data-testid="project-turn-summary-error" className="text-xs text-stop">
          設定を読めませんでした：{error}
        </p>
      ) : enabled === null ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="project-turn-summary">ターンの終わりにまとめを出す</Label>
            <p className="text-xs text-ink-3">
              {"オンにすると、AI が返すたびに会話の一番下へ「頼んだこと・結果・決めること」のまとめを出します。" +
                "決めることには返答の候補が付き、押すと入力欄に入ります。次の返事から効きます。"}
            </p>
          </div>
          <Switch
            id="project-turn-summary"
            data-testid="project-turn-summary"
            checked={enabled}
            disabled={saving}
            onCheckedChange={(v) => void toggle(v)}
          />
        </div>
      )}
    </section>
  );
}
