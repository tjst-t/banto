"use client";

// **設定の「更新」**——banto 自身を GitHub の `release` の最新にする（決定・2026-10-04、アーキ仕様 §2.5
// 「画面から banto を更新する」。形は人が OK を出したモック `mock/components/banto/settings/update-panel.tsx`）。
//
// - 今の版と、最新の release までに入る新しいコミットの一覧。**押す前に何が入るかを読ませる**のが目的
// - 「実行中の呼び出しを待って更新」（主）と「すぐ更新」（副）。待つのは、切れると結果が分からなくなるもの（実行中の
//   呼び出し・続けられない仕事）だけ——AI の会話・続けられる仕事（サブエージェントなど）は起き直したあと続く
//   （2026-10-05、アーキ仕様 §2.5 の待つ段）。「すぐ更新」は先に途中で切れる呼び出しを出して確かめ、最後にパスキー
//   （host が求めたときだけ。少し前に確かめていれば省かれる）
// - 進み具合：取ってくる → 組み立てる → 呼び出しが終わるのを待つ → 起こし直す。待つ間の「待たずにすぐ起こし直す」は、
//   同じ確かめでまだ実行中の呼び出しだけを並べる。「待つのをやめる」は最初の画面に戻る
// - 起こし直しの間は host が居ない——繋がらなくても失敗にせず、画面全体に「繋がり直すのを待っています」を出して待つ
// - 準備が済んでいない（版ごとのフォルダから動いていない・unit が無い）ときは、理由と手順書だけ。ボタンは出さない
//
// 真実は host（`GET /api/admin/update`。進み具合は `update.mjs` が書いた `state.json`）。画面は覚えない（規則3）。
// **読みに行くのは走っている間だけ**——GET は host で git を数回打つので、止まっているときは読まない
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  CircleAlert,
  KeyRound,
  Loader2,
  Minus,
  RefreshCw,
  ScrollText,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { describeFailure } from "@/lib/report-failure";
import { reloadOnceFor, useNewFrontendBuild } from "@/lib/backend/frontend-build";
import { StepUpRequiredError, stepUp } from "@/lib/backend/auth";
import {
  HostUnreachableError,
  cancelUpdate,
  checkForUpdate,
  fetchActivity,
  fetchUpdateLog,
  fetchUpdateStatus,
  forceUpdateNow,
  requestUpdate,
  type ActivityItem,
  type UpdateActivity,
  type UpdateCommit,
  type UpdatePhase,
  type UpdateRunState,
  type UpdateStatus,
  type UpdateWaiting,
} from "@/lib/backend/self-update";
import { cn } from "@/lib/utils";

/** 走っている間に読み直す間隔 */
const POLL_MS = 3000;

type Mode = "wait" | "now";
type StepId = "fetch" | "build" | "wait" | "restart";
const STEPS: readonly StepId[] = ["fetch", "build", "wait", "restart"];
const FINISHED: ReadonlySet<UpdatePhase> = new Set(["done", "failed", "rolled-back", "cancelled"]);

/** `update.mjs` の段を画面の段へ。確かめる（verify）は起こし直すの続き */
function stepOf(phase: UpdatePhase): StepId {
  if (phase === "build" || phase === "wait") return phase;
  if (phase === "restart" || phase === "verify") return "restart";
  return "fetch";
}

const short = (commit: string) => commit.slice(0, 7);

/** 「10月4日 9:31」——この端末の時刻で */
function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 途中で切れるもの1件 */
interface WorkRow {
  key: string;
  title: string;
  projectName?: string;
  since?: string;
  status: "ai" | "human" | "reply" | "call";
  module?: string;
  /** 待つほうに回した理由（続けて切れた回数が上限に達する会話）。あれば状態の代わりに出す */
  reason?: string;
}

/**
 * 待つもの（`blocking`）を1件1行にする。同じ会話の同じ Module の呼び出しは1行にまとめる。`turn` が来るのは
 * `restartable` を返さない古い host に `update.mjs` が全部を待ったときだけ
 */
function workRows(items: readonly ActivityItem[]): WorkRow[] {
  const rows = new Map<string, WorkRow>();
  for (const i of items) {
    const row = workRow(i);
    if (!rows.has(row.key)) rows.set(row.key, row);
  }
  return [...rows.values()];
}

