"use client";

// **自動化の画面**（決定・2026-10-15、v4-frontend.md §6.42。見本はモック `fork/schedule` の triggers-panel.tsx）。
// core の画面だが Canvas の枠に出す——Module の MCP App ではないので iframe を通らず、ここが直に描く（§6.2 の例外）。
// データは host の HTTP の口（`lib/backend/automations.ts` の写し）から。
//
// - 1行に1件：名前・きっかけ・届け先と起こし方・次の時刻、その下に直近の回の印（古い→新しい）と前の回の結果
// - 押すと開く：毎回届ける指示・届け先・受信箱・作った人・直近の回と理由・操作（会話を開く・今すぐ動かす・
//   一時停止／再開する・直す・消す）。消しても専用の Fork は残る
// - 足す・直すは一覧の中でその場に開くフォーム。いまのきっかけは決まった時刻だけ（Webhook は Backlog `automation-webhook`）
// - 一覧の下に「動き方」を常に出す——いま実際にそう動くことだけを書く
import { useState, type FormEvent, type ReactNode } from "react";
import { UrlLink as Link } from "@/components/banto/url-link";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Hand,
  Loader2,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldX,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PillTabs } from "@/components/banto/shell/segmented-tabs";
import { cn } from "@/lib/utils";
import {
  automationsCanvasHref,
  createAutomation,
  describeRepeat,
  describeSource,
  describeTarget,
  formatWhen,
  removeAutomation,
  runAutomationNow,
  runLabel,
  threadTitle,
  timeZoneName,
  updateAutomation,
  useAutomations,
} from "@/lib/backend/automations";
import type {
  RealAutomation,
  RealAutomationFields,
  RealAutomationRepeat,
  RealAutomationRun,
  RealAutomationTarget,
} from "@/lib/backend/client";
import { getThreadsForProject } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";

export function AutomationsView({ projectId }: { projectId: string }) {
  // 届け先の会話の名前はサイドバーと同じ写しから引く
  useMockStoreVersion();
  const automations = useAutomations(projectId);
  const [editing, setEditing] = useState<"new" | string | null>(null);

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4" data-testid="automations">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <p className="text-sm text-ink-2">
          決まった時刻になったら、この Project の AI に決まった指示を届けて動かします。自動化ごとに専用の Fork があり、動いた回の会話はその Fork に残ります。
        </p>

        {automations === undefined ? (
          <p className="text-sm text-ink-3">読み込んでいます…</p>
        ) : automations.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card" data-testid="automation-list">
            {automations.map((a) =>
              editing === a.id ? (
                <li key={a.id} className="p-3">
                  <AutomationForm projectId={projectId} automation={a} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <AutomationRow key={a.id} automation={a} onEdit={() => setEditing(a.id)} />
              ),
            )}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-ink-3" data-testid="automations-empty">
            まだありません。毎朝のまとめ、定期の見張りなど、決まった時刻にやらせたいことを足してください。
          </p>
        )}

        {editing === "new" ? (
          <div className="rounded-md border border-border bg-card p-3">
            <AutomationForm projectId={projectId} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-fit gap-1 text-xs"
            onClick={() => setEditing("new")}
            data-testid="automation-add"
          >
            <Plus className="size-3.5" />
            自動化を足す
          </Button>
        )}

        <HowItRuns />
      </div>
    </div>
  );
}

/** 動き方の決まり。作る前に読める位置に置く——いまの host が実際にそう動くことだけ */
function HowItRuns() {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5 text-xs text-ink-2" data-testid="automations-how">
      <p className="mb-1.5 font-medium text-foreground">動き方</p>
      <ul className="flex list-disc flex-col gap-1 pl-4">
        <li>前の回がまだ動いている・あなたの答えを待っているときは、その回を飛ばします。飛ばした理由は直近の回に残ります。</li>
        <li>banto が止まっていた間の時刻は、起き直したときに一番最近の1回だけ動かし、残りは「飛ばした」1件にまとめます。</li>
        <li>一時停止している間と、Project を閉じている間は動きません。再開したら、その時刻から数え直します。</li>
        <li>確認が要る操作に当たったら、あなたの答えを待って止まります。「承認をすべて自動で許可する」がオンなら止まりません。</li>
        <li>専用の Fork を閉じると、その自動化は一時停止します。Fork を開き直しても自動では再開しません。</li>
      </ul>
    </div>
  );
}

