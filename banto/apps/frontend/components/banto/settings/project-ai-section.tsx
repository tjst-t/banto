"use client";

// **この Project の AI**（v4-frontend.md §6.51）——Project の設定の「一般」の3つのスイッチ。並びと文は新しい Project の
// 画面とそろえる（`project-ai-switches.tsx` だけが持つ）。
//
//  - ターンの終わりのまとめ（決定・2026-10-06、§6.35）。値が無ければオフ。次のターンから効く
//  - 承認をすべて自動で許可する（決定・2026-10-05、§6.4）。値が無ければオフ。オンの Project では、banto が人に「許可するか」を
//    聞くもの（AI の tool の確認・Module 間の呼び出しの確認・ほかの Project へのメッセージ・公開）を全部、人に聞かずに許可する。
//    **Vault の秘密の取り出しも公開も含む**——説明ではっきり言う。入力欄の印と同じ値を見る（`lib/backend/auto-approve.ts`）
//  - 空いた会話を冷める前に要約する（決定・2026-10-20、アーキ仕様 §3.1）。値が無ければオン
//
// **押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、表示を元に戻す（規則2）
import { useEffect, useState } from "react";
import { PROJECT_AI_HEADING, PROJECT_AI_SWITCHES, ProjectAiSwitchRow, type ProjectAiSwitchKey } from "@/components/banto/project/project-ai-switches";
import { refreshAutoApproveAll, saveAutoApproveAll } from "@/lib/backend/auto-approve";
import { fetchRealIdleCompaction, fetchRealTurnSummary, setRealIdleCompaction, setRealTurnSummary } from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";

/** 各スイッチの読み書きと、画面の印（既存の試験・入力欄が見る名前を変えない） */
const BACKENDS: Record<ProjectAiSwitchKey, { load: (id: string) => Promise<boolean>; save: (id: string, v: boolean) => Promise<boolean>; testId: string }> = {
  turnSummary: { load: fetchRealTurnSummary, save: setRealTurnSummary, testId: "project-turn-summary" },
  autoApproveAll: { load: refreshAutoApproveAll, save: saveAutoApproveAll, testId: "project-auto-approve" },
  idleCompaction: { load: fetchRealIdleCompaction, save: setRealIdleCompaction, testId: "project-idle-compaction" },
};

type Loaded = { projectId: string } & ({ enabled: boolean } | { error: string });

function ProjectAiRow({ projectId, switchKey }: { projectId: string; switchKey: ProjectAiSwitchKey }) {
  const backend = BACKENDS[switchKey];
  const label = PROJECT_AI_SWITCHES.find((s) => s.key === switchKey)!.label;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    backend
      .load(projectId)
      .then((enabled) => !cancelled && setLoaded({ projectId, enabled }))
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId, backend]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const enabled = current && "enabled" in current ? current.enabled : null;
  const error = current && "error" in current ? current.error : null;

  async function toggle(next: boolean) {
    if (enabled === null || saving) return;
    setSaving(true);
    setLoaded({ projectId, enabled: next });
    try {
      setLoaded({ projectId, enabled: await backend.save(projectId, next) });
    } catch (err) {
      setLoaded({ projectId, enabled });
      reportFailure(`${label} の設定を保存できませんでした`, err);
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <p data-testid={`${backend.testId}-error`} className="text-xs text-stop">
        {label}の設定を読めませんでした：{error}
      </p>
    );
  }
  if (enabled === null) return <p className="text-xs text-ink-3">読み込み中…</p>;
  return (
    <ProjectAiSwitchRow
      switchKey={switchKey}
      id={backend.testId}
      testId={backend.testId}
      checked={enabled}
      disabled={saving}
      onCheckedChange={(v) => void toggle(v)}
    />
  );
}

export function ProjectAiSection({ projectId }: { projectId: string }) {
  return (
    <section data-testid="project-ai-section" className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{PROJECT_AI_HEADING}</h2>
      <div className="flex flex-col gap-2">
        {PROJECT_AI_SWITCHES.map((s) => (
          <ProjectAiRow key={s.key} projectId={projectId} switchKey={s.key} />
        ))}
      </div>
    </section>
  );
}