function workRow(i: ActivityItem): WorkRow {
  const untitled = "（題の無い会話）";
  switch (i.kind) {
    case "turn":
      return {
        key: `turn:${i.threadId}`,
        title: i.threadTitle ?? untitled,
        projectName: i.projectName,
        since: i.startedAt,
        status: i.waitingOnHuman ? "human" : "ai",
        ...(i.reason ? { reason: i.reason } : {}),
      };
    case "reply":
      return {
        key: `reply:${i.threadId}:${i.module}`,
        title: i.threadTitle ?? untitled,
        projectName: i.projectName,
        since: i.since,
        status: "reply",
        module: i.module,
      };
    case "moduleReply":
      return {
        key: `module-reply:${i.projectId ?? ""}:${i.caller}:${i.module}`,
        title: `${i.caller} が頼んだ仕事`,
        projectName: i.projectName,
        since: i.since,
        status: "reply",
        module: i.module,
      };
    case "call":
      return {
        key: `call:${i.threadId ?? i.projectId ?? ""}:${i.connName}`,
        title: i.threadTitle ?? `${i.connName} の操作`,
        projectName: i.projectName,
        status: "call",
        module: i.connName,
      };
  }
}

/**
 * **いま途中で切れるものと、起き直したあと続くものの数**（`GET /api/admin/activity`）。待つもの（`blocking`）を返さない古い
 * host には、全部（ターン・返事待ちの仕事・呼び出し）を切れるものとして並べる——`update.mjs` の `waitingOf` と同じ
 */
function cutOffOf(activity: UpdateActivity): { work: WorkRow[]; continuing: number } {
  if (Array.isArray(activity.blocking)) {
    return { work: workRows(activity.blocking), continuing: activity.continuesAfterRestart?.length ?? 0 };
  }
  return {
    work: workRows([
      ...(activity.turns ?? []).map((t) => ({ kind: "turn" as const, ...t })),
      ...(activity.awaitingReplies ?? []).map((r) => ({ kind: "reply" as const, ...r })),
      ...(activity.moduleCalls ?? []).map((c) => ({ kind: "call" as const, ...c })),
    ]),
    continuing: 0,
  };
}

