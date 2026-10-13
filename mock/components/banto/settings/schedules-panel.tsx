"use client";

// Project の設定「予定」（決定・2026-10-13、ユーザー。`lib/mock/schedules.ts`）。
//
// - 1行に1つの予定：名前・いつ・起こし方・次の時刻、その下に直近の回の印（古い→新しい）と前の回の結果
// - 押すと開く：届ける指示・作った人・直近の回の理由つき一覧・操作（会話を開く・今すぐ走らせる・止める・直す・消す）
// - 人を待っている回は人の番の色（turn）。飛ばした回は理由を隠さず出す
// - 作る・直すはその場のフォーム（ダイアログにしない）。起こし方の既定は「毎回まっさら」
import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  CalendarClock,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Hand,
  Loader2,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { cn } from "@/lib/utils";
import {
  TIME_ZONES,
  describeRepeat,
  getSchedules,
  hasScheduleThread,
  removeSchedule,
  runScheduleNow,
  saveSchedule,
  setSchedulePaused,
  timeZoneLabel,
  type MockSchedule,
  type ScheduleInput,
  type ScheduleRepeat,
  type ScheduleRun,
} from "@/lib/mock/schedules";
import { useMockStoreVersion } from "@/lib/mock/store-events";

export function SchedulesPanel({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const schedules = getSchedules(projectId);
  const [editing, setEditing] = useState<"new" | string | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="schedules">
      <p className="text-sm text-ink-2">
        決まった時刻に、この Project の AI を動かします。予定ごとに専用の Fork があり、時刻が来るとそこへ指示を届けます。動いた回の会話はその
        Fork に残ります。
      </p>

      {schedules.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
          {schedules.map((s) =>
            editing === s.id ? (
              <li key={s.id} className="p-3">
                <ScheduleForm projectId={projectId} schedule={s} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <ScheduleRow key={s.id} schedule={s} onEdit={() => setEditing(s.id)} />
            ),
          )}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-ink-3">
          まだ予定はありません。毎朝のまとめや定期の見張りなど、決まった時刻にやらせたいことを足してください。会話で AI に「毎朝9時に〜して」と頼んでも作れます。
        </p>
      )}

      {editing === "new" ? (
        <div className="rounded-md border border-border bg-card p-3">
          <ScheduleForm projectId={projectId} onDone={() => setEditing(null)} />
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-fit gap-1 text-xs"
          onClick={() => setEditing("new")}
          data-testid="schedule-add"
        >
          <Plus className="size-3.5" />
          予定を作る
        </Button>
      )}

      <HowItRuns />
    </div>
  );
}

/** 動き方の決まり。作る前に読める位置に置く */
function HowItRuns() {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5 text-xs text-ink-2">
      <p className="mb-1.5 font-medium text-foreground">予定の動き方</p>
      <ul className="flex list-disc flex-col gap-1 pl-4">
        <li>前の回がまだ動いている・あなたの答えを待っているときは、その回を飛ばします。</li>
        <li>banto が止まっていた間の時刻は、起き直したときに一番最近の1回だけ動かし、古いものは捨てます。</li>
        <li>
          確認が要る操作に当たったら、あなたの答えを待って止まります。「承認をすべて自動で許可する」がオンなら止まりません。
        </li>
        <li>動いたことは受信箱には出さず、サイドバーの Fork の名前を太字にして知らせます。受信箱に出るのは、あなたの答えが要るときだけです。</li>
      </ul>
    </div>
  );
}

