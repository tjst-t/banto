"use client";

// **Project の設定「Claude のアカウント」**（決定・2026-10-18、v4-frontend.md §6.46・v4-security.md §2「Claude のアカウントを
// 複数持つ」の 5.）。「既定の並びを使う」か「この Project の並びを決める」（1つ以上。1つなら固定）。観測として、いま使って
// いるアカウントと最近の切り替え。真実は host の台帳——変えたら host の返事で描き直す（規則3）。押したらすぐ保存し、
// 失敗したら言って元に戻す（規則2）
import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import {
  fetchClaudeAccounts,
  fetchProjectClaudeAccounts,
  setProjectClaudeAccounts,
  type ClaudeAccountMode,
  type ClaudeAccountSwitchView,
  type ClaudeAccountsState,
  type ProjectClaudeAccounts,
} from "@/lib/backend/client";
import { describeFailure, reportFailure } from "@/lib/report-failure";
import { AccountOrderEditor, MODE_CHOICES, accountPlan, modeName, percent, usageLine } from "@/components/banto/settings/claude-accounts-shared";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

/** 「今日 16:42」「昨日 23:10」「10/16 9:05」 */
function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  const hm = `${at.getHours()}:${pad(at.getMinutes())}`;
  return diff === 0 ? `今日 ${hm}` : diff === 1 ? `昨日 ${hm}` : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

function reasonText(reason: ClaudeAccountSwitchView["reason"], fromLabel: string): string {
  switch (reason.kind) {
    case "threshold":
      return `${fromLabel}の${reason.window === "5h" ? "5時間" : "週"} ${percent(reason.utilization)}%`;
    case "rejected":
      return `${fromLabel}が上限で断られました`;
    case "recovered":
      return "リセットで戻りました";
    case "order":
      return "並びを変えました";
    case "unavailable":
      return `${fromLabel}が使えませんでした`;
  }
}

