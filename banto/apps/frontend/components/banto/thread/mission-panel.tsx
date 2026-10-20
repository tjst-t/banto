"use client";

// **任務の画面**（決定・2026-10-20、ユーザー。v4-frontend.md §6.47、仕組みはアーキ仕様 §4.4「任務」）。
//
// - ヘッダの題の横の「任務」の札。押すと任務の面（ポップオーバー、携帯は下からのシート）：目標・終わりの条件・枠・次の予約・
//   起きた記録と「今すぐ起こす」「枠を延ばす」「止める」
// - ヘッダの「…」の「任務にする」から開く、目標・終わりの条件・枠を書く小さなダイアログ
// - 枠の3つの欄は AI の start_mission のカードと同じ（起きる回数の上限（回）・期限（今から何日）・最短の間隔（分））。
//   受信箱の「枠を延ばす」も同じ欄を使う
// 枠を延ばせるのは人だけ（host の `PATCH /api/threads/:id/mission`）。真実は host の任務（`lib/backend/missions.ts` の写し）
import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  getRealMission,
  patchRealMission,
  startRealMission,
  wakeRealMission,
  type RealMission,
  type RealMissionFramePatch,
} from "@/lib/backend/client";
import {
  MISSION_CAUSE_TEXT,
  MISSION_RESULT_TEXT,
  MISSION_STATUS_TEXT,
  awaitedEventOf,
  missionIsOpen,
  missionNeedsHuman,
  noteMission,
  shortTimeOf,
  useThreadMission,
} from "@/lib/backend/missions";
import { parseFieldValue, type FormField } from "@/lib/form-fields";
import { cn } from "@/lib/utils";

const DAY = 24 * 60 * 60 * 1000;

/** 枠の3つの欄（host の start_mission のカードと同じ題・同じ上限） */
const FRAME_FIELDS: readonly FormField[] = [
  { name: "maxWakes", title: "起きる回数の上限（回）", type: "integer", minimum: 1, maximum: 100 },
  { name: "untilDays", title: "期限（今から何日）", type: "number", minimum: 0.1, maximum: 14 },
  // 下限は host が決める（ふだんは 15 分）。合わなければ host の理由を出す
  { name: "minInterval", title: "最短の間隔（分）", type: "integer", minimum: 0 },
];

type FrameTexts = Record<string, string>;

/** 欄の文字を枠にする。`untilDays` が既定のまま（`keepUntil`）なら期限は送らない——今の期限のまま */
function frameOf(texts: FrameTexts, keepUntil?: string): { patch: RealMissionFramePatch } | { problem: string } {
  const values: Record<string, number> = {};
  for (const f of FRAME_FIELDS) {
    const parsed = parseFieldValue(f, texts[f.name] ?? "");
    if ("problem" in parsed) return { problem: parsed.problem };
    values[f.name] = parsed.value;
  }
  const untilUnchanged = keepUntil !== undefined && texts.untilDays === keepUntil;
  return {
    patch: {
      maxWakes: values.maxWakes!,
      minInterval: values.minInterval!,
      ...(untilUnchanged ? {} : { until: new Date(Date.now() + values.untilDays! * DAY).toISOString() }),
    },
  };
}

/** 枠の3つの欄 */
function FrameFields({
  texts,
  onChange,
  disabled,
  testIdPrefix,
}: {
  texts: FrameTexts;
  onChange: (next: FrameTexts) => void;
  disabled?: boolean;
  testIdPrefix: string;
}) {
  return (
    <div className="grid grid-cols-[auto_7rem] items-center gap-x-3 gap-y-1.5">
      {FRAME_FIELDS.map((f) => (
        <label key={f.name} className="contents text-xs text-ink-2">
          <span>{f.title}</span>
          <Input
            data-testid={`${testIdPrefix}-${f.name}`}
            type="number"
            inputMode="decimal"
            {...(f.minimum !== undefined ? { min: f.minimum } : {})}
            {...(f.maximum !== undefined ? { max: f.maximum } : {})}
            step={f.type === "integer" ? 1 : "any"}
            value={texts[f.name] ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...texts, [f.name]: e.target.value })}
            className="h-8 text-sm"
          />
        </label>
      ))}
    </div>
  );
}

/** 残りの日数（0.1 日刻み）。過ぎていれば 1 日（延ばすときの既定） */
function remainingDays(until: string): string {
  const days = Math.round(((Date.parse(until) - Date.now()) / DAY) * 10) / 10;
  return String(days >= 0.1 ? days : 1);
}

/**
 * **枠を延ばす欄**（任務の面と受信箱で同じもの）。既定は今の枠——回数を使い切っていれば上限を 5 回足した値、期限を過ぎていれば
 * 今から 1 日。押すと動いている任務に戻る（host）
 */