function ScheduleRow({ schedule: s, onEdit }: { schedule: MockSchedule; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const last = s.runs[0];

  return (
    <li data-testid={`schedule-${s.id}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <CalendarClock className={cn("mt-0.5 size-4 shrink-0", s.paused ? "text-ink-3" : "text-primary")} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className={cn("font-medium", s.paused ? "text-ink-2" : "text-foreground")}>{s.name}</span>
            {s.paused ? <span className="text-xs text-ink-3">一時停止中</span> : null}
          </p>
          <p className="text-xs text-ink-2">
            {describeRepeat(s.repeat)}
            <span className="text-ink-3">（{timeZoneLabel(s.timeZone)}）</span>
            <span className="mx-1.5 text-ink-3">/</span>
            {s.mode === "fresh" ? "毎回まっさら" : "前の回を引き継ぐ"}
            {s.paused ? null : (
              <>
                <span className="mx-1.5 text-ink-3">/</span>
                次は {s.nextRun}
              </>
            )}
          </p>
          {last ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <RunStrip runs={s.runs} />
              <LastRun run={last} />
            </div>
          ) : (
            <p className="text-xs text-ink-3">まだ動いていません</p>
          )}
        </div>
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-3 pb-3 pl-10">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-ink-3">毎回届ける指示</p>
            <blockquote className="rounded-md bg-surface-2 px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-2">
              {s.instruction}
            </blockquote>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">起こし方</dt>
            <dd className="text-ink-2">
              {s.mode === "fresh"
                ? "毎回まっさら——起こす前に会話を Clear します。前の回の会話は Fork の中で横線の上に残ります。"
                : "前の回を引き継ぐ——同じ会話に積みます。長くなると自動で要約されます。"}
            </dd>
            <dt className="text-ink-3">作った人</dt>
            <dd className="text-ink-2">
              {s.createdBy.kind === "human"
                ? "あなた"
                : `AI（${s.createdBy.threadTitle} で頼まれ、あなたが許可しました）`}
            </dd>
          </dl>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-ink-3">直近の回</p>
            <ul className="flex flex-col gap-1">
              {s.runs.map((r, i) => (
                <li key={`${r.at}-${i}`} className="flex items-start gap-2 text-xs">
                  <RunIcon run={r} className="mt-px size-3.5 shrink-0" />
                  <span className="w-20 shrink-0 text-ink-3">{r.at}</span>
                  <span className={cn(r.result === "waiting" ? "text-turn" : "text-ink-2")}>
                    {runLabel(r)}
                    {r.note ? <span className="text-ink-3">——{r.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {confirmRemove ? (
            <div className="flex flex-col gap-2 rounded-md bg-stop-soft px-3 py-2.5 text-xs">
              <p className="text-foreground">予定「{s.name}」を消します。</p>
              <p className="text-ink-2">専用の Fork とその会話は残ります。要らなければ Fork を閉じてください。</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  onClick={() => removeSchedule(s.id)}
                >
                  予定を消す
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmRemove(false)}>
                  やめる
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {hasScheduleThread(s) ? (
                <Button asChild variant="outline" size="sm" className="h-7 gap-1 text-xs">
                  <Link href={`/p/${s.projectId}?fork=${s.threadId}`}>
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
                onClick={() => runScheduleNow(s.id)}
                disabled={last?.result === "running" || last?.result === "waiting"}
                title={last?.result === "waiting" ? "前の回があなたの答えを待っています" : undefined}
              >
                <Play className="size-3.5" />
                今すぐ動かす
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => setSchedulePaused(s.id, !s.paused)}
              >
                {s.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {s.paused ? "再開する" : "一時停止"}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={onEdit}>
                <Pencil className="size-3.5" />
                直す
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-ink-3 hover:text-stop"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 className="size-3.5" />
                消す
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function runLabel(r: ScheduleRun): string {
  switch (r.result) {
    case "done":
      return "終わりました";
    case "skipped":
      return "飛ばしました";
    case "waiting":
      return "あなたの答えを待っています";
    case "failed":
      return "途中で止まりました";
    case "running":
      return "動いています";
  }
}

function RunIcon({ run, className }: { run: ScheduleRun; className?: string }) {
  switch (run.result) {
    case "done":
      return <CircleCheck className={cn(className, "text-ok")} />;
    case "skipped":
      return <CircleDashed className={cn(className, "text-ink-3")} />;
    case "waiting":
      return <Hand className={cn(className, "text-turn")} />;
    case "failed":
      return <CircleX className={cn(className, "text-stop")} />;
    case "running":
      return <Loader2 className={cn(className, "animate-spin text-primary motion-reduce:animate-none")} />;
  }
}

/** 直近の回の印を古い→新しいの順に1列で。色だけに頼らず形も変える（飛ばした回は中抜き） */
function RunStrip({ runs }: { runs: readonly ScheduleRun[] }) {
  const shown = runs.slice(0, 8).reverse();
  return (
    <span className="flex items-center gap-1" aria-label={`直近の ${shown.length} 回`}>
      {shown.map((r, i) => (
        <span
          key={`${r.at}-${i}`}
          title={`${r.at}：${runLabel(r)}`}
          className={cn(
            "block size-2 rounded-xs border",
            r.result === "done" && "border-ok bg-ok-soft",
            r.result === "skipped" && "border-dashed border-ink-3",
            r.result === "waiting" && "border-turn bg-turn",
            r.result === "failed" && "border-stop bg-stop-soft",
            r.result === "running" && "animate-pulse border-primary motion-reduce:animate-none",
          )}
        />
      ))}
    </span>
  );
}

function LastRun({ run }: { run: ScheduleRun }) {
  return (
    <span className={cn("text-xs", run.result === "waiting" ? "text-turn" : "text-ink-3")}>
      前の回（{run.at}）：{runLabel(run)}
    </span>
  );
}

type RepeatKind = ScheduleRepeat["kind"];

const REPEAT_CHOICES: readonly { value: RepeatKind; label: ReactNode }[] = [
  { value: "daily", label: "毎日" },
  { value: "weekdays", label: "平日" },
  { value: "weekly", label: "毎週" },
  { value: "interval", label: "時間ごと" },
  { value: "cron", label: "cron の式" },
];

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;

function ScheduleForm({
  projectId,
  schedule,
  onDone,
}: {
  projectId: string;
  schedule?: MockSchedule;
  onDone: () => void;
}) {
  const initial = schedule?.repeat;
  const [name, setName] = useState(schedule?.name ?? "");
  const [instruction, setInstruction] = useState(schedule?.instruction ?? "");
  const [kind, setKind] = useState<RepeatKind>(initial?.kind ?? "daily");
  const [time, setTime] = useState(initial && "time" in initial ? initial.time : "9:00");
  const [day, setDay] = useState(initial?.kind === "weekly" ? initial.day : 1);
  const [hours, setHours] = useState(initial?.kind === "interval" ? initial.hours : 1);
  const [cron, setCron] = useState(initial?.kind === "cron" ? initial.expr : "0 9 * * 1-5");
  // 既定は作った人のブラウザのタイムゾーン（banto の機械の時計は UTC のことがある）
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? "Asia/Tokyo");
  const [mode, setMode] = useState<"fresh" | "continue">(schedule?.mode ?? "fresh");

  const repeat: ScheduleRepeat =
    kind === "daily"
      ? { kind, time }
      : kind === "weekdays"
        ? { kind, time }
        : kind === "weekly"
          ? { kind, day, time }
          : kind === "interval"
            ? { kind, hours }
            : { kind, expr: cron };
  const filled = name.trim() && instruction.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!filled) return;
    const input: ScheduleInput = { name: name.trim(), instruction: instruction.trim(), repeat, timeZone, mode };
    saveSchedule(projectId, input, schedule?.id);
    onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="schedule-form">
      <p className="text-sm font-medium text-foreground">{schedule ? `予定「${schedule.name}」を直す` : "予定を作る"}</p>

      <Field id="sch-name" label="名前" hint="専用の Fork の名前にもなります">
        <Input id="sch-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="毎朝のまとめ" />
      </Field>

      <Field id="sch-instruction" label="毎回届ける指示" hint="人が会話で頼むときと同じ書き方で。Memory と「AI への指示」もいつもどおり効きます">
        <Textarea
          id="sch-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          placeholder="昨日から今朝までに main に入ったコミットをまとめて"
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <Label id="sch-when-label">いつ</Label>
        <ChoicePills choices={REPEAT_CHOICES} value={kind} onChange={setKind} labelledBy="sch-when-label" testId="sch-when" />
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
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="時刻"
              className="h-8 w-20 font-mono text-xs"
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
            />
          ) : null}
          <Select value={timeZone} onValueChange={setTimeZone}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label="タイムゾーン">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_ZONES.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-ink-3">
          {kind === "cron"
            ? "分 時 日 月 曜日 の5つ。間隔は最短15分です。"
            : `${describeRepeat(repeat)}（${timeZoneLabel(timeZone)}）に動きます。`}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label id="sch-mode-label">起こし方</Label>
        <div role="radiogroup" aria-labelledby="sch-mode-label" className="flex flex-col gap-1.5">
          <ModeOption
            checked={mode === "fresh"}
            onSelect={() => setMode("fresh")}
            title="毎回まっさら"
            body="起こす前に会話を Clear します。毎回同じことを新しく調べる予定に。前の回の結果を使いたいときは、指示に「前回の結果は notes/○○.md にある。読んで比べ、最後に今回の結果を書き足して」のように書いてください。"
          />
          <ModeOption
            checked={mode === "continue"}
            onSelect={() => setMode("continue")}
            title="前の回を引き継ぐ"
            body="同じ会話に積みます。前の回のやり取りをそのまま覚えていてほしい予定に。回を重ねるほど会話が長くなり、そのぶん毎回の読み直しが重くなります。"
          />
        </div>
      </div>

      {mode === "continue" && kind === "interval" ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          時間ごとの予定で引き継ぐと、1日で会話が長くなります。比べたいだけなら、まっさらにしてファイルに残させるほうが軽く済みます。
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!filled}>
          {schedule ? "直す" : "予定を作る"}
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
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        checked ? "border-primary bg-surface-2" : "border-border hover:bg-surface-2/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-ink-3",
        )}
      >
        {checked ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-ink-2">{body}</span>
      </span>
    </button>
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