export function ProjectClaudeAccountsPanel({ projectId }: { projectId: string }) {
  const [accounts, setAccounts] = useState<ClaudeAccountsState | null>(null);
  const [project, setProject] = useState<ProjectClaudeAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Project が替わったら作り直す（呼び元が `key` に Project の id を渡す）
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchClaudeAccounts(), fetchProjectClaudeAccounts(projectId)])
      .then(([a, p]) => {
        if (cancelled) return;
        setAccounts(a);
        setProject(p);
      })
      .catch((err: unknown) => !cancelled && setError(describeFailure(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function save(order: string[] | null) {
    if (!project || saving) return;
    const before = project;
    setSaving(true);
    setProject({ ...project, order, ...(order ? { effectiveOrder: order } : {}) });
    try {
      setProject(await setProjectClaudeAccounts(projectId, { order }));
    } catch (err) {
      setProject(before);
      reportFailure("この Project の並びを保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  async function saveMode(mode: ClaudeAccountMode | null) {
    if (!project || saving || project.mode === mode) return;
    const before = project;
    setSaving(true);
    setProject({ ...project, mode });
    try {
      setProject(await setProjectClaudeAccounts(projectId, { mode }));
    } catch (err) {
      setProject(before);
      reportFailure("この Project の使い方を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <p data-testid="project-claude-accounts-error" className="text-xs text-stop">
        Claude のアカウントを読めませんでした：{error}
      </p>
    );
  }
  if (!accounts || !project) return <p className="text-xs text-ink-3">読み込み中…</p>;

  const byId = new Map(accounts.accounts.map((a) => [a.id, a]));
  const label = (id: string) => byId.get(id)?.label ?? id;
  const mode = project.order ? "own" : "default";
  const balance = project.effectiveMode === "balance";
  // いま使っているもの：上から順には最後に返事をしたもの、均すは直近1時間の固定先（会話ごとに違いうる）
  const inUse = new Set(balance ? (project.pinnedAccounts ?? []) : project.currentAccount ? [project.currentAccount] : []);
  const plans = new Set(project.effectiveOrder.map((id) => byId.get(id)).flatMap((a) => (a ? [accountPlan(a, accounts) ?? "不明"] : [])));
  const now = new Date();
  const switches = [...(project.recentSwitches ?? [])].reverse();

  return (
    <div data-testid="project-claude-accounts-panel" className="flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Claude のアカウント</h1>
        <p className="text-xs text-ink-3">
          {balance
            ? "この Project の会話とコンテナの中の Claude が使うアカウントの並び。新しい会話ごとに、閾値の下で余裕のあるものを選びます。"
            : "この Project の会話とコンテナの中の Claude が使うアカウントの並び。上から順に、閾値の下のものを使います。"}
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">使い方</h2>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {(
            [
              [null, `banto 全体と同じ（いまは${modeName(accounts.mode)}）`],
              ...MODE_CHOICES.map(([m, title]) => [m, title] as const),
            ] as const
          ).map(([id, title]) => (
            <label
              key={id ?? "inherit"}
              data-testid={`project-claude-accounts-use-${id ?? "inherit"}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm text-foreground",
                project.mode === id ? "border-[var(--banto-accent)] bg-surface-2/50" : "border-border",
              )}
            >
              <input
                type="radio"
                name={`claude-accounts-use-${projectId}`}
                checked={project.mode === id}
                disabled={saving}
                onChange={() => void saveMode(id)}
                className="accent-[var(--banto-accent)]"
              />
              {title}
            </label>
          ))}
        </div>
      </section>

      <div role="radiogroup" className="flex flex-col gap-2">
        {(
          [
            ["default", "既定の並びを使う", accounts.defaultOrder.map(label).join(" → ") || "既定の並びは空です"],
            ["own", "この Project の並びを決める", "1つだけ選ぶと、そのアカウントだけを使います"],
          ] as const
        ).map(([id, title, note]) => (
          <label
            key={id}
            data-testid={`project-claude-accounts-mode-${id}`}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3",
              mode === id ? "border-[var(--banto-accent)] bg-surface-2/50" : "border-border",
            )}
          >
            <input
              type="radio"
              name={`claude-accounts-mode-${projectId}`}
              checked={mode === id}
              disabled={saving}
              // 決めるときは、いまの既定の並びから始める
              onChange={() =>
                void save(id === "default" ? null : project.effectiveOrder.length > 0 ? project.effectiveOrder : accounts.defaultOrder)
              }
              className="mt-1 accent-[var(--banto-accent)]"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{title}</span>
              <span data-testid={`project-claude-accounts-mode-${id}-note`} className="text-xs text-ink-3">
                {note}
              </span>
            </span>
          </label>
        ))}
      </div>

      {project.order ? (
        <section className="flex flex-col gap-2">
          <AccountOrderEditor
            testId="project-claude-accounts-order"
            order={project.order}
            accounts={accounts.accounts}
            disabled={saving}
            onChange={(next) => void save(next)}
            renderDetail={usageLine}
            renderBadge={(a) =>
              inUse.has(a.id) ? (
                <span data-testid="project-claude-accounts-current" className="shrink-0 rounded bg-ok-soft px-1.5 py-0.5 text-xs text-ok">
                  {balance ? "直近1時間に使いました" : "いま使っています"}
                </span>
              ) : null
            }
          />
        </section>
      ) : inUse.size > 0 ? (
        <p data-testid="project-claude-accounts-current-line" className="text-xs text-ink-2">
          {balance ? "直近1時間に使ったアカウント" : "いま使っているアカウント"}：{[...inUse].map(label).join("、")}
        </p>
      ) : null}

      {plans.size > 1 ? (
        <p data-testid="project-claude-accounts-mixed-plans" className="flex items-start gap-1.5 text-xs text-warn">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          並びに契約の違うアカウント（{[...plans].join(" と ")}
          ）が入っています。切り替えると、既定のモデルや文脈の長さが変わることがあります。
        </p>
      ) : null}

      <section
        data-testid="project-claude-accounts-switches"
        className="flex flex-col gap-1 border-t border-border pt-4 text-xs text-ink-2"
      >
        <span className="font-medium text-foreground">最近の切り替え</span>
        {switches.length === 0 ? (
          <span className="text-ink-3">まだ切り替えていません</span>
        ) : (
          switches.map((s) => (
            <span key={`${s.at}-${s.from}-${s.to}`} data-testid="project-claude-accounts-switch">
              {whenText(s.at, now)}　{label(s.from)} → {label(s.to)}（{reasonText(s.reason, label(s.from))}）
            </span>
          ))
        )}
      </section>
    </div>
  );
}
