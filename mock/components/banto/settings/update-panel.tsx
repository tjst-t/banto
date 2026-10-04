"use client";

// 設定の「更新」——banto 自身を GitHub の release の最新にする（モック・2026-10-04）。
//
// - 今の版と、最新の release までに入る新しいコミットの一覧。**押す前に何が入るかを読ませる**のが目的
// - 「AI が止まるまで待って更新」（主）と「すぐ更新」（副）。どちらも押すとその場でパスキーを通す
// - 「すぐ更新」は、今動いている会話を出して「途中で切れます」と伝えてから確かめる（動いていなければ確かめない）
// - 進み具合：取ってくる → 組み立てる → AI が止まるのを待つ → 起こし直す
// - 起こし直し中は画面が一度切れる。終わったら帯、失敗したらどの段か・今どの版で動いているか・ログ
//
// 本物の通信はしない。状態は `?update-demo=<状態>`（と `&running=0`）で開ける——画面の隅の
// デモ用の切り替え（`UpdateDemoSwitcher`）がこの URL を書き換える。ボタンを押したときは、タイマーで段を進める
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  CircleAlert,
  FlaskConical,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  mockBuildFailureLog,
  mockCurrentVersion,
  mockLastCheckedAt,
  mockLatestRelease,
  mockNewCommits,
  mockRestartFailureLog,
  mockRunningWork,
  type MockCommit,
  type MockRunningWork,
} from "@/lib/mock/self-update";
import { cn } from "@/lib/utils";

type Mode = "wait" | "now";
type StepId = "fetch" | "build" | "wait" | "restart";
const STEPS: readonly StepId[] = ["fetch", "build", "wait", "restart"];

type Phase =
  | { kind: "available" }
  | { kind: "latest"; checking: boolean }
  | { kind: "passkey"; mode: Mode }
  | { kind: "progress"; mode: Mode; step: StepId }
  | { kind: "done" }
  | { kind: "failed"; step: "build" | "restart" };

/** デモ用の切り替えに並べる状態（URL の `update-demo`） */
const DEMO_STATES = [
  { id: "available", label: "新しい版がある" },
  { id: "latest", label: "最新です" },
  { id: "passkey", label: "パスキーを確かめている" },
  { id: "confirm", label: "すぐ更新の確かめ" },
  { id: "fetching", label: "取ってくる" },
  { id: "building", label: "組み立てる" },
  { id: "waiting", label: "AI が止まるのを待つ" },
  { id: "restarting", label: "起こし直す" },
  { id: "done", label: "終わった" },
  { id: "failed-build", label: "失敗（組み立て）" },
  { id: "failed-restart", label: "失敗（起こし直し）" },
] as const;
type DemoState = (typeof DEMO_STATES)[number]["id"];

function initialPhase(demo: DemoState): Phase {
  switch (demo) {
    case "latest":
      return { kind: "latest", checking: false };
    case "passkey":
      return { kind: "passkey", mode: "wait" };
    case "fetching":
      return { kind: "progress", mode: "wait", step: "fetch" };
    case "building":
      return { kind: "progress", mode: "wait", step: "build" };
    case "waiting":
      return { kind: "progress", mode: "wait", step: "wait" };
    case "restarting":
      return { kind: "progress", mode: "wait", step: "restart" };
    case "done":
      return { kind: "done" };
    case "failed-build":
      return { kind: "failed", step: "build" };
    case "failed-restart":
      return { kind: "failed", step: "restart" };
    default:
      return { kind: "available" };
  }
}