function AutomationRow({ automation: a, onEdit }: { automation: RealAutomation; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  // 押した操作の結果（飛ばした理由・断られた理由）。次に押すまで残す
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const last = a.runs[0];
  const tz = a.source.timeZone;
  const threadId = a.target.threadId;

  async function act(fn: () => Promise<string | undefined | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const note = await fn();
      if (note) setMessage({ tone: "info", text: note });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="automation-row" data-automation-id={a.id}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <Clock className={cn("mt-0.5 size-4 shrink-0", a.paused ? "text-ink-3" : "text-primary")} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span data-testid="automation-name" className={cn("font-medium", a.paused ? "text-ink-2" : "text-foreground")}>
              {a.name}
            </span>
            {a.paused ? (
              <span className="text-xs text-ink-3" data-testid="automation-paused">
                一時停止中
              </span>
            ) : null}
          </p>
          <p className="text-xs text-ink-2" data-testid="automation-summary">
            {describeSource(a)}
            <span className="mx-1.5 text-ink-3">/</span>
            {describeTarget(a.target)}
            {a.nextFireAt ? (
              <>
                <span className="mx-1.5 text-ink-3">/</span>
                <span data-testid="automation-next">次は {formatWhen(a.nextFireAt, tz)}</span>
              </>
            ) : null}
          </p>
          {last ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <RunStrip runs={a.runs} timeZone={tz} />
              <span className={cn("text-xs", last.result === "waiting" ? "text-turn" : "text-ink-3")} data-testid="automation-last-run">
                前の回（{formatWhen(last.at, tz)}）：{runLabel(last)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-ink-3" data-testid="automation-last-run">
              まだ動いていません
            </p>
          )}
        </div>
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-3 pb-3 pl-10" data-testid="automation-details">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-ink-3">毎回届ける指示</p>
            <blockquote className="rounded-md bg-surface-2 px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-2" data-testid="automation-instruction">
              {a.instruction}
            </blockquote>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">届け先</dt>
            <dd className="text-ink-2">{targetSentence(a.target)}</dd>
            <dt className="text-ink-3">受信箱</dt>
            <dd className="text-ink-2">
              {a.reviewOnDone
                ? "終わった回を出します。"
                : "終わった回は出しません。あなたの答えを待つ回・決めることがある回・失敗した回だけ出します。"}
            </dd>
            <dt className="text-ink-3">作った人</dt>
            <dd className="text-ink-2">
              {a.createdBy.kind === "human" ? "あなた" : `AI（「${threadTitle(a.createdBy.threadId)}」で頼まれ、あなたが許可しました）`}
            </dd>
            {a.paused && a.pausedReason ? (
              <>
                <dt className="text-ink-3">一時停止</dt>
                <dd className="text-ink-2">{a.pausedReason}</dd>
              </>
            ) : null}
          </dl>

          {a.runs.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-ink-3">直近の回</p>
              <ul className="flex flex-col gap-1" data-testid="automation-runs">
                {a.runs.map((r) => (
                  <li key={r.runId} className="flex items-start gap-2 text-xs" data-testid="automation-run" data-result={r.result}>
                    <RunIcon run={r} className="mt-px size-3.5 shrink-0" />
                    <span className="w-24 shrink-0 text-ink-3">{formatWhen(r.at, tz)}</span>
                    <span className={cn(r.result === "waiting" ? "text-turn" : "text-ink-2")}>
                      {runLabel(r)}
                      {r.cause === "manual" ? <span className="text-ink-3">（今すぐ動かした回）</span> : null}
                      {r.reason ? <span className="text-ink-3">——{r.reason}</span> : null}
                      {r.delayed ? <span className="text-ink-3">——{r.delayed}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {confirmRemove ? (
            <div className="flex flex-col gap-2 rounded-md bg-stop-soft px-3 py-2.5 text-xs">
              <p className="text-foreground">自動化「{a.name}」を消します。</p>
              <p className="text-ink-2">
                {a.target.kind === "dedicated" ? "専用の Fork とその会話は残ります。要らなければ Fork を閉じてください。" : "届け先の会話はそのまま残ります。"}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void act(() => removeAutomation(a.projectId, a.id))}
                  data-testid="automation-remove-confirm"
                >
                  消す
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmRemove(false)}>
                  やめる
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {threadId ? (
                <Button asChild variant="outline" size="sm" className="h-7 gap-1 text-xs">
                  {/* 会話は Canvas の隣に開く——一覧を閉じずに、その回の会話を読める */}
                  <Link
                    href={automationsCanvasHref(a.projectId, threadId === baseThreadIdOf(a.projectId) ? null : threadId)}
                    data-testid="automation-open-thread"
                  >
                    <MessageSquare className="size-3.5" />
                    会話を開く
                  </Link>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={busy}
                onClick={() => void act(() => runAutomationNow(a.projectId, a.id).then((skipped) => (skipped ? `動かしませんでした：${skipped}` : undefined)))}
                data-testid="automation-run-now"
              >
                <Play className="size-3.5" />
                今すぐ動かす
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={busy}
                onClick={() => void act(() => updateAutomation(a.projectId, a.id, { paused: !a.paused }))}
                data-testid="automation-pause"
              >
                {a.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {a.paused ? "再開する" : "一時停止"}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={onEdit} data-testid="automation-edit">
                <Pencil className="size-3.5" />
                直す
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-ink-3 hover:text-stop"
                onClick={() => setConfirmRemove(true)}
                data-testid="automation-remove"
              >
                <Trash2 className="size-3.5" />
                消す
              </Button>
            </div>
          )}
          {message ? (
            <p
              role={message.tone === "error" ? "alert" : "status"}
              className={cn("text-xs", message.tone === "error" ? "text-stop" : "text-ink-2")}
              data-testid="automation-message"
            >
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function baseThreadIdOf(projectId: string): string | undefined {
  return getThreadsForProject(projectId).find((t) => t.kind === "base")?.id;
}

function targetSentence(t: RealAutomationTarget): string {
  if (t.kind === "thread") return `「${threadTitle(t.threadId)}」に届けます。その会話は Clear しません。`;
  return t.mode === "fresh"
    ? "専用の Fork に、毎回まっさらな会話で届けます。届ける前に Clear し、前の回の会話は横線の上に残ります。"
    : "専用の Fork に、前の回の会話を引き継いで届けます。";
}

function RunIcon({ run, className }: { run: Pick<RealAutomationRun, "result">; className?: string }) {
  switch (run.result) {
    case "done":
      return <CircleCheck className={cn(className, "text-ok")} />;
    case "skipped":
      return <CircleDashed className={cn(className, "text-ink-3")} />;
    case "rejected":
      return <ShieldX className={cn(className, "text-warn")} />;
    case "waiting":
      return <Hand className={cn(className, "text-turn")} />;
    case "failed":
      return <CircleX className={cn(className, "text-stop")} />;
    case "running":
      return <Loader2 className={cn(className, "animate-spin text-primary motion-reduce:animate-none")} />;
  }
}

/** 直近の回の印を古い→新しいの順に1列で。色だけに頼らず形も変える（飛ばした回は点線の枠） */
function RunStrip({ runs, timeZone }: { runs: readonly RealAutomationRun[]; timeZone: string }) {
  const shown = runs.slice(0, 8).reverse();
  return (
    <span className="flex items-center gap-1" aria-label={`直近の ${shown.length} 回`} data-testid="automation-run-strip">
      {shown.map((r) => (
        <span
          key={r.runId}
          title={`${formatWhen(r.at, timeZone)}：${runLabel(r)}`}
          data-result={r.result}
          className={cn(
            "block size-2 rounded-xs border",
            r.result === "done" && "border-ok bg-ok-soft",
            r.result === "skipped" && "border-dashed border-ink-3",
            r.result === "rejected" && "border-dashed border-warn",
            r.result === "waiting" && "border-turn bg-turn",
            r.result === "failed" && "border-stop bg-stop-soft",
            r.result === "running" && "animate-pulse border-primary motion-reduce:animate-none",
          )}
        />
      ))}
    </span>
  );
}

type RepeatKind = RealAutomationRepeat["kind"];

const REPEAT_TABS: readonly { id: RepeatKind; label: string }[] = [
  { id: "daily", label: "毎日" },
  { id: "weekdays", label: "平日" },
  { id: "weekly", label: "毎週" },
  { id: "interval", label: "時間ごと" },
  { id: "cron", label: "cron の式" },
];

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
/** タイムゾーンの選び先。作った人のブラウザのもの（既定）といまの値を先頭に足す */
const COMMON_TIME_ZONES = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "America/New_York", "Europe/London"] as const;

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** "9:00" → "09:00"（`<input type="time">` の値の形） */
function padTime(t: string): string {
  const [h = "0", m = "00"] = t.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

function AutomationForm({ projectId, automation, onDone }: { projectId: string; automation?: RealAutomation; onDone: () => void }) {
  const repeat0 = automation?.source.repeat;
  const [name, setName] = useState(automation?.name ?? "");
  const [instruction, setInstruction] = useState(automation?.instruction ?? "");
  const [kind, setKind] = useState<RepeatKind>(repeat0?.kind ?? "daily");
  const [clock, setClock] = useState(repeat0 && "time" in repeat0 ? padTime(repeat0.time) : "09:00");
  const [day, setDay] = useState(repeat0?.kind === "weekly" ? repeat0.day : 1);
  const [hours, setHours] = useState(repeat0?.kind === "interval" ? repeat0.hours : 1);
  const [cron, setCron] = useState(repeat0?.kind === "cron" ? repeat0.expr : "0 9 * * 1-5");
  // 既定は作った人のブラウザのタイムゾーン（banto の機械の時計は UTC のことがある）
  const [timeZone, setTimeZone] = useState(automation?.source.timeZone ?? browserTimeZone());
  const target0 = automation?.target;
  const [targetKind, setTargetKind] = useState<RealAutomationTarget["kind"]>(target0?.kind ?? "dedicated");
  const [mode, setMode] = useState<"fresh" | "continue">(target0?.kind === "dedicated" ? target0.mode : "fresh");
  const threads = getThreadsForProject(projectId).filter((t) => t.status !== "closed");
  const [threadId, setThreadId] = useState(
    target0?.kind === "thread" ? target0.threadId : (threads.find((t) => t.kind === "base")?.id ?? ""),
  );
  const [reviewOnDone, setReviewOnDone] = useState(automation?.reviewOnDone ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = Array.from(new Set([timeZone, browserTimeZone(), ...COMMON_TIME_ZONES]));

  const time = clock.replace(/^0(\d)/, "$1");
  const repeat: RealAutomationRepeat =
    kind === "daily" || kind === "weekdays"
      ? { kind, time }
      : kind === "weekly"
        ? { kind, day, time }
        : kind === "interval"
          ? { kind, hours }
          : { kind, expr: cron };
  const target: RealAutomationTarget = targetKind === "dedicated" ? { kind: "dedicated", mode } : { kind: "thread", threadId };
  const filled = name.trim() !== "" && instruction.trim() !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!filled || saving) return;
    const fields: RealAutomationFields = {
      name: name.trim(),
      instruction: instruction.trim(),
      source: { kind: "time", repeat, timeZone },
      target,
      reviewOnDone,
    };
    setSaving(true);
    setError(null);
    try {
      if (automation) await updateAutomation(projectId, automation.id, fields);
      else await createAutomation(projectId, fields);
      onDone();
    } catch (err) {
      // 断られた理由（cron の式が読めない・間隔が短い等）は host の言葉のまま出し、フォームは開いたまま（規則2）
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" data-testid="automation-form">
      <p className="text-sm font-medium text-foreground">{automation ? `「${automation.name}」を直す` : "自動化を足す"}</p>

      <div className="flex flex-col gap-1.5">
        <Label>何が起きたら</Label>
        <p className="flex items-center gap-1.5 text-sm text-ink-2">
          <Clock className="size-3.5" />
          決まった時刻
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>いつ</Label>
        <PillTabs tabs={REPEAT_TABS} value={kind} onChange={(v) => setKind(v as RepeatKind)} label="いつ" testId="automation-when" />
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          {kind === "weekly" ? (
            <Select value={String(day)} onValueChange={(v) => setDay(Number(v))}>
              <SelectTrigger className="h-8 w-24 text-xs" aria-label="曜日">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_LABELS.map((d, i) => (
                  <SelectItem key={d} value={String(i)}>
                    {d}曜
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {kind === "daily" || kind === "weekdays" || kind === "weekly" ? (
            <Input
              type="time"
              value={clock}
              onChange={(e) => setClock(e.target.value)}
              aria-label="時刻"
              required
              className="h-8 w-28 font-mono text-xs"
              data-testid="automation-time"
            />
          ) : null}
          {kind === "interval" ? (
            <>
              <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
                <SelectTrigger className="h-8 w-24 text-xs" aria-label="間隔">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {h} 時間
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>ごと</span>
            </>
          ) : null}
          {kind === "cron" ? (
            <Input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              aria-label="cron の式"
              className="h-8 w-40 font-mono text-xs"
              data-testid="automation-cron"
            />
          ) : null}
          <Select value={timeZone} onValueChange={setTimeZone}>
            <SelectTrigger className="h-8 w-56 text-xs" aria-label="タイムゾーン">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {timeZoneName(z)}（{z}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-ink-3" data-testid="automation-when-preview">
          {kind === "cron"
            ? "分 時 日 月 曜日 の5つ。間隔は最短15分です。"
            : `${describeRepeat(repeat)}（${timeZoneName(timeZone)}）に動きます。`}
        </p>
      </div>

      <Field id="automation-instruction" label="毎回届ける指示" hint="人が会話で頼むときと同じ書き方で。Memory と「AI への指示」もいつもどおり効きます">
        <Textarea
          id="automation-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          placeholder="昨日から今朝までに main に入ったコミットをまとめて"
        />
      </Field>

      <Field id="automation-name" label="名前" hint="専用の Fork の名前にもなります">
        <Input id="automation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="毎朝のまとめ" />
      </Field>

      <div className="flex flex-col gap-1.5">
        <Label id="automation-target-label">どの会話で動かすか</Label>
        <div role="radiogroup" aria-labelledby="automation-target-label" className="flex flex-col gap-1.5">
          <ModeOption
            checked={targetKind === "dedicated" && mode === "fresh"}
            onSelect={() => {
              setTargetKind("dedicated");
              setMode("fresh");
            }}
            title="専用の Fork で、毎回まっさら"
            body="届ける前に会話を Clear します。毎回同じことを新しく調べるものに。前の回の結果を使いたいときは、指示に「前回の結果は notes/○○.md にある。読んで比べ、最後に今回の結果を書き足して」のように書いてください。"
          />
          <ModeOption
            checked={targetKind === "dedicated" && mode === "continue"}
            onSelect={() => {
              setTargetKind("dedicated");
              setMode("continue");
            }}
            title="専用の Fork で、前の回を引き継ぐ"
            body="同じ会話に積みます。前の回のやり取りをそのまま覚えていてほしいものに。回を重ねるほど会話が長くなり、そのぶん毎回の読み直しが重くなります。"
          />
          <ModeOption
            checked={targetKind === "thread"}
            onSelect={() => setTargetKind("thread")}
            title="いまある会話に届ける"
            body="選んだ会話に、人の発言と同じように積みます。Clear しません。その会話で進めている話の続きとして動かしたいときに。"
          >
            {targetKind === "thread" ? (
              <Select value={threadId} onValueChange={setThreadId}>
                <SelectTrigger className="mt-1.5 h-8 w-64 text-xs" aria-label="届ける会話">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {threads.map((th) => (
                    <SelectItem key={th.id} value={th.id}>
                      {th.kind === "base" ? "Base Thread" : th.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </ModeOption>
        </div>
      </div>

      {targetKind === "dedicated" && mode === "continue" && kind === "interval" ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          時間ごとの自動化で引き継ぐと、1日で会話が長くなります。比べたいだけなら、まっさらにしてファイルに残させるほうが軽く済みます。
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Switch id="automation-review" checked={reviewOnDone} onCheckedChange={setReviewOnDone} />
          <Label htmlFor="automation-review">終わったら受信箱に出す</Label>
        </div>
        <p className="pl-11 text-xs text-ink-3">切っても、あなたの答えを待つ回・決めることがある回・失敗した回は受信箱に出します。</p>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-stop" data-testid="automation-form-error">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!filled || saving} data-testid="automation-submit">
          {automation ? "直す" : "足す"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={onDone}>
          やめる
        </Button>
      </div>
    </form>
  );
}

function ModeOption({
  checked,
  onSelect,
  title,
  body,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("rounded-md border px-3 py-2 transition-colors", checked ? "border-primary bg-surface-2" : "border-border hover:bg-surface-2/60")}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        onClick={onSelect}
        className="flex w-full items-start gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className={cn("mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border", checked ? "border-primary" : "border-ink-3")}>
          {checked ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <span className="text-xs text-ink-2">{body}</span>
        </span>
      </button>
      {children ? <div className="pl-6">{children}</div> : null}
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}