export function MissionExtendForm({
  threadId,
  mission,
  onDone,
  onCancel,
}: {
  threadId: string;
  mission: RealMission;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  // 開いた時点の残り（描画のたびに時刻を読まない）
  const [{ initialDays, expired }] = useState(() => ({
    initialDays: remainingDays(mission.frame.until),
    expired: Date.parse(mission.frame.until) <= Date.now(),
  }));
  const [texts, setTexts] = useState<FrameTexts>(() => ({
    maxWakes: String(mission.wakes >= mission.frame.maxWakes ? Math.min(100, mission.frame.maxWakes + 5) : mission.frame.maxWakes),
    untilDays: initialDays,
    minInterval: String(mission.frame.minIntervalMinutes),
  }));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = frameOf(texts, expired ? undefined : initialDays);
  return (
    <div className="flex flex-col gap-2" data-testid="mission-extend">
      <FrameFields texts={texts} onChange={setTexts} disabled={sending} testIdPrefix="mission-extend-field" />
      {"problem" in frame ? (
        <p className="text-xs text-destructive" data-testid="mission-extend-problem">
          {frame.problem}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="mission-extend-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={sending || "problem" in frame}
          onClick={async () => {
            if ("problem" in frame) return;
            setSending(true);
            try {
              noteMission(threadId, await patchRealMission(threadId, frame.patch));
              setError(null);
              onDone?.();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSending(false);
            }
          }}
        >
          この枠に延ばす
        </Button>
        {onCancel ? (
          <Button size="sm" variant="outline" disabled={sending} onClick={onCancel}>
            やめる
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** 任務を止める（終える）。枠を使い切った・止まっている任務も止められる */
export async function stopMission(threadId: string): Promise<void> {
  noteMission(threadId, await patchRealMission(threadId, { stop: true }));
}

function nextOf(m: RealMission): string | undefined {
  const f = m.followup;
  if (!f) return undefined;
  if (f.at) return f.received ? `${shortTimeOf(f.at)}（「${f.received.title}」が来ました）` : shortTimeOf(f.at);
  const awaited = awaitedEventOf(m);
  return awaited && f.event ? `「${awaited}」を待っています（${shortTimeOf(f.event.until)} まで）` : undefined;
}

/** **任務の面の中身**（ヘッダの札・サイドバーの1行から開く） */
export function MissionPanel({ threadId, mission }: { threadId: string; mission: RealMission }) {
  const [extending, setExtending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = nextOf(mission);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const canExtend = mission.status === "active" || missionNeedsHuman(mission);
  return (
    <div className="flex flex-col gap-2.5 text-sm" data-testid="mission-panel" data-status={mission.status}>
      <p
        className={cn("text-xs font-medium", missionNeedsHuman(mission) ? "text-turn" : "text-ink-3")}
        data-testid="mission-panel-status"
      >
        任務・{MISSION_STATUS_TEXT[mission.status]}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-3">目標</dt>
        <dd className="text-foreground whitespace-pre-wrap" data-testid="mission-panel-goal">
          {mission.goal}
        </dd>
        <dt className="text-ink-3">終わりの条件</dt>
        <dd className="text-foreground whitespace-pre-wrap" data-testid="mission-panel-done-when">
          {mission.doneWhen}
        </dd>
        <dt className="text-ink-3">枠</dt>
        <dd className="text-foreground" data-testid="mission-panel-frame">
          {mission.wakes}/{mission.frame.maxWakes} 回・期限 {shortTimeOf(mission.frame.until)}・最短の間隔 {mission.frame.minIntervalMinutes} 分
        </dd>
        {mission.status === "active" ? (
          <>
            <dt className="text-ink-3">次の予約</dt>
            <dd className="text-foreground" data-testid="mission-panel-next">
              {next ?? "まだありません（いまの回が予約します）"}
              {mission.followup?.note ? (
                <span className="mt-0.5 line-clamp-3 block text-ink-2" data-testid="mission-panel-note">
                  {mission.followup.note}
                </span>
              ) : null}
            </dd>
          </>
        ) : mission.result ? (
          <>
            <dt className="text-ink-3">結果</dt>
            <dd className="text-foreground whitespace-pre-wrap" data-testid="mission-panel-result">
              {mission.result}
            </dd>
          </>
        ) : null}
      </dl>
      {mission.history.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs text-ink-3">起きた記録</p>
          <ul className="flex max-h-36 flex-col gap-0.5 overflow-y-auto" data-testid="mission-panel-history">
            {mission.history.map((h) => (
              <li key={h.wake} className="text-xs text-ink-2" data-testid="mission-panel-history-item">
                {h.wake} 回目・{shortTimeOf(h.at)}・{MISSION_CAUSE_TEXT[h.cause]}
                {h.result ? `・${MISSION_RESULT_TEXT[h.result]}` : "・動いています"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="mission-panel-error">
          {error}
        </p>
      ) : null}
      {extending ? (
        <MissionExtendForm
          threadId={threadId}
          mission={mission}
          onDone={() => setExtending(false)}
          onCancel={() => setExtending(false)}
        />
      ) : canExtend ? (
        <div className="flex flex-wrap gap-2">
          {mission.status === "active" ? (
            <Button size="sm" disabled={busy} onClick={() => void run(async () => noteMission(threadId, await wakeRealMission(threadId)))}>
              今すぐ起こす
            </Button>
          ) : null}
          <Button size="sm" variant={mission.status === "active" ? "outline" : "default"} disabled={busy} onClick={() => setExtending(true)}>
            枠を延ばす
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => stopMission(threadId))}>
            止める
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * **ヘッダの題の横の「任務」の札**。動いている・人に返っている（枠を使い切った・止まっている）任務があるときだけ。人に返って
 * いれば人の番の色。押すと任務の面（携帯は下からのシート）
 */
export function MissionBadge({ threadId }: { threadId: string }) {
  const mission = useThreadMission(threadId);
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  if (!missionIsOpen(mission)) return null;
  const human = missionNeedsHuman(mission);
  const trigger = (
    <button
      type="button"
      data-testid="mission-badge"
      data-status={mission.status}
      aria-label={`任務：${MISSION_STATUS_TEXT[mission.status]}（面を開く）`}
      onClick={isMobile ? () => setOpen(true) : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-none",
        human ? "border-turn bg-turn-soft font-medium text-turn" : "border-border text-ink-2 hover:bg-accent",
      )}
    >
      <Target className="size-3" />
      任務
    </button>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto px-4 pb-6">
            <SheetHeader className="px-0">
              <SheetTitle>任務</SheetTitle>
            </SheetHeader>
            <MissionPanel threadId={threadId} mission={mission} />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-3">
        <MissionPanel threadId={threadId} mission={mission} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * **この会話で任務を始められるか**（「…」の「任務にする」を出すか）。host が理由を返したら出さない（動いている任務がある・
 * 自動化の専用の Fork・読むだけの会話）。読めるまでは出さない
 */
export function useCanStartMission(threadId: string): boolean {
  const mission = useThreadMission(threadId);
  const [can, setCan] = useState(false);
  const status = mission?.status;
  useEffect(() => {
    let alive = true;
    getRealMission(threadId)
      .then((r) => alive && setCan(r.startRefused === undefined))
      .catch((err: unknown) => {
        // 読めなければ出さない（押しても通るか分からないものを見せない、規則13）
        console.warn(`[mission] ${threadId} の任務を読めませんでした:`, err);
        if (alive) setCan(false);
      });
    return () => {
      alive = false;
    };
  }, [threadId, status]);
  return can;
}

/** **「任務にする」のダイアログ**。目標・終わりの条件・枠を書いて始める（人が押しているので host は聞かない） */
export function StartMissionDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="mission-start-dialog" className="sm:max-w-md">
        {/* 欄は開くたびに既定から（中身は閉じると外れる） */}
        <StartMissionForm threadId={threadId} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function StartMissionForm({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [goal, setGoal] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [texts, setTexts] = useState<FrameTexts>({ maxWakes: "20", untilDays: "3", minInterval: "15" });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = frameOf(texts);
  const problem = goal.trim() === "" ? "目標を書いてください" : doneWhen.trim() === "" ? "終わりの条件を書いてください" : "problem" in frame ? frame.problem : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>任務にする</DialogTitle>
        <DialogDescription>
          会話をやめても、AI が予約した時刻・出来事で起きて続けます。枠（回数・期限・最短の間隔）を超えては起きません。
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          目標
          <Textarea data-testid="mission-start-goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} disabled={sending} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          終わりの条件
          <Textarea data-testid="mission-start-done-when" value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} rows={2} disabled={sending} />
        </label>
        <FrameFields texts={texts} onChange={setTexts} disabled={sending} testIdPrefix="mission-start-field" />
        {problem ? (
          <p className="text-xs text-ink-3" data-testid="mission-start-problem">
            {problem}
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive" data-testid="mission-start-error">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={sending} onClick={onClose}>
          やめる
        </Button>
        <Button
          disabled={sending || problem !== null}
          onClick={async () => {
            if ("problem" in frame) return;
            setSending(true);
            try {
              noteMission(threadId, await startRealMission(threadId, { goal: goal.trim(), doneWhen: doneWhen.trim(), ...frame.patch }));
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSending(false);
            }
          }}
        >
          始める
        </Button>
      </DialogFooter>
    </>
  );
}
