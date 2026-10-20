"use client";

// **banto 全体の設定「Claude のアカウント」**（決定・2026-10-18、v4-frontend.md §6.46・v4-security.md §2「Claude のアカウントを
// 複数持つ」）。アカウントの一覧と使用率のメーター・切り替える閾値・既定の並び。真実は host の台帳——ここは写しを持たず、
// 変えたら host の返事で描き直す（規則3）。失敗したら言い、表示を元に戻す（規則2）。
//
// 使用率は開いたときに host に読み直してもらう（`/api/oauth/usage`、使っていないアカウントも）。それまでは host が
// 覚えている値（会話の返事の見出しから読んだもの）を出す
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, Pencil, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  fetchClaudeAccounts,
  refreshClaudeAccountUsage,
  removeClaudeAccount,
  renameClaudeAccount,
  updateClaudeAccountSettings,
  type ClaudeAccountMode,
  type ClaudeAccountView,
  type ClaudeAccountsState,
} from "@/lib/backend/client";
import { describeFailure, reportFailure } from "@/lib/report-failure";
import { navigateUrl } from "@/lib/url-nav";
import { ClaudeAccountLoginDialog } from "@/components/banto/settings/claude-account-login-dialog";
import { AccountOrderEditor, IconButton, MODE_CHOICES, UsageMeter, accountPlan, percent } from "@/components/banto/settings/claude-accounts-shared";

/** 閾値を動かしてから保存するまで（指を離すたびに保存しない） */
const THRESHOLD_SAVE_DELAY_MS = 400;

/** 1分ごとに描き直す（「あと n時間m分」「n分前に読みました」） */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function agoText(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return minutes === 0 ? "いま読みました" : `${minutes}分前に読みました`;
}

