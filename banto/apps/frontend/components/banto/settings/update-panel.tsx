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
// - **前の版に戻す**（追加・2026-10-19、アーキ仕様 §2.5「前の版に戻す」・v4-frontend.md §6.34）：節の下に、この機械で動いた版の
//   一覧（`rollbackTargets`）。「戻す」で確かめの小窓（抜ける・入るコミット・データの注意・自動で戻る安全網・この画面を持たない
//   版の注意）。ボタンは更新と同じ2つ、パスキーは最後。進み具合・結果は更新と同じ面で、文だけ「戻す」
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
  ExternalLink,
  History,
  KeyRound,
  PackageCheck,
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
  fetchRollbackPreview,
  fetchUpdateLog,
  fetchUpdateStatus,
  forceUpdateNow,
  requestRollback,
  requestUpdate,
  type ActivityItem,
  type RollbackPreview,
  type RollbackTarget,
  type UpdateActivity,
  type UpdateCommit,
  type UpdatePhase,
  type PrebuiltAvailability,
  type UpdateRunState,
  type UpdateStatus,
  type UpdateWaiting,
} from "@/lib/backend/self-update";
import { cn } from "@/lib/utils";

/** 走っている間に読み直す間隔 */
const POLL_MS = 3000;

type Mode = "wait" | "now";
/** 更新か、前の版に戻すか（`state.json` の `kind`。無ければ更新） */
type Kind = "update" | "rollback";
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

type Busy = "check" | "wait" | "now" | "cancel" | "force" | "rollback-wait" | "rollback-now" | null;

