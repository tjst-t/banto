"use client";

// **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4「承認をすべて自動で許可する」）。
//
// オンの Project では、banto が人に「許可するか」を聞くもの（AI の tool の確認・Module 間の呼び出しの確認・Project を
// またぐメッセージ・公開）を全部、人に聞かずに許可する。**Vault の秘密の取り出しも公開も含む**——説明ではっきり言う。
// 通したものは会話に「自動で許可しました」のカードで残り、覚えない（切ればまた聞く）。
//
// **押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、表示を元に戻す（規則2）。
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { refreshAutoApproveAll, saveAutoApproveAll } from "@/lib/backend/auto-approve";
import { reportFailure } from "@/lib/report-failure";

type Loaded = { projectId: string } & ({ enabled: boolean } | { error: string });

export function ProjectAutoApproveSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    refreshAutoApproveAll(projectId)
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
      setLoaded({ projectId, enabled: await saveAutoApproveAll(projectId, next) });
    } catch (err) {
      setLoaded({ projectId, enabled });
      reportFailure("承認をすべて自動で許可する の設定を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="project-auto-approve-section" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">承認</h2>
      {/* 文を JSX の中で折り返さない——改行が空白になり、日本語の途中に隙間が出る */}
      <p className="mb-3 text-xs text-ink-3">
        {"この Project で banto が「許可するか」を聞くもの（AI の tool の確認・Module 間の呼び出しの確認・" +
          "ほかの Project へのメッセージ・公開）を、まとめて扱います。"}
      </p>
      {error ? (
        <p data-testid="project-auto-approve-error" className="text-xs text-stop">
          設定を読めませんでした：{error}
        </p>
      ) : enabled === null ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <div
          className={
            "flex items-start justify-between gap-4 rounded-md border p-3 " +
            (enabled ? "border-destructive/40 bg-destructive/5" : "border-border")
          }
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="project-auto-approve">承認をすべて自動で許可する</Label>
            <p className="text-xs text-ink-3" data-testid="project-auto-approve-description">
              {"オンにすると、Vault の秘密の取り出し・公開も含めて、この Project の AI が頼んだものは人に聞かずに通ります。" +
                "通したものは会話に「自動で許可しました」と残ります。許可は覚えないので、オフに戻せばまた聞きます。" +
                "パスキーの確認・値の入力（Vault の登録・ログイン）・AI からの質問・Skill の取り込みは、オンでも聞きます。"}
            </p>
          </div>
          <Switch
            id="project-auto-approve"
            data-testid="project-auto-approve"
            checked={enabled}
            disabled={saving}
            onCheckedChange={(v) => void toggle(v)}
          />
        </div>
      )}
    </section>
  );
}
