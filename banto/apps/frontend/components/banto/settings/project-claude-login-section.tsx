"use client";

// **この Project に Claude のログインを使わせる**（決定・2026-09-27、ユーザー。`docs/specs/v4-security.md` §2）。既定はオン。
//
// オンの Project では、コンテナの中のコマンド（`claude -p`・Agent SDK を使うアプリ・サブエージェント・Service）が
// banto 本体の Claude ログインで推論を呼べる。本物のトークンは中に入らない——core の中継が差し替える。1回ごとの
// 承認は出さない代わりに、**使われた回数と最後の時刻・直近の 401（本体のログインの期限切れ）をここで見られる**。
//
// 切るとその時点で合言葉が無効になり、入れ直すと新しいものが出る。立っている Module の環境が変わるのは、次に起きたとき。
// **押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、表示を元に戻す（規則2）
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fetchRealClaudeLogin, setRealClaudeLogin, type RealClaudeLogin } from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";

type Loaded = { projectId: string } & ({ value: RealClaudeLogin } | { error: string });

function at(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ProjectClaudeLoginSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRealClaudeLogin(projectId)
      .then((value) => !cancelled && setLoaded({ projectId, value }))
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const state = current && "value" in current ? current.value : null;
  const error = current && "error" in current ? current.error : null;

  async function toggle(enabled: boolean) {
    if (!state || saving) return;
    const before = state;
    setSaving(true);
    setLoaded({ projectId, value: { ...state, enabled } });
    try {
      setLoaded({ projectId, value: await setRealClaudeLogin(projectId, enabled) });
    } catch (err) {
      setLoaded({ projectId, value: before });
      reportFailure("Claude のログインの設定を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="project-claude-login-section" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">Claude のログイン</h2>
      <p className="mb-3 text-xs text-ink-3">
        {"コンテナの中の claude -p・Agent SDK・サブエージェントが、banto 本体の Claude ログインで動きます。" +
          "本物のトークンは中に入りません。"}
      </p>
      {error ? (
        <p data-testid="project-claude-login-error" className="text-xs text-stop">
          設定を読めませんでした：{error}
        </p>
      ) : !state ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="project-claude-login">この Project に Claude のログインを使わせる</Label>
              <p className="text-xs text-ink-3">
                {"切るとすぐ使えなくなり、入れ直すと新しい合言葉になります。" +
                  "立っている Module の環境が変わるのは、次にその Module が起きたときです。"}
              </p>
            </div>
            <Switch
              id="project-claude-login"
              data-testid="project-claude-login"
              checked={state.enabled}
              disabled={saving}
              onCheckedChange={(v) => void toggle(v)}
            />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-3">本体のログイン</dt>
            <dd data-testid="project-claude-login-host" className={state.hostLogin.loggedIn ? "text-ink-2" : "text-stop"}>
              {state.hostLogin.loggedIn
                ? `ログインしています（契約：${state.hostLogin.subscriptionType ?? "不明"}）`
                : state.hostLogin.reason}
            </dd>
            <dt className="text-ink-3">使った回数</dt>
            <dd data-testid="project-claude-login-requests" className="text-ink-2">
              {`${state.stats.requests} 回（banto を起こしてから）`}
            </dd>
            <dt className="text-ink-3">最後に使った時刻</dt>
            <dd data-testid="project-claude-login-last" className="text-ink-2">
              {state.stats.lastRequestAt ? at(state.stats.lastRequestAt) : "まだ使っていません"}
            </dd>
            <dt className="text-ink-3">直近の 401</dt>
            <dd data-testid="project-claude-login-unauthorized" className={state.stats.lastUnauthorizedAt ? "text-stop" : "text-ink-2"}>
              {state.stats.lastUnauthorizedAt
                ? `${at(state.stats.lastUnauthorizedAt)}（本体のログインが期限切れでした）`
                : "ありません"}
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}