export function ClaudeAccountsPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState<ClaudeAccountsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  // `?add=1`（受信箱の全部越えのカードの「アカウントを足す」、§6.46「受信箱」）は足すダイアログを開いて来る
  const [dialog, setDialog] = useState<{ target?: ClaudeAccountView } | null>(() => (searchParams.get("add") === "1" ? {} : null));
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null);
  const now = useMinuteClock();

  const reload = useCallback(async () => {
    try {
      setState(await fetchClaudeAccounts());
      setLoadError(null);
    } catch (err) {
      setLoadError(describeFailure(err));
    }
  }, []);

  const readUsage = useCallback(async () => {
    setReading(true);
    try {
      const { failures: f, ...next } = await refreshClaudeAccountUsage();
      setState(next);
      setFailures(new Map(f.map((x) => [x.accountId, x.reason])));
    } catch (err) {
      reportFailure("使用率を読み直せませんでした", err);
    } finally {
      setReading(false);
    }
  }, []);

  // 開いたら、まず覚えている値で描き、それから読み直す（§2 の 7.）
  useEffect(() => {
    let cancelled = false;
    fetchClaudeAccounts()
      .then((value) => {
        if (cancelled) return;
        setState(value);
        void readUsage();
      })
      .catch((err: unknown) => !cancelled && setLoadError(describeFailure(err)));
    return () => {
      cancelled = true;
    };
  }, [readUsage]);

  async function saveOrder(next: string[]) {
    if (!state || saving) return;
    const before = state;
    setSaving(true);
    setState({ ...state, defaultOrder: next });
    try {
      setState(await updateClaudeAccountSettings({ defaultOrder: next }));
    } catch (err) {
      setState(before);
      reportFailure("既定の並びを保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  async function saveMode(mode: ClaudeAccountMode) {
    if (!state || saving || state.mode === mode) return;
    const before = state;
    setSaving(true);
    setState({ ...state, mode });
    try {
      setState(await updateClaudeAccountSettings({ mode }));
    } catch (err) {
      setState(before);
      reportFailure("使い方を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  async function saveThresholds(next: { fiveHour: number; sevenDay: number }) {
    try {
      const saved = await updateClaudeAccountSettings({ thresholds: next });
      setState((s) => (s ? { ...s, thresholds: saved.thresholds } : saved));
    } catch (err) {
      reportFailure("切り替える閾値を保存できませんでした", err);
      await reload();
    }
  }

  async function rename(id: string, label: string) {
    try {
      setState(await renameClaudeAccount(id, label));
    } catch (err) {
      reportFailure("名前を変えられませんでした", err);
    }
  }

  async function remove(a: ClaudeAccountView) {
    try {
      await removeClaudeAccount(a.id);
      setRemoving(null);
      await reload();
    } catch (err) {
      reportFailure(`${a.label}を外せませんでした`, err);
    }
  }

  if (loadError) {
    return (
      <p data-testid="claude-accounts-error" className="text-xs text-stop">
        Claude のアカウントを読めませんでした：{loadError}
      </p>
    );
  }
  if (!state) return <p className="text-xs text-ink-3">読み込み中…</p>;

  const balance = state.mode === "balance";
  const removingFrom = removing ? state.projectOrders.filter((p) => p.order.includes(removing.id)) : [];
  return (
    <div data-testid="claude-accounts-panel" className="flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Claude のアカウント</h1>
        {/* 呼び名（並び）は変えず、説明文だけ使い方で変える（§6.46「使い方」） */}
        <p data-testid="claude-accounts-lead" className="text-sm text-ink-2">
          会話と、コンテナの中の Claude（サブエージェント・Factory
          など）が使うアカウントです。
          {balance ? "会話ごとに余裕のあるアカウントを選び、閾値を越えたら移ります。" : "使用量が閾値を越えると、並びの次のアカウントに切り替えます。"}
        </p>
      </header>

      {state.noRefreshReason ? (
        <div
          data-testid="claude-accounts-no-refresh"
          className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-foreground"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span>
            この banto では会話の本体は今のログイン（このマシンの Claude Code のログイン）だけを使います（{state.noRefreshReason}）。
            足したアカウントと並びは、コンテナの中の Claude（サブエージェント・Factory など）にだけ効きます。
          </span>
        </div>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">アカウント</h2>
          <Button data-testid="claude-accounts-add" size="sm" variant="outline" onClick={() => setDialog({})}>
            <Plus className="size-3.5" />
            アカウントを足す
          </Button>
        </div>
        <ul data-testid="claude-accounts-list" className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {state.accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              state={state}
              now={now}
              failure={failures.get(a.id)}
              onRename={(label) => rename(a.id, label)}
              onRelogin={() => setDialog({ target: a })}
              onRemove={() => setRemoving(a)}
            />
          ))}
        </ul>
        <button
          type="button"
          data-testid="claude-accounts-read-usage"
          disabled={reading}
          onClick={() => void readUsage()}
          className="flex items-center gap-1 self-start text-xs text-ink-3 hover:text-ink-2 disabled:opacity-60"
        >
          <RefreshCw className={reading ? "size-3 animate-spin" : "size-3"} />
          {reading ? "使用率を読んでいます…" : `使用率を読み直す${state.usageReadAt ? `（${agoText(state.usageReadAt, now)}）` : ""}`}
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">使い方</h2>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
          {MODE_CHOICES.map(([id, title, note]) => (
            <label
              key={id}
              data-testid={`claude-accounts-mode-${id}`}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3",
                state.mode === id ? "border-[var(--banto-accent)] bg-surface-2/50" : "border-border",
              )}
            >
              <input
                type="radio"
                name="claude-accounts-mode"
                checked={state.mode === id}
                disabled={saving}
                onChange={() => void saveMode(id)}
                className="mt-1 accent-[var(--banto-accent)]"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{title}</span>
                <span className="text-xs text-ink-3">{note}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">切り替える閾値</h2>
        <p className="text-xs text-ink-2">
          どちらかを越えたアカウントは使わず、並びの次へ移ります。リセットされたら元のアカウントに戻ります。
        </p>
        <Thresholds value={state.thresholds} onSave={saveThresholds} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">既定の並び</h2>
        <p data-testid="claude-accounts-default-order-note" className="text-xs text-ink-2">
          {balance
            ? "Project で並びを決めていなければ、この中から、新しい会話ごとに余裕のあるものを選びます。同じ余裕なら上を先に使います。"
            : "Project で並びを決めていなければ、この順で使います。上ほど先に使います。"}
        </p>
        <AccountOrderEditor
          testId="claude-accounts-default-order"
          order={state.defaultOrder}
          accounts={state.accounts}
          disabled={saving}
          onChange={(next) => void saveOrder(next)}
          renderDetail={(a) => (a.kind === "host" ? "~/.claude" : (a.email ?? ""))}
        />
      </section>

      {dialog ? (
        <ClaudeAccountLoginDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            setDialog(null);
            // 閉じたら URL から外す——読み直すたびに開かない
            if (searchParams.has("add")) {
              const params = new URLSearchParams(searchParams.toString());
              params.delete("add");
              navigateUrl(router, `${pathname}?${params.toString()}`, { replace: true });
            }
          }}
          target={dialog?.target}
          inDefaultOrder={(id) => state.defaultOrder.includes(id)}
          onAdded={async () => {
            await reload();
            void readUsage();
          }}
          onAppendToDefaultOrder={async (id) => {
            // 足した直後の一覧（host の返事）に対して足す——画面の写しが古くても重ねない
            const latest = await fetchClaudeAccounts();
            if (!latest.defaultOrder.includes(id)) await saveOrder([...latest.defaultOrder, id]);
          }}
        />
      ) : null}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent data-testid="claude-accounts-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{removing?.label}を外しますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm text-ink-2">
                <p>banto に置いたこのアカウントのログインを消し、並びから外します。</p>
                <p>claude.ai の設定からもこのログインを取り消してください。</p>
                {removingFrom.length > 0 ? (
                  <p data-testid="claude-accounts-remove-projects">
                    並びから消える Project：
                    {removingFrom.map((p) => p.name).join("、")}
                    {removingFrom.some((p) => p.order.length === 1)
                      ? "（このアカウントだけを使っていた Project は既定の並びに戻ります）"
                      : ""}
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              data-testid="claude-accounts-remove-confirm"
              variant="destructive"
              onClick={() => removing && void remove(removing)}
            >
              外す
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AccountRow({
  account: a,
  state,
  now,
  failure,
  onRename,
  onRelogin,
  onRemove,
}: {
  account: ClaudeAccountView;
  state: ClaudeAccountsState;
  now: number;
  failure: string | undefined;
  onRename: (label: string) => Promise<void>;
  onRelogin: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.label);
  const plan = accountPlan(a, state);
  const usedByLabel = state.mode === "balance" ? "直近1時間に使った Project" : "いま使っている Project";
  const hostLoggedOut = a.kind === "host" && state.hostLogin && !state.hostLogin.loggedIn ? state.hostLogin.reason : undefined;

  async function commit() {
    // Enter と離れたことの両方で呼ばれる——2回目は何もしない
    if (!editing) return;
    const next = draft.trim();
    setEditing(false);
    if (next && next !== a.label) await onRename(next);
  }

  return (
    <li
      data-testid="claude-account-row"
      data-account-id={a.id}
      className="grid gap-4 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_7rem] sm:items-start"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void commit();
            }}
          >
            <Input
              data-testid="claude-account-label-input"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              // Escape は設定から抜ける（use-escape-leave-settings）——取り消しは置かず、離れたら保存する
              onBlur={() => void commit()}
              className="h-7 text-sm"
            />
            <IconButton label="名前を保存">
              <Check className="size-3.5" />
            </IconButton>
          </form>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span data-testid="claude-account-label" className="truncate text-sm font-medium text-foreground">
              {a.label}
            </span>
            <IconButton
              label="名前を変える"
              onClick={() => {
                setDraft(a.label);
                setEditing(true);
              }}
            >
              <Pencil className="size-3" />
            </IconButton>
          </span>
        )}
        <span data-testid="claude-account-identity" className="truncate text-xs text-ink-2">
          {a.kind === "host" ? `~/.claude${plan ? `（${plan}）` : ""}` : `${a.email ?? ""}${plan ? `（${plan}）` : ""}`}
        </span>
        <span data-testid="claude-account-used-by" className="text-xs text-ink-3">
          {a.kind === "host" ? "人の claude コマンドと共有しています。" : ""}
          {/* 均すは固定が最後の要求から1時間生きるので「直近1時間」（v4-security.md §2「均す」の 9.） */}
          {a.usedBy.length > 0
            ? `${usedByLabel}：${a.usedBy.map((p) => p.name).join("、")}`
            : `${usedByLabel} はありません`}
        </span>
        {hostLoggedOut ? <span className="text-xs text-stop">{hostLoggedOut}</span> : null}
        {failure ? (
          <span data-testid="claude-account-usage-failure" className="text-xs text-stop">
            使用率を読めませんでした：{failure}
          </span>
        ) : null}
      </div>
      <UsageMeter
        testId="claude-account-meter-5h"
        label="5時間"
        window={a.usage?.fiveHour}
        threshold={state.thresholds.fiveHour}
        now={now}
      />
      <UsageMeter testId="claude-account-meter-7d" label="週" window={a.usage?.sevenDay} threshold={state.thresholds.sevenDay} now={now} />
      <div className="flex gap-1 sm:flex-col sm:items-end">
        {a.kind === "host" ? null : (
          <>
            <Button data-testid="claude-account-relogin" size="sm" variant="ghost" className="text-xs" onClick={onRelogin}>
              ログインし直す
            </Button>
            <Button data-testid="claude-account-remove" size="sm" variant="ghost" className="text-xs text-stop" onClick={onRemove}>
              外す
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** 5時間と週の2つのスライダー（50〜100%、1刻み）。動かしたら保存（保存ボタンは置かない） */
function Thresholds({
  value,
  onSave,
}: {
  value: { fiveHour: number; sevenDay: number };
  onSave: (next: { fiveHour: number; sevenDay: number }) => Promise<void>;
}) {
  // 動かしている間だけ持つ。保存が済んだら host の値（`value`）に戻す——写しを持ち続けない（規則3）
  const [moving, setMoving] = useState<{
    fiveHour: number;
    sevenDay: number;
  } | null>(null);
  const draft = moving ?? {
    fiveHour: percent(value.fiveHour),
    sevenDay: percent(value.sevenDay),
  };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function change(key: "fiveHour" | "sevenDay", v: number) {
    const next = { ...draft, [key]: v };
    setMoving(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void onSave({
        fiveHour: next.fiveHour / 100,
        sevenDay: next.sevenDay / 100,
      }).finally(() => setMoving(null));
    }, THRESHOLD_SAVE_DELAY_MS);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(
        [
          ["fiveHour", "5時間の使用量", "claude-accounts-threshold-5h"],
          ["sevenDay", "週の使用量", "claude-accounts-threshold-7d"],
        ] as const
      ).map(([key, label, testId]) => (
        <label key={key} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3">
          <span className="flex items-baseline justify-between text-xs">
            <span className="text-ink-2">{label}</span>
            <span data-testid={`${testId}-value`} className="text-sm font-semibold tabular-nums text-foreground">
              {draft[key]}%
            </span>
          </span>
          <input
            data-testid={testId}
            type="range"
            min={50}
            max={100}
            step={1}
            value={draft[key]}
            onChange={(e) => change(key, Number(e.target.value))}
            className="accent-[var(--banto-accent)]"
          />
          <span className="text-xs text-ink-3">100% にすると、上限に当たるまで切り替えません</span>
        </label>
      ))}
    </div>
  );
}