export function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 走っている間に繋がらなくなった（起こし直しで host が居ない）
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [steppingUp, setSteppingUp] = useState(false);
  const [confirm, setConfirm] = useState<{ reason: "now" | "skip-wait"; work: WorkRow[]; continuing: number } | null>(null);
  // この画面で頼んだもの（`state.json` が書かれるまでの間、進み具合の段の出し方・題に使う）
  const [requested, setRequested] = useState<{ mode: Mode; kind: Kind; commit: string } | null>(null);
  // 「戻す」を押した版（確かめの小窓）と、「すぐ戻す」で途中で切れるもの
  const [rollbackTarget, setRollbackTarget] = useState<RollbackTarget | null>(null);
  const [rollbackCutOff, setRollbackCutOff] = useState<{ work: WorkRow[]; continuing: number } | null>(null);
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
    setRequested({ mode, kind: "update", commit });
    await refresh();
  }

  function openRollback(target: RollbackTarget) {
    setActionError(null);
    setRollbackCutOff(null);
    setRollbackTarget(target);
  }

  function closeRollback() {
    setRollbackTarget(null);
    setRollbackCutOff(null);
  }

  /**
   * 前の版に戻す。すぐ戻すなら、途中で切れる呼び出しがあれば先に小窓に並べて確かめる（2度目の押下で頼む）。
   * パスキーは最後（host が求めたときだけ）
   */
  function pressRollback(commit: string, mode: Mode) {
    void run(mode === "wait" ? "rollback-wait" : "rollback-now", async () => {
      if (mode === "now" && rollbackCutOff === null) {
        const cutOff = cutOffOf(await fetchActivity());
        if (cutOff.work.length > 0) {
          setRollbackCutOff(cutOff);
          return;
        }
      }
      await withPasskey(() => requestRollback(commit, mode), () => setSteppingUp(true));
      setRequested({ mode, kind: "rollback", commit });
      closeRollback();
      await refresh();
    });
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
  const liveMode: Mode = live?.mode ?? requested?.mode ?? "wait";
  // `kind` を書かない前の版の `update.mjs` の回は更新
  const liveKind: Kind = live ? (live.kind ?? "update") : (requested?.kind ?? "update");
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
  const lastKind: Kind = last?.kind ?? "update";
  const rollbackTargets = status.rollbackTargets ?? [];

  return (
    <div className="flex max-w-2xl flex-col gap-4 pb-16" data-testid="update-panel">
      {justUpdated && last?.to ? (
        <div
          data-testid="update-done"
          className="flex items-start gap-2.5 rounded-md border border-ok/30 bg-ok-soft px-3 py-2.5 text-ok"
        >
          <Check className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1 text-sm font-medium">
            版 <span className="font-mono">{short(last.to)}</span> {lastKind === "rollback" ? "に戻しました" : "になりました"}
          </p>
        </div>
      ) : null}

      {!status.running && last?.phase === "cancelled" && !failed ? (
        <p data-testid="update-cancelled" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
          {lastKind === "rollback" ? "戻すのをやめました。" : "更新をやめました。"}今の版のまま動いています。
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
              to={live?.to ?? requested?.commit ?? latest?.commit ?? null}
              kind={liveKind}
              mode={liveMode}
              step={liveStep}
              waiting={live?.waiting}
              busy={busy}
              steppingUp={steppingUp}
              note={live?.note}
              prebuilt={live?.prebuilt}
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
              kind={lastKind}
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

          {current && rollbackTargets.length > 0 ? (
            <RollbackSection
              targets={rollbackTargets}
              disabled={status.running || busy !== null}
              running={status.running}
              onOpen={openRollback}
            />
          ) : null}
        </>
      )}

      {liveStep === "restart" || reconnecting ? <ReconnectingOverlay kind={liveKind} /> : null}

      {rollbackTarget && current ? (
        <RollbackDialog
          target={rollbackTarget}
          current={current}
          busy={busy}
          steppingUp={steppingUp}
          error={actionError}
          cutOff={rollbackCutOff}
          onCancel={closeRollback}
          onWait={() => pressRollback(rollbackTarget.commit, "wait")}
          onNow={() => pressRollback(rollbackTarget.commit, "now")}
        />
      ) : null}

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

      <PrebuiltLine prebuilt={latest.prebuilt} />

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

/** 戻すときの段の説明（この機械にある版は取ってこず、組み立てない） */
const ROLLBACK_HINT: Partial<Record<StepId, string>> = {
  fetch: "この機械にあればそのまま使い、無ければ GitHub から取ってきます",
  build: "この機械にあれば組み立てません",
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
  kind,
  mode,
  step,
  waiting,
  busy,
  steppingUp,
  note,
  prebuilt,
  onStop,
  onSkipWait,
}: {
  to: string | null;
  kind: Kind;
  mode: Mode;
  step: StepId;
  waiting: UpdateWaiting | undefined;
  busy: Busy;
  steppingUp: boolean;
  /** いま止まっている理由（`update.mjs` が書く。例「host が答えません…答えるまで待ちます」） */
  note: string | undefined;
  /** 組み立て済みを使っているか（`update.mjs` が書く） */
  prebuilt: UpdateRunState["prebuilt"];
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
      <CardLabel>
        {kind === "rollback" ? (
          to ? (
            <>
              版 <span className="font-mono">{short(to)}</span> に戻しています
            </>
          ) : (
            "前の版に戻しています"
          )
        ) : to ? (
          <>
            版 <span className="font-mono">{short(to)}</span> に更新しています
          </>
        ) : (
          "新しい版に更新しています"
        )}
      </CardLabel>
      <StepList
        statuses={statusesFor(step, mode)}
        hints={{
          // 戻すときも、機械に無い版は組み立て済みを取ってくることがある——その様子（buildHint）を戻すときの説明より優先する
          ...(kind === "rollback" ? ROLLBACK_HINT : {}),
          ...(mode === "now" ? { wait: kind === "rollback" ? "待ちません（すぐ戻す）" : "待ちません（すぐ更新）" } : {}),
          ...buildHint(prebuilt),
        }}
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
              {kind === "rollback" ? "戻すのをやめる" : "更新をやめる"}
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
  kind,
  onRetry,
}: {
  run: UpdateRunState;
  /** host が「途中で止まった」と返した回（段と理由） */
  interrupted: UpdateStatus["interrupted"];
  currentCommit: string | null;
  kind: Kind;
  onRetry: () => void;
}) {
  const [log, setLog] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // 始める前に断った回（頼みが読めない・設定が無い等）は、どの段でもない
  const beforeStart = !interrupted && run.phase === "failed" && run.failedPhase === undefined;
  const step = stepOf(interrupted ? interrupted.phase : (run.failedPhase ?? run.phase));
  const what = kind === "rollback" ? "戻すの" : "更新";
  const title = interrupted
    ? `${what}が途中で止まりました`
    : beforeStart
      ? `${what}を始められませんでした`
      : `「${STEP_LABEL[step]}」で止まりました`;
  const summary =
    run.phase === "rolled-back"
      ? kind === "rollback"
        ? "戻した版が起きなかったので、元の版に戻しました。"
        : "新しい版が起きなかったので、前の版に戻しました。"
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
function ReconnectingOverlay({ kind }: { kind: Kind }) {
  return createPortal(
    <div
      data-testid="update-reconnecting"
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center shadow-3">
        <WifiOff className="size-6 text-ink-3" />
        <p className="text-md font-semibold text-foreground">起こし直しています</p>
        <p className="text-sm text-ink-2">画面が一度切れます。{kind === "rollback" ? "戻した版" : "新しい版"}が起きたら、自動でこの画面に戻ります。</p>
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

/**
 * **組み立て済みの有無**（追加・2026-10-15、v4-frontend.md §6.34「組み立て済みの有無」）。新しいコミットの一覧の下に1行。
 * テストが落ちていても押せる（その場で組み立てる）——注意の色で出すだけ
 */
function PrebuiltLine({ prebuilt }: { prebuilt: PrebuiltAvailability | undefined }) {
  if (!prebuilt || prebuilt.status === "unknown") {
    return (
      <p data-testid="update-prebuilt" data-status="unknown" className="mt-3 flex items-start gap-1.5 text-xs text-ink-3">
        <PackageCheck className="mt-0.5 size-3.5 shrink-0" />
        組み立て済みの版があれば使い、無ければこの機械で組み立てます{prebuilt?.detail ? `（${prebuilt.detail}）` : ""}
      </p>
    );
  }
  const runLink = prebuilt.run ? (
    <a
      href={prebuilt.run}
      target="_blank"
      rel="noreferrer noopener"
      className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2"
      data-testid="update-prebuilt-run"
    >
      GitHub で見る
      <ExternalLink className="size-3" />
    </a>
  ) : null;
  if (prebuilt.status === "available") {
    return (
      <p data-testid="update-prebuilt" data-status="available" className="mt-3 flex items-start gap-1.5 text-xs text-ok">
        <PackageCheck className="mt-0.5 size-3.5 shrink-0" />
        組み立て済みの版を使います（この機械では組み立てません）
      </p>
    );
  }
  if (prebuilt.status === "building") {
    return (
      <p data-testid="update-prebuilt" data-status="building" className="mt-3 flex items-start gap-1.5 text-xs text-ink-2">
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
        <span>
          GitHub で組み立て中です。更新すると組み上がるのを待ちます（最長 20 分）{runLink}
        </span>
      </p>
    );
  }
  if (prebuilt.status === "tests-failed") {
    return (
      <p
        data-testid="update-prebuilt"
        data-status="tests-failed"
        className="mt-3 flex items-start gap-1.5 rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn"
      >
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          GitHub でのテストが落ちています。更新できますが、この機械で組み立てます（数分かかり、その間少し重くなります）{runLink}
        </span>
      </p>
    );
  }
  if (prebuilt.status === "cancelled") {
    return (
      <p data-testid="update-prebuilt" data-status="cancelled" className="mt-3 flex items-start gap-1.5 text-xs text-ink-2">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          GitHub での組み立てが途中で止まりました。この機械で組み立てます（数分かかり、その間少し重くなります）{runLink}
        </span>
      </p>
    );
  }
  return (
    <p data-testid="update-prebuilt" data-status="none" className="mt-3 flex items-start gap-1.5 text-xs text-ink-2">
      <PackageCheck className="mt-0.5 size-3.5 shrink-0" />
      この版の組み立て済みはありません。この機械で組み立てます（数分かかり、その間少し重くなります）
      {prebuilt.detail ? `（${prebuilt.detail}）` : ""}
    </p>
  );
}

/** 「組み立てる」の段の説明——組み立て済みを使う間はそう言う（`update.mjs` の `state.prebuilt`） */
function buildHint(prebuilt: UpdateRunState["prebuilt"]): Partial<Record<StepId, string>> {
  switch (prebuilt?.status) {
    case "checking":
      return { build: "組み立て済みの版を探しています" };
    case "waiting":
      return { build: "GitHub で組み立て中の版を待っています" };
    case "downloading":
    case "used":
      return { build: "組み立て済みの版を取ってきます" };
    case "skipped":
      return { build: "この機械で組み立てます（数分かかります）" };
    default:
      return {};
  }
}

/**
 * **前の版に戻す**の一覧（この機械で動いた版、今の版を除いた新しい 10 件）。空なら出さない（呼ぶ側）。
 * 走っている更新があれば押せない
 */
function RollbackSection({
  targets,
  disabled,
  running,
  onOpen,
}: {
  targets: readonly RollbackTarget[];
  disabled: boolean;
  running: boolean;
  onOpen: (target: RollbackTarget) => void;
}) {
  return (
    <section data-testid="rollback-section" className="flex flex-col gap-2 pt-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <History className="size-4 text-ink-3" />
        前の版に戻す
      </h2>
      <p className="text-xs text-ink-3">
        この機械で動いた版です。{running ? "走っている更新が終わるまで戻せません。" : null}
      </p>
      <ol data-testid="rollback-targets" className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
        {targets.map((t) => (
          <li
            key={t.commit}
            data-testid="rollback-target"
            data-commit={t.commit}
            className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm break-words text-foreground">{t.subject ?? "（題が分かりません）"}</p>
              <p className="mt-0.5 text-xs text-ink-3">
                <span className="font-mono text-ink-2">{short(t.commit)}</span>
                {t.lastStartedAt ? <span data-testid="rollback-target-started"> · 最後に起きた日時 {formatAt(t.lastStartedAt)}</span> : null}
              </p>
              <p data-testid="rollback-target-where" className="mt-0.5 text-xs text-ink-3">
                {t.local
                  ? "この機械にあります（すぐ戻せます）"
                  : "GitHub から取ってくるか、この機械で組み立てます（GitHub に届くこと。組み立て済みが無ければ数分かかります）"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-10 self-start sm:h-8 sm:self-center"
              disabled={disabled}
              onClick={() => onOpen(t)}
              data-testid="rollback-open"
            >
              戻す
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CommitList({ commits, testId }: { commits: readonly UpdateCommit[]; testId: string }) {
  return (
    <ol data-testid={testId} className="flex max-h-60 flex-col divide-y divide-border overflow-auto rounded-md border border-border">
      {commits.map((c) => (
        <li key={c.commit} className="px-3 py-2">
          <CommitLine commit={c} />
        </li>
      ))}
    </ol>
  );
}

/**
 * **戻す前の確かめの小窓**：抜ける（祖先でなければ入るも）コミット・データの注意・自動で戻る安全網・この画面を持たない版の
 * 注意。ボタンは更新と同じ2つ。「すぐ戻す」で途中で切れる呼び出しがあれば、それを並べてもう一度押させる。パスキーは最後
 */
function RollbackDialog({
  target,
  current,
  busy,
  steppingUp,
  error,
  cutOff,
  onCancel,
  onWait,
  onNow,
}: {
  target: RollbackTarget;
  current: UpdateCommit;
  busy: Busy;
  steppingUp: boolean;
  error: string | null;
  cutOff: { work: WorkRow[]; continuing: number } | null;
  onCancel: () => void;
  onWait: () => void;
  onNow: () => void;
}) {
  // 読んだ答えは、どの版について読んだかと一緒に持つ——戻す先が替わったら、前の版の答えは出さず「読んでいます」に戻る
  const [read, setRead] = useState<{ commit: string; preview: RollbackPreview | { error: string } } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const commit = target.commit;
    fetchRollbackPreview(commit)
      .then((p) => !cancelled && setRead({ commit, preview: p }))
      .catch((err: unknown) => !cancelled && setRead({ commit, preview: { error: describeFailure(err) } }));
    return () => {
      cancelled = true;
    };
  }, [target.commit]);
  const preview = read?.commit === target.commit ? read.preview : null;
  const requesting = busy === "rollback-wait" || busy === "rollback-now";
  const loaded = preview !== null && !("error" in preview) ? preview : null;
  // 祖先かどうかは host の小窓の答えを優先する（一覧を読んだあとに変わっていることがある）
  const ancestor = loaded?.ancestor ?? target.ancestor;

  return (
    <Dialog open onOpenChange={(o) => (o || requesting ? undefined : onCancel())}>
      <DialogContent data-testid="rollback-dialog" className="max-h-dvh overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            版 <span className="font-mono">{short(target.commit)}</span> に戻しますか？
          </DialogTitle>
          <DialogDescription>
            {target.subject ?? "（題が分かりません）"}。今の版 <span className="font-mono">{short(current.commit)}</span> から戻します。
          </DialogDescription>
        </DialogHeader>

        {preview === null ? (
          <p className="text-xs text-ink-3">抜けるコミットを読んでいます…</p>
        ) : "error" in preview ? (
          <p data-testid="rollback-preview-error" className="text-xs break-words text-stop">
            抜けるコミットを読めませんでした：{preview.error}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {!ancestor ? (
              <p data-testid="rollback-not-ancestor" className="flex items-start gap-1.5 text-sm font-medium text-warn">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                この版は今の版の祖先ではありません。戻すと、抜けるものと入るものの両方があります。
              </p>
            ) : null}
            {preview.leaving === null ? (
              <p data-testid="rollback-leaving-unknown" className="text-xs text-ink-2">
                この機械に版の中身が無いので、抜けるコミットはまだ分かりません（戻すときに GitHub から取ってきます）。
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p data-testid="rollback-leaving-count" className="text-xs font-medium text-ink-2">
                  戻すと抜けるコミット {preview.leaving.length} 件
                </p>
                {preview.leaving.length > 0 ? <CommitList commits={preview.leaving} testId="rollback-leaving" /> : null}
              </div>
            )}
            {!ancestor && preview.entering !== null && preview.entering.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <p data-testid="rollback-entering-count" className="text-xs font-medium text-ink-2">
                  戻すと入るコミット {preview.entering.length} 件
                </p>
                <CommitList commits={preview.entering} testId="rollback-entering" />
              </div>
            ) : null}
          </div>
        )}

        <ul data-testid="rollback-notes" className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-2">
          <li>データは戻りません。新しい版で書いたものは古い版では効かないことがあります。</li>
          <li>戻した版が起きなければ、自動で今の版に戻ります。</li>
          <li>戻す版は、この画面（前の版に戻す）を持たないかもしれません。そのときにもう一度戻すには、先に最新へ更新してください。</li>
        </ul>

        {cutOff ? (
          <div data-testid="rollback-cutoff" className="flex flex-col gap-2">
            <p className="text-xs text-ink-2">いま途中で切れる呼び出しが {cutOff.work.length} 件あります。</p>
            <WorkList work={cutOff.work} />
            <p className="flex items-start gap-1.5 text-sm font-medium text-warn">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              「すぐ戻す」と、これらは途中で切れ、結果が分からなくなります。
            </p>
            <ContinuingLine count={cutOff.continuing} />
          </div>
        ) : null}

        {error ? (
          <p data-testid="rollback-error" className="text-xs break-words text-stop">
            {error}
          </p>
        ) : null}

        {steppingUp ? (
          <p data-testid="update-passkey" className="flex items-center gap-2 py-1 text-sm text-ink-2">
            <KeyRound className="size-4 shrink-0 text-accent-ink" />
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            パスキーを確かめています
          </p>
        ) : (
          <p className="text-xs text-ink-3">
            {requesting
              ? "頼んでいます"
              : "「呼び出しを待って戻す」は、実行中の呼び出しが終わるのを待って起こし直します。「すぐ戻す」は待たないので、実行中の呼び出しは途中で切れます。押すとパスキーで本人を確かめます（少し前に確かめていれば省きます）。"}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" size="lg" className="h-10 sm:h-8" disabled={requesting} onClick={onCancel}>
            やめる
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-10 sm:h-8"
            disabled={busy !== null}
            onClick={onNow}
            data-testid="rollback-now"
          >
            {busy === "rollback-now" ? <Loader2 className="size-4 animate-spin" /> : null}
            {cutOff ? "切れてもよいので戻す" : "すぐ戻す"}
          </Button>
          <Button type="button" size="lg" className="h-10 sm:h-8" disabled={busy !== null} onClick={onWait} data-testid="rollback-wait">
            {busy === "rollback-wait" ? <Loader2 className="size-4 animate-spin" /> : null}
            呼び出しを待って戻す
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