/** "2026-10-04T09:31:00+09:00" → "10月4日 9:31"。どの端末でも同じ文字にする（時差で変わらない） */
function formatAt(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[1])}月${Number(m[2])}日 ${Number(m[3])}:${m[4]}`;
}

function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function UpdatePanel() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("update-demo");
  const demo: DemoState = DEMO_STATES.some((s) => s.id === raw) ? (raw as DemoState) : "available";
  const noRunning = searchParams.get("running") === "0";
  return (
    <>
      {/* 別の状態の URL へ移ったら、初めから開き直す */}
      <UpdateFlow key={`${demo}:${noRunning}`} demo={demo} running={noRunning ? [] : mockRunningWork} />
      <UpdateDemoSwitcher demo={demo} noRunning={noRunning} />
    </>
  );
}

function UpdateFlow({ demo, running }: { demo: DemoState; running: readonly MockRunningWork[] }) {
  const [phase, setPhase] = useState<Phase>(() => initialPhase(demo));
  // URL で開いた状態はそこで止めて見せる。ボタンを押したときだけ、タイマーで段を進める
  const [auto, setAuto] = useState(false);
  // 待つ段で、まだ動いている会話
  const [remaining, setRemaining] = useState<readonly MockRunningWork[]>(running);
  const [confirm, setConfirm] = useState<"now" | "skip-wait" | null>(demo === "confirm" ? "now" : null);
  const [lastCheckedAt, setLastCheckedAt] = useState(mockLastCheckedAt);
  const [notice, setNotice] = useState<string | null>(null);

  const current = phase.kind === "done" ? latestAsCommit() : mockCurrentVersion;

  useEffect(() => {
    if (!auto) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (phase.kind === "passkey") {
      timer = setTimeout(() => setPhase({ kind: "progress", mode: phase.mode, step: "fetch" }), 1200);
    } else if (phase.kind === "latest" && phase.checking) {
      timer = setTimeout(() => {
        setLastCheckedAt(nowIso());
        setPhase({ kind: "latest", checking: false });
      }, 1000);
    } else if (phase.kind === "progress") {
      const { mode, step } = phase;
      if (step === "fetch") timer = setTimeout(() => setPhase({ kind: "progress", mode, step: "build" }), 1500);
      if (step === "build") {
        // 「すぐ更新」と、動いている会話が無いときは待つ段を飛ばす
        const next: StepId = mode === "now" || remaining.length === 0 ? "restart" : "wait";
        timer = setTimeout(() => setPhase({ kind: "progress", mode, step: next }), 4000);
      }
      if (step === "wait") {
        // 人の返事を待っている会話は、人が答えるまで終わらない——それ以外を1件ずつ終わらせる
        const finishing = remaining.find((w) => !w.waitingForHuman);
        if (remaining.length === 0) timer = setTimeout(() => setPhase({ kind: "progress", mode, step: "restart" }), 600);
        else if (finishing) timer = setTimeout(() => setRemaining((r) => r.filter((w) => w !== finishing)), 2500);
      }
      if (step === "restart") timer = setTimeout(() => setPhase({ kind: "done" }), 3500);
    }
    return () => clearTimeout(timer);
  }, [auto, phase, remaining]);

  function start(mode: Mode) {
    setNotice(null);
    setAuto(true);
    setRemaining(running);
    setPhase({ kind: "passkey", mode });
  }

  function pressNow() {
    if (running.length > 0) setConfirm("now");
    else start("now");
  }

  function confirmed() {
    if (confirm === "now") start("now");
    if (confirm === "skip-wait") {
      setAuto(true);
      setPhase({ kind: "progress", mode: "wait", step: "restart" });
    }
    setConfirm(null);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 pb-16" data-testid="update-panel">
      {phase.kind === "done" ? (
        <div
          data-testid="update-done"
          className="flex items-start gap-2.5 rounded-md border border-ok/30 bg-ok-soft px-3 py-2.5 text-ok"
        >
          <Check className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1 text-sm font-medium">
            版 {mockLatestRelease.tag}
            <span className="ml-1 font-mono text-xs font-normal">（{mockLatestRelease.shortId}）</span>
            になりました
          </p>
        </div>
      ) : null}

      {notice ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">{notice}</p>
      ) : null}

      <CurrentVersionCard commit={current} />

      {phase.kind === "available" || phase.kind === "passkey" ? (
        <NewVersionCard
          phase={phase}
          onWait={() => start("wait")}
          onNow={pressNow}
        />
      ) : null}

      {phase.kind === "latest" || phase.kind === "done" ? (
        <UpToDateCard
          lastCheckedAt={lastCheckedAt}
          checking={phase.kind === "latest" && phase.checking}
          onCheck={() => {
            setAuto(true);
            setPhase({ kind: "latest", checking: true });
          }}
        />
      ) : null}

      {phase.kind === "progress" ? (
        <ProgressCard
          mode={phase.mode}
          step={phase.step}
          remaining={remaining}
          onStopWaiting={() => {
            setAuto(false);
            setPhase({ kind: "available" });
            setNotice("更新をやめました。今の版のまま動いています。");
          }}
          onSkipWait={() => setConfirm("skip-wait")}
        />
      ) : null}

      {phase.kind === "failed" ? (
        <FailedCard
          step={phase.step}
          onRetry={() => {
            setAuto(false);
            setPhase({ kind: "available" });
          }}
        />
      ) : null}

      {phase.kind === "progress" && phase.step === "restart" ? <ReconnectingOverlay /> : null}

      <CutOffDialog
        open={confirm !== null}
        reason={confirm ?? "now"}
        work={confirm === "skip-wait" ? remaining : running}
        onCancel={() => setConfirm(null)}
        onConfirm={confirmed}
      />
    </div>
  );
}

function latestAsCommit(): MockCommit {
  return { shortId: mockLatestRelease.shortId, title: mockNewCommits[0]?.title ?? "", at: mockLatestRelease.publishedAt };
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

function CurrentVersionCard({ commit }: { commit: MockCommit }) {
  return (
    <Card testId="update-current">
      <CardLabel>今の版</CardLabel>
      <p className="text-sm break-words text-foreground">{commit.title}</p>
      <p className="mt-0.5 text-xs text-ink-3">
        <span className="font-mono text-ink-2">{commit.shortId}</span>
        {" · "}
        {formatAt(commit.at)}
      </p>
    </Card>
  );
}

const COMMITS_SHOWN = 5;

function NewVersionCard({
  phase,
  onWait,
  onNow,
}: {
  phase: Extract<Phase, { kind: "available" | "passkey" }>;
  onWait: () => void;
  onNow: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const commits = showAll ? mockNewCommits : mockNewCommits.slice(0, COMMITS_SHOWN);
  const hidden = mockNewCommits.length - COMMITS_SHOWN;

  return (
    <Card testId="update-available">
      <div className="mb-3 flex items-start gap-2">
        <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-accent-ink" />
        <div className="min-w-0">
          <p className="text-md font-semibold text-foreground">
            新しいコミットが {mockNewCommits.length} 件あります
          </p>
          <p className="text-xs text-ink-3">
            最新の版 {mockLatestRelease.tag}（{formatAt(mockLatestRelease.publishedAt)}）と比べています
          </p>
        </div>
      </div>

      <ol data-testid="update-commits" className="flex flex-col divide-y divide-border rounded-md border border-border">
        {commits.map((c) => (
          <li key={c.shortId} className="px-3 py-2">
            <p className="text-sm break-words text-foreground">{c.title}</p>
            <p className="mt-0.5 text-xs text-ink-3">
              <span className="font-mono">{c.shortId}</span>
              {" · "}
              {formatAt(c.at)}
            </p>
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
        >
          <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          {showAll ? "たたむ" : `ほか ${hidden} 件を見る`}
        </Button>
      ) : null}

      <div className="mt-4 border-t border-border pt-4">
        {phase.kind === "passkey" ? (
          <p data-testid="update-passkey" className="flex items-center gap-2 py-2 text-sm text-ink-2">
            <KeyRound className="size-4 shrink-0 text-accent-ink" />
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            パスキーを確かめています
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" size="lg" className="h-10 sm:h-9" onClick={onWait} data-testid="update-wait">
                <RefreshCw className="size-4" />
                AI が止まるまで待って更新
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-10 sm:h-9"
                onClick={onNow}
                data-testid="update-now"
              >
                すぐ更新
              </Button>
            </div>
            <p className="mt-2 text-xs text-ink-3">
              組み立てが終わったら起こし直します。「すぐ更新」は AI を待たないので、動いている会話は途中で切れます。押すとパスキーで本人を確かめます。
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function UpToDateCard({
  lastCheckedAt,
  checking,
  onCheck,
}: {
  lastCheckedAt: string;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <Card testId="update-latest" className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Check className="mt-0.5 size-4 shrink-0 text-ok" />
        <div className="min-w-0">
          <p className="text-md font-semibold text-foreground">最新です</p>
          <p className="text-xs text-ink-3">最後に確かめた時刻 {formatAt(lastCheckedAt)}</p>
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

const STEP_LABEL: Record<StepId, string> = {
  fetch: "取ってくる",
  build: "組み立てる",
  wait: "AI が止まるのを待つ",
  restart: "起こし直す",
};

const STEP_HINT: Record<StepId, string> = {
  fetch: "GitHub から新しい版を取ってきます",
  build: "数分かかります",
  wait: "動いている会話が終わるまで待ちます",
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

function WorkList({ work }: { work: readonly MockRunningWork[] }) {
  return (
    <ul data-testid="update-running" className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
      {work.map((w) => (
        <li key={`${w.projectName}:${w.threadTitle}`} className="flex flex-col gap-0.5 px-3 py-2">
          <p className="text-sm break-words text-foreground">{w.threadTitle}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
            <span>{w.projectName}</span>
            <span>·</span>
            <span>{w.sinceMinutes}分前から</span>
            {w.waitingForHuman ? (
              <span className="rounded-sm bg-turn-soft px-1.5 text-turn">人の返事待ち</span>
            ) : (
              <span>AI が動いています</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ProgressCard({
  mode,
  step,
  remaining,
  onStopWaiting,
  onSkipWait,
}: {
  mode: Mode;
  step: StepId;
  remaining: readonly MockRunningWork[];
  onStopWaiting: () => void;
  onSkipWait: () => void;
}) {
  return (
    <Card testId="update-progress">
      <CardLabel>版 {mockLatestRelease.tag} に更新しています</CardLabel>
      <StepList
        statuses={statusesFor(step, mode)}
        hints={mode === "now" ? { wait: "待ちません（すぐ更新）" } : undefined}
        renderDetail={(s) => {
          if (s !== step) return null;
          if (s === "build")
            return (
              <p className="mt-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
                今の banto はそのまま使えます。
              </p>
            );
          if (s === "wait")
            return (
              <div className="mt-2 flex flex-col gap-2">
                {remaining.length > 0 ? (
                  <>
                    <p className="text-xs text-ink-2">あと {remaining.length} 件</p>
                    <WorkList work={remaining} />
                  </>
                ) : (
                  <p className="text-xs text-ink-2">動いている AI はありません</p>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-10 sm:h-8"
                    onClick={onSkipWait}
                    data-testid="update-skip-wait"
                  >
                    待たずにすぐ起こし直す
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    className="h-10 sm:h-8"
                    onClick={onStopWaiting}
                    data-testid="update-stop-waiting"
                  >
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

function FailedCard({ step, onRetry }: { step: "build" | "restart"; onRetry: () => void }) {
  const [logOpen, setLogOpen] = useState(false);
  const log = step === "build" ? mockBuildFailureLog : mockRestartFailureLog;
  return (
    <Card testId="update-failed">
      <div className="mb-3 flex items-start gap-2 rounded-md border border-stop/30 bg-stop-soft px-3 py-2.5 text-stop">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">「{STEP_LABEL[step]}」で止まりました</p>
          <p className="text-sm">
            {step === "build"
              ? "今の版のまま動いています。"
              : "新しい版が起きなかったので、前の版に戻しました。"}
          </p>
        </div>
      </div>

      <StepList statuses={statusesFor(step, "wait", true)} />

      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10 sm:h-8"
          aria-expanded={logOpen}
          onClick={() => setLogOpen((v) => !v)}
          data-testid="update-log-toggle"
        >
          <ScrollText className="size-4" />
          {logOpen ? "ログを閉じる" : "ログを開く"}
        </Button>
        <Button type="button" variant="ghost" size="lg" className="h-10 sm:h-8" onClick={onRetry}>
          もう一度ためす
        </Button>
      </div>
      {logOpen ? (
        <pre
          data-testid="update-log"
          className="mt-3 max-h-96 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap break-all text-ink-2"
        >
          {log}
        </pre>
      ) : null}
    </Card>
  );
}

/** 起こし直し中——繋がりが一度切れるので、画面全体に「繋がり直すのを待っている」を出す */
function ReconnectingOverlay() {
  return (
    <div
      data-testid="update-reconnecting"
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center shadow-3">
        <WifiOff className="size-6 text-ink-3" />
        <p className="text-md font-semibold text-foreground">起こし直しています</p>
        <p className="text-sm text-ink-2">
          画面が一度切れます。新しい版が起きたら、自動でこの画面に戻ります。
        </p>
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <Loader2 className="size-3.5 animate-spin" />
          繋がり直すのを待っています
        </p>
      </div>
    </div>
  );
}

function CutOffDialog({
  open,
  reason,
  work,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  reason: "now" | "skip-wait";
  work: readonly MockRunningWork[];
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
              ? `組み立てが終わったら、AI を待たずに起こし直します。いま AI が動いている会話が ${work.length} 件あります。`
              : `いま残っている会話が ${work.length} 件あります。`}
          </DialogDescription>
        </DialogHeader>
        <WorkList work={work} />
        <p className="flex items-start gap-1.5 text-sm font-medium text-warn">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          これらは途中で切れます。
        </p>
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
 * **モックだけの**状態の切り替え。本物には無い——破線・注意の色・「デモ」の札で、画面の一部ではないと分かるようにする。
 * URL（`update-demo`・`running`）を書き換えるだけ
 */
function UpdateDemoSwitcher({ demo, noRunning }: { demo: DemoState; noRunning: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="update-demo-switcher"
          className="fixed right-3 bottom-3 z-50 flex items-center gap-1.5 rounded-full border border-dashed border-warn bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn shadow-2"
        >
          <FlaskConical className="size-3.5" />
          デモ：{DEMO_STATES.find((s) => s.id === demo)?.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-50 w-64 border-dashed border-warn p-2">
        <p className="mb-1 px-1 text-xs text-warn">モックだけ（本物には無い）</p>
        <div className="flex flex-col">
          {DEMO_STATES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => set("update-demo", s.id === "available" ? null : s.id)}
              className={cn(
                "rounded-md px-2 py-2 text-left text-sm sm:py-1",
                s.id === demo ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-accent",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="mt-2 flex items-center justify-between gap-2 border-t border-border px-1 pt-2 text-xs text-ink-2">
          動いている AI がある
          <Switch checked={!noRunning} onCheckedChange={(on) => set("running", on ? null : "0")} />
        </label>
      </PopoverContent>
    </Popover>
  );
}
