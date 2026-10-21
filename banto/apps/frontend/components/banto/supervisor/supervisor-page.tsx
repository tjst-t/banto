"use client";

// **番頭の画面——全部の Project の番頭を1か所で見る**（決定・2026-10-21、ユーザー。v4-frontend.md §6.54、アーキ仕様 §4.5。
// 実装・Backlog #511）。
//
// 受信箱と同じ前面の1枚（`?overlay=supervisor`、app-shell.tsx）。番頭は banto 全体の方針で Project ごとに動くので、どの Project を
// 見ていても同じ画面。並びは上から：全部止めている知らせ → banto 全体の方針 → 今日のまとめ → Project ごとの行（番頭を置いていない
// Project を上に）→ 記録（新しい順）。目立たせるのは「全部止める」と、人に回している・上限に当たっている状態だけ。
//
// 呼び名は人の決定待ち——画面の「番頭」は `SUPERVISOR_LABEL` から引く。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, ChevronRight, Hand, Loader2, Pause, Play, Radar, UserCheck, X } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MobileNavButton } from "@/components/banto/shell/mobile-nav-drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  createRealSupervisor,
  getRealSupervisorDaily,
  listRealAutomations,
  listRealSupervisorLog,
  patrolRealSupervisor,
  pauseRealSupervisor,
  putRealProjectSupervisorPolicy,
  putRealSupervisorPolicy,
  removeRealSupervisor,
  type RealSupervisor,
  type RealSupervisorAction,
  type RealSupervisorAct,
  type RealSupervisorDaily,
  type RealSupervisorLogEntry,
  type RealSupervisorPolicy,
} from "@/lib/backend/client";
import {
  ACT_KIND_LABEL,
  describeAct,
  kindShortTitle,
  lastActivityAt,
  notePolicy,
  refreshSupervisors,
  replaceSupervisor,
  supervisorStatus,
  useProjectSupervisorPolicy,
  useSupervisorPolicy,
  useSupervisors,
} from "@/lib/backend/supervisors";
import { formatWhen } from "@/lib/backend/automations";
import { useAutoApproveAll } from "@/lib/backend/auto-approve";
import { getActiveProjects, getProject, isChat, registerNewRealForks } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getThread } from "@/lib/mock/threads";
import { isOverlayOpen } from "@/lib/overlay-open";
import { describeFailure } from "@/lib/report-failure";
import { threadRowHref } from "@/lib/settings-link";
import { SUPERVISOR_LABEL } from "@/lib/supervisor-label";
import { cn } from "@/lib/utils";
import { useStopAllSupervisors } from "./stop-all";
import { defaultUndoText, UndoControl } from "./undo";

const L = SUPERVISOR_LABEL;

/** ブラウザのタイムゾーン（方針に無いときの見せ方。host は自分の動いている場所のものを使う） */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function Section({ title, testId, action, children }: { title: string; testId: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-testid={testId} className="mb-8">
      <h2 className="mb-2 flex items-center gap-2 px-1">
        <span className="flex-1 text-md font-semibold text-foreground">{title}</span>
        {action}
      </h2>
      {children}
    </section>
  );
}