function sinceText(iso: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}分前から` : `${Math.floor(minutes / 60)}時間前から`;
}

/** 本人の確認を求められたら、パスキーを通してからもう一度だけ試す（`withStepUp` と同じ。通している間を画面に出す） */
async function withPasskey<T>(action: () => Promise<T>, onStepUp: () => void): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof StepUpRequiredError)) throw err;
    onStepUp();
    await stepUp();
    return action();
  }
}

type Busy = "check" | "wait" | "now" | "cancel" | "force" | null;

export function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 走っている間に繋がらなくなった（起こし直しで host が居ない）
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [steppingUp, setSteppingUp] = useState(false);
  const [confirm, setConfirm] = useState<{ reason: "now" | "skip-wait"; work: WorkRow[]; continuing: number } | null>(null);
  // この画面で頼んだ形（`state.json` に mode が書かれるまでの間、進み具合の段の出し方に使う）
  const [requestedMode, setRequestedMode] = useState<Mode | null>(null);
  // 「もう一度ためす」で閉じた失敗
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);

  const refresh = useCallback(async (opts: { tolerateUnreachable?: boolean } = {}) => {
    try {
      const next = await fetchUpdateStatus();
      setStatus(next);
      setLoadError(null);
      setReconnecting(false);
      return next;
    } catch (err) {
      if (err instanceof HostUnreachableError && opts.tolerateUnreachable) setReconnecting(true);
      else setLoadError(describeFailure(err));
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchUpdateStatus()
      .then((next) => !cancelled && setStatus(next))
      .catch((err: unknown) => !cancelled && setLoadError(describeFailure(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const watching = (status?.running ?? false) || reconnecting;
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh({ tolerateUnreachable: true });
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [watching, refresh]);

  async function run(key: Exclude<Busy, null>, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(describeFailure(err));
      // 断られた理由が「もう走っている」「一覧が古い」なら、今の姿に描き直す
      await refresh();
    } finally {
      setBusy(null);
      setSteppingUp(false);
    }
  }

  async function request(commit: string, mode: Mode) {
    await withPasskey(() => requestUpdate(commit, mode), () => setSteppingUp(true));
    setRequestedMode(mode);
    await refresh();
  }

  /** すぐ更新：途中で切れる呼び出しがあれば先に確かめる（無ければ確かめない——会話は起き直したあと続く） */
  function pressNow(commit: string) {
    void run("now", async () => {
      const { work, continuing } = cutOffOf(await fetchActivity());
      if (work.length > 0) setConfirm({ reason: "now", work, continuing });
      else await request(commit, "now");
    });
  }

  /** 待たずにすぐ起こし直す：まだ実行中の呼び出しだけ並べる。パスキーは host が求めたときだけ */
  function pressSkipWait() {
    void run("force", async () => {
      const { work, continuing } = cutOffOf(await fetchActivity());
      if (work.length > 0) setConfirm({ reason: "skip-wait", work, continuing });
      else await forceNow();
    });
  }

  async function forceNow() {
    await withPasskey(() => forceUpdateNow(), () => setSteppingUp(true));
    await refresh();
  }

  function confirmed() {
    const current = confirm;
    setConfirm(null);
    if (!current || !status?.latest) return;
    const commit = status.latest.commit;
    if (current.reason === "now") void run("now", () => request(commit, "now"));
    else void run("force", forceNow);
  }

  // **更新したら、この画面も新しくする**（追加・2026-10-05、ユーザー報告「更新したけど何も変わってなさそう」）。
  // host が新しい版で起き直しても、このページは古い画面のプログラムのまま動いていた。更新が終わり、画面のサーバも
  // 新しい印を返したら読み込み直す（1つの版につき1回。ほかのタブ・端末は帯で知らせる、new-build-banner.tsx）
  const newBuild = useNewFrontendBuild();
  useEffect(() => {
    if (!status || newBuild === null) return;
    const done = status.state;
    if (!status.running && done?.phase === "done" && done.to !== null && status.current?.commit === done.to) {
      reloadOnceFor(newBuild);
    }
  }, [status, newBuild]);

  if (!status) {
    if (loadError) {
      return (
        <div data-testid="update-load-error" className="flex flex-col items-start gap-2 rounded-md border border-border p-3">
          <p className="text-sm text-foreground">更新の情報を取得できませんでした</p>
          <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
          <Button variant="outline" size="sm" className="h-9 px-2 text-xs sm:h-7" onClick={() => void refresh()}>
            再読み込み
          </Button>
        </div>
      );
    }
    return <p className="text-xs text-ink-3">読み込み中…</p>;
  }

  const last = status.state;
  // 走っている回。走り出したばかりで `state.json` がまだ前の回のままなら、取ってくる段にいる
  const live = status.running ? (last && !FINISHED.has(last.phase) ? last : null) : null;
  const liveMode: Mode = live?.mode ?? requestedMode ?? "wait";
  const liveStep: StepId | null = status.running ? (live ? stepOf(live.phase) : "fetch") : null;
  // 失敗・前の版に戻した・途中で止まった（host が「中断」と返す）回。「もう一度ためす」で閉じたものは出さない
  const failed =
    !status.running &&
    last !== null &&
    (status.interrupted !== null || last.phase === "failed" || last.phase === "rolled-back") &&
    last.id !== dismissedRunId
      ? last
      : null;
  const stale = status.staleRequest;
  const current = status.current;
  const latest = status.latest;
  const justUpdated = !status.running && last?.phase === "done" && last.to !== null && current?.commit === last.to;

  return (
    <div className="flex max-w-2xl flex-col gap-4 pb-16" data-testid="update-panel">
      {justUpdated && last?.to ? (
        <div
          data-testid="update-done"
          className="flex items-start gap-2.5 rounded-md border border-ok/30 bg-ok-soft px-3 py-2.5 text-ok"
        >
          <Check className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1 text-sm font-medium">
            版 <span className="font-mono">{short(last.to)}</span> になりました
          </p>
        </div>
      ) : null}

      {!status.running && last?.phase === "cancelled" && !failed ? (
        <p data-testid="update-cancelled" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
          更新をやめました。今の版のまま動いています。
        </p>
      ) : null}

      {stale ? (
        <div data-testid="update-stale-request" className="rounded-md border border-stop/30 bg-stop-soft px-3 py-2 text-sm text-stop">
          <p className="font-medium break-words">{stale.reason}</p>
          <p className="mt-0.5 text-xs">
            {[
              stale.requestedBy ? `${stale.requestedBy.label} が頼んだもの` : "頼んだもの",
              stale.requestedAt ? formatAt(stale.requestedAt) : null,
              stale.commit ? `版 ${short(stale.commit)}` : null,
            ]
              .filter(Boolean)
              .join("・")}
          </p>
        </div>
      ) : null}

      {actionError ? (
        <p data-testid="update-action-error" className="text-xs break-words text-stop">
          {actionError}
        </p>
      ) : null}
      {loadError ? (
        <p data-testid="update-poll-error" className="text-xs break-words text-stop">
          読み直せませんでした：{loadError}
        </p>
      ) : null}

      {!status.ready && !status.running ? (
        <NotReadyCard reasons={status.reasons} runbook={status.runbook} />
      ) : (
        <>
          {current ? <CurrentVersionCard commit={current} /> : null}

          {liveStep ? (
            <ProgressCard
              to={live?.to ?? latest?.commit ?? null}
              mode={liveMode}
              step={liveStep}
              waiting={live?.waiting}
              busy={busy}
              steppingUp={steppingUp}
              note={live?.note}
              onStop={() => void run("cancel", async () => {
                await cancelUpdate();
                await refresh();
              })}
              onSkipWait={pressSkipWait}
            />
          ) : failed ? (
            <FailedCard
              run={failed}
              interrupted={status.interrupted}
              currentCommit={current?.commit ?? null}
              onRetry={() => setDismissedRunId(failed.id)}
            />
          ) : latest && current && latest.commit !== current.commit && !latest.fastForward ? (
            <NotFastForwardCard checkedAt={latest.checkedAt} busy={busy} onCheck={() => void run("check", async () => setStatus(await checkForUpdate()))} />
          ) : latest && current && latest.commits.length > 0 ? (
            <NewVersionCard
              latest={latest}
              busy={busy}
              steppingUp={steppingUp}
              onWait={() => void run("wait", () => request(latest.commit, "wait"))}
              onNow={() => pressNow(latest.commit)}
              onCheck={() => void run("check", async () => setStatus(await checkForUpdate()))}
            />
          ) : (
            <UpToDateCard
              checkedAt={latest?.checkedAt ?? null}
              checking={busy === "check"}
              onCheck={() => void run("check", async () => setStatus(await checkForUpdate()))}
            />
          )}
        </>
      )}

      {liveStep === "restart" || reconnecting ? <ReconnectingOverlay /> : null}

      <CutOffDialog
        open={confirm !== null}
        reason={confirm?.reason ?? "now"}
        work={confirm?.work ?? []}
        continuing={confirm?.continuing ?? 0}
        onCancel={() => setConfirm(null)}
        onConfirm={confirmed}
      />
    </div>
  );
}

function Card({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId} className={cn("rounded-md border border-border bg-card p-3 sm:p-4", className)}>
      {children}
    </section>
  );
}

function CardLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-xs font-medium text-ink-3">{children}</h2>;
}

function CommitLine({ commit, strong }: { commit: UpdateCommit; strong?: boolean }) {
  return (
    <>
      <p className="text-sm break-words text-foreground">{commit.subject}</p>
      <p className="mt-0.5 text-xs text-ink-3">
        <span className={cn("font-mono", strong && "text-ink-2")}>{short(commit.commit)}</span>
        {" · "}
        {formatAt(commit.date)}
      </p>
    </>
  );
}

function CurrentVersionCard({ commit }: { commit: UpdateCommit }) {
  return (
    <Card testId="update-current">
      <CardLabel>今の版</CardLabel>
      <CommitLine commit={commit} strong />
    </Card>
  );
}

const COMMITS_SHOWN = 5;

function NewVersionCard({
  latest,
  busy,
  steppingUp,
  onWait,
  onNow,
  onCheck,
}: {
  latest: NonNullable<UpdateStatus["latest"]>;
  busy: Busy;
  steppingUp: boolean;
  onWait: () => void;
  onNow: () => void;
  /** GitHub の release を取り直して一覧を出し直す（この画面を開いたあとに入ったコミットも出す。ユーザー要望・2026-10-06） */
  onCheck: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const commits = showAll ? latest.commits : latest.commits.slice(0, COMMITS_SHOWN);
  const hidden = latest.commits.length - COMMITS_SHOWN;
  const requesting = busy === "wait" || busy === "now";

  return (
    <Card testId="update-available">
      <div className="mb-3 flex items-start gap-2">
        <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-accent-ink" />
        <div className="min-w-0">
          <p className="text-md font-semibold text-foreground">新しいコミットが {latest.commits.length} 件あります</p>
          <p className="text-xs text-ink-3">
            最新の版 <span className="font-mono">{short(latest.commit)}</span>（{formatAt(latest.date)}）と比べています
            {latest.checkedAt ? <span data-testid="update-checked-at">。確かめた時刻 {formatAt(latest.checkedAt)}</span> : null}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-10 shrink-0 text-ink-2 sm:size-8"
          disabled={busy !== null}
          onClick={onCheck}
          aria-label="もう一度確かめる"
          title="もう一度確かめる（GitHub の release を取り直す）"
          data-testid="update-recheck"
        >
          {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>

      <ol data-testid="update-commits" className="flex flex-col divide-y divide-border rounded-md border border-border">
        {commits.map((c) => (
          <li key={c.commit} className="px-3 py-2">
            <CommitLine commit={c} />
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-9 gap-1 px-2 text-xs text-ink-2 sm:h-7"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          data-testid="update-commits-more"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          {showAll ? "たたむ" : `ほか ${hidden} 件を見る`}
        </Button>
      ) : null}

      <div className="mt-4 border-t border-border pt-4">
        {steppingUp ? (
          <p data-testid="update-passkey" className="flex items-center gap-2 py-2 text-sm text-ink-2">
            <KeyRound className="size-4 shrink-0 text-accent-ink" />
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            パスキーを確かめています
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                size="lg"
                className="h-10 sm:h-9"
                disabled={busy !== null}
                onClick={onWait}
                data-testid="update-wait"
              >
                {busy === "wait" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                実行中の呼び出しを待って更新
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-10 sm:h-9"
                disabled={busy !== null}
                onClick={onNow}
                data-testid="update-now"
              >
                {busy === "now" ? <Loader2 className="size-4 animate-spin" /> : null}
                すぐ更新
              </Button>
            </div>
            <p className="mt-2 text-xs text-ink-3">
              {requesting
                ? "頼んでいます"
                : "組み立てが終わったら、実行中の呼び出しが終わるのを待って起こし直します。AI の会話とサブエージェントの仕事は、起き直したあと続きます。「すぐ更新」は待たないので、実行中の呼び出しは途中で切れます。押すとパスキーで本人を確かめます（少し前に確かめていれば省きます）。"}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function UpToDateCard({
  checkedAt,
  checking,
  onCheck,
}: {
  checkedAt: string | null;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <Card testId="update-latest" className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {checkedAt ? <Check className="mt-0.5 size-4 shrink-0 text-ok" /> : <RefreshCw className="mt-0.5 size-4 shrink-0 text-ink-3" />}
        <div className="min-w-0">
          <p className="text-md font-semibold text-foreground">{checkedAt ? "最新です" : "まだ確かめていません"}</p>
          <p className="text-xs text-ink-3" data-testid="update-checked-at">
            {checkedAt ? `最後に確かめた時刻 ${formatAt(checkedAt)}` : "GitHub の release をまだ取ってきていません"}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-10 sm:h-8"
        disabled={checking}
        onClick={onCheck}
        data-testid="update-check"
      >
        {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        {checking ? "確かめています" : "確かめる"}
      </Button>
    </Card>
  );
}

/** release が書き換えられて、今の版から早送りで辿れない——host は更新しないので、押せるものを出さない */
function NotFastForwardCard({ checkedAt, busy, onCheck }: { checkedAt: string | null; busy: Busy; onCheck: () => void }) {
  return (
    <Card testId="update-not-fast-forward" className="flex flex-col gap-3">
      <div className="flex items-start gap-2 text-warn">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">release が今の版から早送りで辿れません（書き換えられています）</p>
          <p className="text-xs">更新しません。今の版のまま動いています。{checkedAt ? `最後に確かめた時刻 ${formatAt(checkedAt)}` : ""}</p>
        </div>
      </div>
      <Button type="button" variant="outline" size="lg" className="h-10 self-start sm:h-8" disabled={busy !== null} onClick={onCheck}>
        {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        確かめる
      </Button>
    </Card>
  );
}

/** 準備が済んでいない——理由と手順書だけ。押しても断られるので、ボタンは出さない */
function NotReadyCard({ reasons, runbook }: { reasons: string[]; runbook: string }) {
  return (
    <Card testId="update-not-ready">
      <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2.5 text-warn">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <p className="min-w-0 text-sm font-semibold">この banto は、まだ画面から更新できる形で動いていません</p>
      </div>
      <ul data-testid="update-not-ready-reasons" className="flex list-disc flex-col gap-1 pl-5 text-sm break-words text-ink-2">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-3">
        host で手順書 <code className="font-mono text-ink-2">{runbook}</code> のとおりに整えると（1回だけ）、ここから更新できるようになります。
      </p>
    </Card>
  );
}

const STEP_LABEL: Record<StepId, string> = {
  fetch: "取ってくる",
  build: "組み立てる",
  wait: "呼び出しが終わるのを待つ",
  restart: "起こし直す",
};

const STEP_HINT: Record<StepId, string> = {
  fetch: "GitHub から新しい版を取ってきます",
  build: "数分かかります",
  wait: "途中で切れる呼び出しが終わるまで待ちます",
  restart: "画面が一度切れます",
};

type StepStatus = "done" | "current" | "pending" | "skipped" | "failed";

function StepList({
  statuses,
  hints,
  renderDetail,
}: {
  statuses: Record<StepId, StepStatus>;
  hints?: Partial<Record<StepId, string>>;
  renderDetail?: (step: StepId) => ReactNode;
}) {
  return (
    <ol data-testid="update-steps" className="flex flex-col">
      {STEPS.map((step, i) => {
        const status = statuses[step];
        const last = i === STEPS.length - 1;
        return (
          <li key={step} data-step={step} data-status={status} className="flex gap-3">
            <div className="flex flex-col items-center">
              <StepIcon status={status} />
              {last ? null : <div className="my-1 w-px flex-1 bg-border" />}
            </div>
            <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-4")}>
              <p
                className={cn(
                  "text-sm",
                  status === "current" && "font-semibold text-foreground",
                  status === "failed" && "font-semibold text-stop",
                  status === "done" && "text-ink-2",
                  (status === "pending" || status === "skipped") && "text-ink-3",
                )}
              >
                {STEP_LABEL[step]}
                {status === "current" ? <span className="sr-only">（いまここ）</span> : null}
              </p>
              <p className="text-xs text-ink-3">{hints?.[step] ?? STEP_HINT[step]}</p>
              {renderDetail?.(step)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  const base = "flex size-6 shrink-0 items-center justify-center rounded-full border";
  if (status === "done")
    return (
      <span className={cn(base, "border-ok/40 bg-ok-soft text-ok")}>
        <Check className="size-3.5" />
      </span>
    );
  if (status === "current")
    return (
      <span className={cn(base, "border-accent-ink/40 bg-accent-soft text-accent-ink")}>
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    );
  if (status === "failed")
    return (
      <span className={cn(base, "border-stop/40 bg-stop-soft text-stop")}>
        <X className="size-3.5" />
      </span>
    );
  if (status === "skipped")
    return (
      <span className={cn(base, "border-border text-ink-3")}>
        <Minus className="size-3.5" />
      </span>
    );
  return <span className={cn(base, "border-border")} />;
}

function statusesFor(step: StepId, mode: Mode, failed = false): Record<StepId, StepStatus> {
  const at = STEPS.indexOf(step);
  const out = {} as Record<StepId, StepStatus>;
  STEPS.forEach((s, i) => {
    out[s] = i < at ? "done" : i === at ? (failed ? "failed" : "current") : "pending";
  });
  if (mode === "now" && out.wait !== "failed") out.wait = "skipped";
  return out;
}

function WorkList({ work }: { work: readonly WorkRow[] }) {
  return (
    <ul data-testid="update-running" className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
      {work.map((w) => (
        <li key={w.key} className="flex flex-col gap-0.5 px-3 py-2">
          <p className="text-sm break-words text-foreground">{w.title}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
            {w.projectName ? (
              <>
                <span>{w.projectName}</span>
                <span>·</span>
              </>
            ) : null}
            {w.since ? (
              <>
                <span>{sinceText(w.since)}</span>
                <span>·</span>
              </>
            ) : null}
            {w.reason ? (
              <span>{w.reason}</span>
            ) : w.status === "human" ? (
              <span className="rounded-sm bg-turn-soft px-1.5 text-turn">人の返事待ち</span>
            ) : w.status === "reply" ? (
              <span>{w.module} の仕事の返事を待っています</span>
            ) : w.status === "call" ? (
              <span>{w.module} を呼んでいます</span>
            ) : (
              <span>AI が動いています</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** 起き直したあと続くもの（待たないもの）の数。無ければ出さない */
function ContinuingLine({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p data-testid="update-continuing" className="text-xs text-ink-2">
      起き直したあと続くもの {count} 件（会話・サブエージェントなど）
    </p>
  );
}

function ProgressCard({
  to,
  mode,
  step,
  waiting,
  busy,
  steppingUp,
  note,
  onStop,
  onSkipWait,
}: {
  to: string | null;
  mode: Mode;
  step: StepId;
  waiting: UpdateWaiting | undefined;
  busy: Busy;
  steppingUp: boolean;
  /** いま止まっている理由（`update.mjs` が書く。例「host が答えません…答えるまで待ちます」） */
  note: string | undefined;
  onStop: () => void;
  onSkipWait: () => void;
}) {
  const remaining = workRows(waiting?.blocking ?? []);
  const noteLine = note ? (
    <p data-testid="update-note" className="mt-2 flex items-start gap-1.5 text-xs break-words text-warn">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      {note}
    </p>
  ) : null;
  return (
    <Card testId="update-progress">
      <CardLabel>{to ? <>版 <span className="font-mono">{short(to)}</span> に更新しています</> : "新しい版に更新しています"}</CardLabel>
      <StepList
        statuses={statusesFor(step, mode)}
        hints={mode === "now" ? { wait: "待ちません（すぐ更新）" } : undefined}
        renderDetail={(s) => {
          if (s !== step) return null;
          // 取ってくる・組み立てるの間もやめられる（update.mjs は取ってくる・組み立てる・待つの間に、やめる印を受ける）
          const stopButton = (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="mt-2 h-10 sm:h-8"
              disabled={busy !== null}
              onClick={onStop}
              data-testid="update-stop"
            >
              {busy === "cancel" ? <Loader2 className="size-4 animate-spin" /> : null}
              更新をやめる
            </Button>
          );
          if (s === "fetch")
            return (
              <>
                {noteLine}
                {stopButton}
              </>
            );
          if (s === "build")
            return (
              <>
                <p className="mt-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">今の banto はそのまま使えます。</p>
                {noteLine}
                {stopButton}
              </>
            );
          if (s === "restart") return noteLine;
          if (s === "wait")
            return (
              <div className="mt-2 flex flex-col gap-2">
                {noteLine}
                {remaining.length > 0 ? (
                  <>
                    <p className="text-xs text-ink-2" data-testid="update-remaining">
                      あと {remaining.length} 件
                    </p>
                    <WorkList work={remaining} />
                  </>
                ) : (
                  <p className="text-xs text-ink-2">途中で切れる呼び出しはありません</p>
                )}
                <ContinuingLine count={waiting?.continuing ?? 0} />
                {steppingUp ? (
                  <p data-testid="update-passkey" className="flex items-center gap-2 py-1 text-sm text-ink-2">
                    <KeyRound className="size-4 shrink-0 text-accent-ink" />
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                    パスキーを確かめています
                  </p>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-10 sm:h-8"
                    disabled={busy !== null}
                    onClick={onSkipWait}
                    data-testid="update-skip-wait"
                  >
                    {busy === "force" ? <Loader2 className="size-4 animate-spin" /> : null}
                    待たずにすぐ起こし直す
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    className="h-10 sm:h-8"
                    disabled={busy !== null}
                    onClick={onStop}
                    data-testid="update-stop-waiting"
                  >
                    {busy === "cancel" ? <Loader2 className="size-4 animate-spin" /> : null}
                    待つのをやめる
                  </Button>
                </div>
              </div>
            );
          return null;
        }}
      />
    </Card>
  );
}

function FailedCard({
  run,
  interrupted,
  currentCommit,
  onRetry,
}: {
  run: UpdateRunState;
  /** host が「途中で止まった」と返した回（段と理由） */
  interrupted: UpdateStatus["interrupted"];
  currentCommit: string | null;
  onRetry: () => void;
}) {
  const [log, setLog] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // 始める前に断った回（頼みが読めない・設定が無い等）は、どの段でもない
  const beforeStart = !interrupted && run.phase === "failed" && run.failedPhase === undefined;
  const step = stepOf(interrupted ? interrupted.phase : (run.failedPhase ?? run.phase));
  const title = interrupted
    ? "更新が途中で止まりました"
    : beforeStart
      ? "更新を始められませんでした"
      : `「${STEP_LABEL[step]}」で止まりました`;
  const summary =
    run.phase === "rolled-back"
      ? "新しい版が起きなかったので、前の版に戻しました。"
      : step === "restart"
        ? `今動いているのは版 ${currentCommit ? short(currentCommit) : "（不明）"} です。`
        : "今の版のまま動いています。";

  function toggleLog() {
    if (logOpen) {
      setLogOpen(false);
      return;
    }
    setLogOpen(true);
    fetchUpdateLog()
      .then((l) => setLog(l))
      .catch((err: unknown) => setLog({ error: describeFailure(err) }));
  }

  return (
    <Card testId="update-failed">
      <div className="mb-3 flex items-start gap-2 rounded-md border border-stop/30 bg-stop-soft px-3 py-2.5 text-stop">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold" data-testid="update-failed-title">
            {title}
          </p>
          <p className="text-sm">{summary}</p>
          {interrupted ? (
            <p className="mt-1 text-xs break-words" data-testid="update-interrupted-reason">
              {interrupted.reason}
            </p>
          ) : null}
          {run.error ? (
            <p className="mt-1 text-xs break-words" data-testid="update-failed-error">
              {run.error}
            </p>
          ) : null}
          {run.note ? (
            <p className="mt-1 text-xs break-words" data-testid="update-failed-note">
              止まる前：{run.note}
            </p>
          ) : null}
        </div>
      </div>

      {beforeStart ? null : <StepList statuses={statusesFor(step, run.mode ?? "wait", true)} />}

      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10 sm:h-8"
          aria-expanded={logOpen}
          onClick={toggleLog}
          data-testid="update-log-toggle"
        >
          <ScrollText className="size-4" />
          {logOpen ? "ログを閉じる" : "ログを開く"}
        </Button>
        <Button type="button" variant="ghost" size="lg" className="h-10 sm:h-8" onClick={onRetry} data-testid="update-retry">
          もう一度ためす
        </Button>
      </div>
      {logOpen ? (
        <pre
          data-testid="update-log"
          className="mt-3 max-h-96 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-ink-2"
        >
          {log === null
            ? "読み込み中…"
            : "error" in log
              ? `ログを読めませんでした：${log.error}`
              : `${log.truncated ? "（前のほうは省いています）\n" : ""}${log.text}`}
        </pre>
      ) : null}
    </Card>
  );
}

/**
 * 起こし直し中——繋がりが一度切れるので、画面全体に「繋がり直すのを待っている」を出す。body に出す
 * （設定の枠の中に置くと、左の Project の列が覆われずに押せてしまう）
 */
function ReconnectingOverlay() {
  return createPortal(
    <div
      data-testid="update-reconnecting"
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center shadow-3">
        <WifiOff className="size-6 text-ink-3" />
        <p className="text-md font-semibold text-foreground">起こし直しています</p>
        <p className="text-sm text-ink-2">画面が一度切れます。新しい版が起きたら、自動でこの画面に戻ります。</p>
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <Loader2 className="size-3.5 animate-spin" />
          繋がり直すのを待っています
        </p>
      </div>
    </div>,
    document.body,
  );
}

function CutOffDialog({
  open,
  reason,
  work,
  continuing,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  reason: "now" | "skip-wait";
  work: readonly WorkRow[];
  /** 起き直したあと続くもの（待たないもの）の数 */
  continuing: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())}>
      <DialogContent data-testid="update-cutoff-dialog" className="max-h-dvh overflow-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{reason === "now" ? "すぐ更新しますか？" : "待たずに起こし直しますか？"}</DialogTitle>
          <DialogDescription>
            {reason === "now"
              ? `組み立てが終わったら、待たずに起こし直します。いま途中で切れる呼び出しが ${work.length} 件あります。`
              : `いま途中で切れる呼び出しが ${work.length} 件あります。`}
          </DialogDescription>
        </DialogHeader>
        <WorkList work={work} />
        <p className="flex items-start gap-1.5 text-sm font-medium text-warn">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          これらは途中で切れ、結果が分からなくなります。
        </p>
        <ContinuingLine count={continuing} />
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" size="lg" className="h-10 sm:h-8" onClick={onCancel}>
            やめる
          </Button>
          <Button type="button" size="lg" className="h-10 sm:h-8" onClick={onConfirm} data-testid="update-cutoff-confirm">
            {reason === "now" ? "切れてもよいので更新" : "切れてもよいので起こし直す"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