/** 押して返事を待つ間は効かなくし、失敗は理由を出す（黙らない、規則2） */
function useBusy(): { busy: boolean; run: (what: string, fn: () => Promise<void>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  async function run(what: string, fn: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (err) {
      toast(`${what}：${describeFailure(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

export function SupervisorPage({ onClose, onOpenInbox }: { onClose: () => void; onOpenInbox: () => void }) {
  useMockStoreVersion();
  const isMobile = useIsMobile();
  const state = useSupervisors();
  const policy = useSupervisorPolicy();
  const stopAll = useStopAllSupervisors();
  const busy = stopAll.busy;

  // 開いたときに取り直す（ほかの画面で変えた分もここで入る）
  useEffect(() => {
    void refreshSupervisors().catch(() => undefined);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isOverlayOpen({ exceptSupervisor: true })) return;
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT")) target.blur();
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const supervisors = state?.supervisors ?? [];
  const stoppedAll = state?.guard?.stoppedAll ?? false;
  const projects = getActiveProjects().filter((p) => !isChat(p));
  const byProject = new Map(supervisors.map((s) => [s.projectId, s]));
  const unsupervised = projects.filter((p) => !byProject.has(p.id));

  return (
    <div
      role="dialog"
      aria-label={L}
      data-state="open"
      data-banto-supervisor=""
      data-testid="supervisor-page"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
        {isMobile ? <MobileNavButton /> : null}
        <p className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm font-medium text-foreground">
          <UserCheck className="size-4 shrink-0 text-ink-3" />
          {L}
          {state ? (
            <span data-testid="supervisor-count" className="text-xs font-normal tabular-nums text-ink-3">
              {supervisors.length} 件の Project
            </span>
          ) : null}
        </p>
        {supervisors.length > 0 ? (
          stoppedAll ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => stopAll.request("resume")} data-testid="supervisor-resume-all">
              <Play />
              再開する
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => stopAll.request("stop")} data-testid="supervisor-stop-all">
              <Pause />
              {`${L}を全部止める`}
            </Button>
          )
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label={`${L}の画面を閉じる`}
          data-testid="supervisor-close"
          className="ml-1 flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-8"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-3 pt-3 pb-24 md:px-6 md:pt-6">
          <p className="mb-5 px-1 text-sm text-ink-2">
            {`${L}は Project ごとに置く AI です。下の方針の範囲で、会話の決めることに答え、止まった会話に決まった手順を頼み、Factory に流します。仕様の向き・公開・お金・消す操作はいつも人に回します。`}
          </p>
          {stoppedAll ? (
            <div data-testid="supervisor-stopped-all" className="mb-6 flex items-start gap-2 rounded-lg border border-turn/50 bg-turn-soft/40 px-3 py-2.5 text-sm">
              <Hand className="mt-0.5 size-4 shrink-0 text-turn" />
              <p className="flex-1 text-foreground">{`${L}を全部止めています。再開するまで、決めることはすべて人に残ります。`}</p>
            </div>
          ) : null}
          {!state || !policy ? (
            <p className="flex items-center gap-2 px-1 text-sm text-ink-3">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              読み込んでいます…
            </p>
          ) : (
            <>
              <PolicySection policy={policy} />
              <DailySection version={state.version} onOpenInbox={onOpenInbox} />
              <Section
                title="Project"
                testId="supervisor-projects"
                action={
                  unsupervised.length > 0 ? (
                    <PlaceAllButton projectIds={unsupervised.map((p) => p.id)} />
                  ) : null
                }
              >
                {projects.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-ink-3">Project がありません</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {unsupervised.map((p) => (
                      <UnsupervisedRow key={p.id} projectId={p.id} />
                    ))}
                    {projects
                      .filter((p) => byProject.has(p.id))
                      .map((p) => (
                        <SupervisorRow key={p.id} supervisor={byProject.get(p.id)!} policy={policy} onClose={onClose} />
                      ))}
                  </ul>
                )}
              </Section>
              <LogSection version={state.version} policy={policy} supervisors={supervisors} onClose={onClose} />
            </>
          )}
        </div>
      </div>

      {stopAll.dialog}
    </div>
  );
}

// ── 方針（banto 全体） ──────────────────────────────────────────────

function PolicySection({ policy }: { policy: RealSupervisorPolicy }) {
  const [delegate, setDelegate] = useState<ReadonlySet<RealSupervisorAction>>(() => new Set(policy.delegate));
  const [note, setNote] = useState(policy.note);
  const [patrolHours, setPatrolHours] = useState(String(policy.patrolHours));
  const [runsPerHour, setRunsPerHour] = useState(String(policy.limits.runsPerHour));
  const [instructionsPerHour, setInstructionsPerHour] = useState(String(policy.limits.instructionsPerHour));
  const [factoryConcurrent, setFactoryConcurrent] = useState(String(policy.limits.factoryConcurrent));
  const [timeZone, setTimeZone] = useState(policy.timeZone ?? "");
  const [saved, setSaved] = useState(false);
  const { busy, run } = useBusy();

  function toggle(action: RealSupervisorAction, on: boolean) {
    const next = new Set(delegate);
    if (on) next.add(action);
    else next.delete(action);
    setDelegate(next);
    setSaved(false);
  }

  async function save() {
    const num = (v: string) => Number(v.trim());
    await run("方針を保存できませんでした", async () => {
      const next = await putRealSupervisorPolicy({
        delegate: policy.catalog.actions.map((a) => a.action).filter((a) => delegate.has(a)),
        note,
        patrolHours: num(patrolHours),
        limits: { runsPerHour: num(runsPerHour), instructionsPerHour: num(instructionsPerHour), factoryConcurrent: num(factoryConcurrent) },
        timeZone: timeZone.trim() === "" ? null : timeZone.trim(),
      });
      notePolicy(undefined, next);
      setSaved(true);
    });
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, suffix: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-ink-2">
        {label}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          data-testid={id}
          inputMode="numeric"
          value={value}
          onChange={(e) => {
            set(e.target.value);
            setSaved(false);
          }}
          className="h-8 w-20 text-sm"
        />
        <span className="text-xs text-ink-3">{suffix}</span>
      </div>
    </div>
  );

  return (
    <Section title="方針（banto 全体）" testId="supervisor-policy">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-3 md:p-4">
        <div>
          <p className="mb-1.5 text-xs text-ink-3">{`${L}に任せること（Project ごとに足し外しできます）`}</p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {policy.catalog.actions.map((a) => (
              <li key={a.action}>
                <label className="flex items-start gap-2 rounded-md px-1.5 py-1 text-sm text-foreground hover:bg-surface-2/60">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={delegate.has(a.action)}
                    onChange={(e) => toggle(a.action, e.target.checked)}
                    data-testid={`supervisor-delegate-${a.action}`}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span>{a.short}</span>
                    {a.title !== a.short ? <span className="text-xs text-ink-3">{a.title}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {/* 人に回す種類は外せない——チェックは外したまま押せない。理由は薄く1行 */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 text-sm text-ink-3">
            <span className="text-xs">いつも人に回す：</span>
            {policy.catalog.humanOnly.map((k) => (
              <label key={k.kind} title={k.title} className="flex items-center gap-1.5">
                <input type="checkbox" checked={false} disabled data-testid={`supervisor-human-only-${k.kind}`} />
                {k.short}
              </label>
            ))}
          </div>
          <p className="px-1.5 text-xs text-ink-3">{`仕様・アーキテクチャの向き・外への公開・お金・消す操作は、どの方針でも${L}は答えません`}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="supervisor-note" className="text-xs text-ink-2">
            方針の文
          </Label>
          <Textarea
            id="supervisor-note"
            data-testid="supervisor-note"
            value={note}
            placeholder="例：release は試験が全部通ってから。迷ったら人に回す"
            onChange={(e) => {
              setNote(e.target.value);
              setSaved(false);
            }}
            className="min-h-16 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {field("supervisor-patrol-hours", "見回りの間隔", patrolHours, setPatrolHours, "時間ごと")}
          {field("supervisor-runs-per-hour", "起きる回数の上限", runsPerHour, setRunsPerHour, "回／時間")}
          {field("supervisor-instructions-per-hour", "頼む数の上限", instructionsPerHour, setInstructionsPerHour, "件／時間")}
          {field("supervisor-factory-concurrent", "Factory の同時の件数", factoryConcurrent, setFactoryConcurrent, "件まで")}
          <div className="flex flex-col gap-1">
            <Label htmlFor="supervisor-time-zone" className="text-xs text-ink-2">
              タイムゾーン
            </Label>
            <Input
              id="supervisor-time-zone"
              data-testid="supervisor-time-zone"
              value={timeZone}
              placeholder={`空なら banto の場所（例 ${browserTimeZone()}）`}
              onChange={(e) => {
                setTimeZone(e.target.value);
                setSaved(false);
              }}
              className="h-8 w-56 text-sm"
            />
          </div>
        </div>
        <p className="text-xs text-ink-3">
          {`上限は全部の${L}の合計です。超えたらその時間は人に回します。1日の数えはこのタイムゾーンの日付です。見回りの間隔を変えたら、${L}を一時停止して再開すると効きます。`}
        </p>
        {policy.problems.length > 0 ? (
          <ul data-testid="supervisor-policy-problems" className="flex flex-col gap-0.5 text-xs text-warn">
            {policy.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void save()} data-testid="supervisor-policy-save">
            方針を保存
          </Button>
          {saved ? (
            <span data-testid="supervisor-policy-saved" className="text-xs text-ok">
              保存しました
            </span>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

// ── 今日のまとめ ──────────────────────────────────────────────

function DailySection({ version, onOpenInbox }: { version: number; onOpenInbox: () => void }) {
  const [daily, setDaily] = useState<RealSupervisorDaily | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getRealSupervisorDaily()
      .then((d) => {
        if (!alive) return;
        setDaily(d);
        setError(null);
      })
      .catch((err: unknown) => alive && setError(describeFailure(err)));
    return () => {
      alive = false;
    };
  }, [version]);

  return (
    <Section title="今日のまとめ" testId="supervisor-daily">
      {error ? (
        <p className="text-sm text-stop">読み込めませんでした：{error}</p>
      ) : !daily ? (
        <p className="text-sm text-ink-3">読み込んでいます…</p>
      ) : daily.projects.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-ink-3">{`${L}を置いている Project はありません`}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
          {daily.projects.map((row) => {
            const toHuman = row.counts.deferred ?? 0;
            return (
              <li key={row.supervisorId} data-testid="supervisor-daily-row" data-project={row.projectId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{getProject(row.projectId).name}</span>
                <span className="text-xs text-ink-2 tabular-nums" data-testid="supervisor-daily-counts">
                  選んだ {row.counts.answered ?? 0}・頼んだ {row.counts.instructed ?? 0}・流した {row.counts["factory-started"] ?? 0}・
                  <span className={cn(toHuman > 0 && "font-medium text-turn")}>人に回した {toHuman}</span>
                </span>
                {toHuman > 0 ? (
                  <button type="button" onClick={onOpenInbox} className="text-xs text-ink-2 underline-offset-2 hover:text-foreground hover:underline">
                    受信箱で見る
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {daily ? <p className="mt-1 px-1 text-xs text-ink-3">{`${daily.date}（${daily.timeZone}）`}</p> : null}
    </Section>
  );
}

// ── Project の行 ──────────────────────────────────────────────

/** 判断役（`banto.turn-decisions` を待つ自動化）が動いている Project。番頭と並べられない */
async function projectsWithJudges(projectIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    projectIds.map(async (id) => {
      const list = await listRealAutomations(id);
      if (list.some((a) => a.source.kind === "event" && a.source.event === "banto.turn-decisions" && !a.paused)) out.add(id);
    }),
  );
  return out;
}

/**
 * **番頭を置く**（1件でも全部でも同じ手順）：判断役が動いている Project を調べ、1枚のカードで何が起きるかを出して聞く。判断役が
 * あれば一時停止するかもそこで選ぶ（選ばなければその Project には置かない）
 */
function usePlaceSupervisors(): { request: (projectIds: readonly string[]) => void; busy: boolean; dialog: ReactNode } {
  const [pending, setPending] = useState<{ projectIds: string[]; judges: Set<string> } | null>(null);
  const [pauseJudges, setPauseJudges] = useState(false);
  const { busy, run } = useBusy();

  function request(projectIds: readonly string[]) {
    void run("判断役を調べられませんでした", async () => {
      const judges = await projectsWithJudges(projectIds);
      setPauseJudges(false);
      setPending({ projectIds: [...projectIds], judges });
    });
  }

  async function place(projectIds: readonly string[], judges: ReadonlySet<string>, pause: boolean) {
    const failed: string[] = [];
    let placed = 0;
    for (const id of projectIds) {
      if (judges.has(id) && !pause) continue;
      try {
        replaceSupervisor(await createRealSupervisor(id, judges.has(id) ? { pauseJudges: true } : {}));
        placed++;
      } catch (err) {
        failed.push(`「${getProject(id).name}」：${describeFailure(err)}`);
      }
    }
    await refreshSupervisors().catch(() => undefined);
    if (failed.length > 0) toast(`${L}を置けなかった Project があります：${failed.join("／")}`);
    else if (placed > 1) toast(`${placed} 件の Project に${L}を置きました`);
  }

  const many = (pending?.projectIds.length ?? 0) > 1;
  const withJudges = pending ? pending.projectIds.filter((id) => pending.judges.has(id)) : [];
  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent data-testid="supervisor-place-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {many ? `${pending?.projectIds.length} 件の Project に${L}を置きますか` : `「${getProject(pending?.projectIds[0] ?? "").name}」に${L}を置きますか`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {`Project ごとに${L}の会話（Fork）を1本作り、今の方針で動かし始めます。決めることへの答え・止まった会話への頼み・Factory への流し込みは、方針で任せたものだけです。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {many ? (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto text-sm text-ink-2">
            {pending?.projectIds.map((id) => (
              <li key={id} className="truncate">
                {getProject(id).name}
                {pending.judges.has(id) ? <span className="text-ink-3">（判断役が動いています）</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {withJudges.length > 0 ? (
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={pauseJudges}
              onChange={(e) => setPauseJudges(e.target.checked)}
              data-testid="supervisor-place-pause-judges"
            />
            <span>
              {many
                ? `判断役が動いている ${withJudges.length} 件では、判断役を一時停止して置く（選ばなければ、その Project には置きません）`
                : `この Project では判断役が動いています。判断役を一時停止して置く（${L}と判断役は並べられません）`}
            </span>
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>やめる</AlertDialogCancel>
          <AlertDialogAction
            data-testid="supervisor-place-ok"
            disabled={!many && withJudges.length > 0 && !pauseJudges}
            onClick={() => {
              const p = pending;
              const pause = pauseJudges;
              setPending(null);
              if (p) void run(`${L}を置けませんでした`, () => place(p.projectIds, p.judges, pause));
            }}
          >
            置く
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { request, busy, dialog };
}

function PlaceAllButton({ projectIds }: { projectIds: readonly string[] }) {
  const { request, busy, dialog } = usePlaceSupervisors();
  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => request(projectIds)} data-testid="supervisor-place-all">
        {`全部の Project に${L}を置く`}
      </Button>
      {dialog}
    </>
  );
}

function UnsupervisedRow({ projectId }: { projectId: string }) {
  const { request, busy, dialog } = usePlaceSupervisors();
  const project = getProject(projectId);
  return (
    <li data-testid="supervisor-project-row" data-project={projectId} data-supervised="false" className="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{project.name}</span>
      <span className="text-xs text-ink-3">{`${L}はいません`}</span>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => request([projectId])} data-testid="supervisor-place">
        {`${L}を置く`}
      </Button>
      {dialog}
    </li>
  );
}

/** 「承認をすべて自動で許可する」との関係（§6.54）。オンのときの文は、自動許可の絞りが人の決定待ちなので今の動きをそのまま言う */
function AutoApproveNote({ projectId }: { projectId: string }) {
  const autoApprove = useAutoApproveAll(projectId, true);
  if (autoApprove === undefined) return null;
  return (
    <p data-testid="supervisor-auto-approve-note" className={cn("text-xs", autoApprove ? "text-warn" : "text-ink-3")}>
      {autoApprove
        ? "「承認をすべて自動で許可する」がオンです。公開や消す操作も人に聞かれません。"
        : "コマンドの承認で止まったものは人に残ります。"}
    </p>
  );
}

/** 番頭の会話・そのほかの会話を開く。画面がまだ知らない Fork（番頭の専用の Fork）は一覧に足してから */
function useOpenThread(onClose: () => void): (projectId: string, threadId: string) => void {
  const router = useRouter();
  return (projectId, threadId) => {
    void (async () => {
      if (!getThread(threadId)) await registerNewRealForks(projectId).catch(() => undefined);
      const t = getThread(threadId);
      onClose();
      router.push(threadRowHref(projectId, t?.kind === "base" ? null : threadId));
    })();
  };
}

function SupervisorRow({ supervisor, policy, onClose }: { supervisor: RealSupervisor; policy: RealSupervisorPolicy; onClose: () => void }) {
  const project = getProject(supervisor.projectId);
  const status = supervisorStatus(supervisor);
  const last = lastActivityAt(supervisor);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { busy, run } = useBusy();
  const openThread = useOpenThread(onClose);

  async function togglePause() {
    await run(supervisor.paused ? `${L}を再開できませんでした` : `${L}を一時停止できませんでした`, async () => {
      replaceSupervisor(await pauseRealSupervisor(supervisor.projectId, !supervisor.paused));
    });
  }

  async function patrol() {
    await run("見回れませんでした", async () => {
      const started = await patrolRealSupervisor(supervisor.projectId);
      toast(started.result === "skipped" ? `見回りを飛ばしました：${started.reason ?? ""}` : `「${project.name}」の見回りを始めました`);
      await refreshSupervisors();
    });
  }

  return (
    <li data-testid="supervisor-project-row" data-project={supervisor.projectId} data-supervised="true" className="flex flex-col">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
            <span
              data-testid="supervisor-status"
              data-tone={status.tone}
              className={cn(
                "text-xs",
                status.tone === "attention" ? "font-medium text-turn" : status.tone === "ok" ? "text-ok" : "text-ink-3",
              )}
            >
              {status.text}
            </span>
            <span className="text-xs text-ink-3" data-testid="supervisor-last">
              {last ? `最後に動いた：${formatWhen(last, policy.timeZone ?? browserTimeZone())}` : "まだ動いていません"}
            </span>
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {supervisor.threadId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => openThread(supervisor.projectId, supervisor.threadId!)}
              data-testid="supervisor-open-thread"
            >
              <ArrowUpRight />
              会話を開く
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" disabled={busy || supervisor.paused} onClick={() => void patrol()} data-testid="supervisor-patrol">
            <Radar />
            今すぐ見回る
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void togglePause()} data-testid="supervisor-pause">
            {supervisor.paused ? <Play /> : <Pause />}
            {supervisor.paused ? "再開" : "一時停止"}
          </Button>
        </div>
      </div>
      <div className="px-3 pb-2.5 pl-9">
        <AutoApproveNote projectId={supervisor.projectId} />
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border bg-surface-2/30 px-3 py-3 pl-9" data-testid="supervisor-project-details">
          <ProjectPolicyEditor projectId={supervisor.projectId} instance={policy} />
          <div>
            <Button type="button" size="sm" variant="ghost" className="text-ink-2" onClick={() => setRemoving(true)} data-testid="supervisor-remove">
              {`${L}を外す`}
            </Button>
          </div>
        </div>
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`「${project.name}」の${L}を外しますか`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`この Project の決めることは、また全部人が答えます。${L}の会話と記録は残りません（会話は Fork として残ります）。Factory に流した件は止めません。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void run(`${L}を外せませんでした`, async () => {
                  await removeRealSupervisor(supervisor.projectId);
                  await refreshSupervisors();
                })
              }
            >
              外す
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** その Project の足し外し（全体の方針との差分）と追記 */
function ProjectPolicyEditor({ projectId, instance }: { projectId: string; instance: RealSupervisorPolicy }) {
  const effective = useProjectSupervisorPolicy(projectId);
  if (!effective) return <p className="text-xs text-ink-3">方針を読み込んでいます…</p>;
  // 鍵：全体の方針を変えたら効いている方針も変わる——描き直して手元の値を捨てる
  return <ProjectPolicyForm key={`${instance.delegate.join(",")}|${effective.delegate.join(",")}|${effective.layer?.note ?? ""}`} projectId={projectId} instance={instance} effective={effective} />;
}

function ProjectPolicyForm({ projectId, instance, effective }: { projectId: string; instance: RealSupervisorPolicy; effective: RealSupervisorPolicy }) {
  const [delegate, setDelegate] = useState<ReadonlySet<RealSupervisorAction>>(() => new Set(effective.delegate));
  const [note, setNote] = useState(effective.layer?.note ?? "");
  const { busy, run } = useBusy();
  const base = new Set(instance.delegate);
  const add = instance.catalog.actions.map((a) => a.action).filter((a) => delegate.has(a) && !base.has(a));
  const remove = instance.catalog.actions.map((a) => a.action).filter((a) => !delegate.has(a) && base.has(a));
  const diffText = [
    ...add.map((a) => `${kindShortTitle(a, instance)}を任せる`),
    ...(remove.length > 0 ? [`${remove.map((a) => kindShortTitle(a, instance)).join("・")}は人`] : []),
  ].join("。");

  async function save() {
    await run("Project の方針を保存できませんでした", async () => {
      const next = await putRealProjectSupervisorPolicy(projectId, {
        delegate: add.length === 0 && remove.length === 0 ? null : { add, remove },
        note: note.trim() === "" ? null : note,
      });
      notePolicy(projectId, next);
    });
  }

  return (
    <div className="flex flex-col gap-2" data-testid="supervisor-project-policy">
      <p className="text-xs text-ink-3">この Project で任せること（全体の方針との違いだけを持ちます）</p>
      <ul className="flex flex-wrap gap-1.5">
        {instance.catalog.actions.map((a) => {
          const on = delegate.has(a.action);
          const changed = on !== base.has(a.action);
          return (
            <li key={a.action}>
              <label
                title={a.title}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs",
                  changed ? "border-primary text-foreground" : "border-border text-ink-2",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const next = new Set(delegate);
                    if (e.target.checked) next.add(a.action);
                    else next.delete(a.action);
                    setDelegate(next);
                  }}
                  data-testid={`supervisor-project-delegate-${a.action}`}
                />
                {a.short}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-ink-2" data-testid="supervisor-project-diff">
        {diffText === "" ? "全体の方針のままです" : diffText}
      </p>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="この Project だけの方針の文（全体の文の後ろに足します）"
        className="min-h-14 bg-card text-sm"
        data-testid="supervisor-project-note"
      />
      {effective.problems.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-warn">
          {effective.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save()} data-testid="supervisor-project-policy-save">
          この Project の方針を保存
        </Button>
      </div>
    </div>
  );
}

// ── 記録 ──────────────────────────────────────────────

const LOG_KINDS: ReadonlyArray<RealSupervisorAct["kind"]> = [
  "answered",
  "instructed",
  "factory-started",
  "factory-answered",
  "deferred",
  "dropped",
  "refused",
  "skipped",
  "undone",
];

function threadLabel(threadId: string): string {
  const t = getThread(threadId);
  if (!t) return "会話";
  return t.kind === "base" ? "Base Thread" : t.title;
}

function LogSection({
  version,
  policy,
  supervisors,
  onClose,
}: {
  version: number;
  policy: RealSupervisorPolicy;
  supervisors: readonly RealSupervisor[];
  onClose: () => void;
}) {
  const [project, setProject] = useState("");
  const [thread, setThread] = useState("");
  const [kind, setKind] = useState("");
  const [acts, setActs] = useState<RealSupervisorLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    listRealSupervisorLog({ ...(project ? { project } : {}), ...(thread ? { thread } : {}), ...(kind ? { kinds: [kind] } : {}) })
      .then((list) => {
        if (!alive) return;
        setActs(list);
        setError(null);
      })
      .catch((err: unknown) => alive && setError(describeFailure(err)));
    return () => {
      alive = false;
    };
  }, [version, project, thread, kind, reload]);

  // 会話の選び先は、いま出ている記録の会話（番頭自身の会話は除く）
  const supervisorThreads = new Set(supervisors.flatMap((s) => (s.threadId ? [s.threadId] : [])));
  const threads = useMemo(
    () => [...new Set((acts ?? []).map((a) => a.threadId))].filter((id) => !supervisorThreads.has(id) || id === thread),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [acts, thread],
  );
  const select = "h-8 min-w-0 rounded-lg border border-input bg-card px-2 text-sm text-foreground";

  return (
    <Section title="記録" testId="supervisor-log">
      <div className="mb-2 flex flex-wrap gap-2">
        <select aria-label="Project で絞る" className={select} value={project} onChange={(e) => setProject(e.target.value)} data-testid="supervisor-log-project">
          <option value="">すべての Project</option>
          {supervisors.map((s) => (
            <option key={s.projectId} value={s.projectId}>
              {getProject(s.projectId).name}
            </option>
          ))}
        </select>
        <select aria-label="会話で絞る" className={select} value={thread} onChange={(e) => setThread(e.target.value)} data-testid="supervisor-log-thread">
          <option value="">すべての会話</option>
          {threads.map((id) => (
            <option key={id} value={id}>
              {threadLabel(id)}
            </option>
          ))}
        </select>
        <select aria-label="したことで絞る" className={select} value={kind} onChange={(e) => setKind(e.target.value)} data-testid="supervisor-log-kind">
          <option value="">したことすべて</option>
          {LOG_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className="text-sm text-stop">読み込めませんでした：{error}</p>
      ) : !acts ? (
        <p className="text-sm text-ink-3">読み込んでいます…</p>
      ) : acts.length === 0 ? (
        <p data-testid="supervisor-log-empty" className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-ink-3">
          まだ何もしていません
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
          {acts.map((a) => (
            <LogRow key={a.actId} act={a} all={acts} policy={policy} onClose={onClose} onUndone={() => setReload((n) => n + 1)} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function LogRow({
  act,
  all,
  policy,
  onClose,
  onUndone,
}: {
  act: RealSupervisorLogEntry;
  all: readonly RealSupervisorLogEntry[];
  policy: RealSupervisorPolicy;
  onClose: () => void;
  onUndone: () => void;
}) {
  const openThread = useOpenThread(onClose);
  const factory = act.kind === "factory-started";
  const undoable = act.undoable && (act.kind === "answered" || act.kind === "instructed" || factory);
  const timeZone = policy.timeZone ?? browserTimeZone();
  return (
    <li data-testid="supervisor-log-row" data-kind={act.kind} data-act={act.actId} className="flex flex-col gap-1 px-3 py-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
        <span className="tabular-nums">{formatWhen(act.at, timeZone)}</span>
        <span className="truncate">{getProject(act.projectId).name}</span>
        <button
          type="button"
          onClick={() => openThread(act.projectId, act.threadId)}
          className="truncate text-ink-2 underline-offset-2 hover:text-foreground hover:underline"
          data-testid="supervisor-log-thread-link"
        >
          {threadLabel(act.threadId)}
        </button>
      </p>
      <p className="text-sm text-foreground" data-testid="supervisor-log-what">
        <span className={cn(act.kind === "deferred" && "font-medium text-turn")}>{describeAct(act, policy)}</span>
        {act.undoneBy ? (
          <span data-testid="supervisor-log-undone" className="ml-2 text-xs text-ink-3">
            取り消しました
          </span>
        ) : null}
      </p>
      {act.reason ? <p className="text-xs text-ink-2" data-testid="supervisor-log-reason">{act.reason}</p> : null}
      {undoable ? <UndoControl act={act} initialText={factory ? undefined : defaultUndoText(act, all, policy)} onUndone={onUndone} /> : null}
    </li>
  );
}
