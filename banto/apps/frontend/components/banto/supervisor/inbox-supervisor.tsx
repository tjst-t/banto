"use client";

// **受信箱の番頭の部分**（v4-frontend.md §6.54「受信箱」、アーキ仕様 §4.5「記録」「取り消し」。実装・Backlog #511）。受信箱のカード
// （§6.41）の形に乗せる：
// - 見出しに、番頭が動いていることの印と「番頭を全部止める」
// - 決めることの問いごとに種類（`kind`）の小さな札と、番頭が答えられないわけ（番頭のいる Project だけ）
// - 番頭が決めた・人に回した・答えきれなかった（判断役の「人に任せました」と見分ける）。番頭の頼みで進めたターンには
//   「番頭の頼み（〈行いの題〉）で進めました——理由」
// - 「取り消す」：押すと番頭の記録からその決め・頼みを引き、短い文の欄を開く。送ると元の会話に人の発言として届く
import { useState } from "react";
import { CheckCheck, Hand, RotateCcw, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listRealSupervisorLog, type RealReviewJudge, type RealSupervisorLogEntry } from "@/lib/backend/client";
import {
  isHumanOnlyKind,
  kindShortTitle,
  kindTitle,
  useProjectSupervisorPolicy,
  useSupervisorPolicy,
  useSupervisors,
} from "@/lib/backend/supervisors";
import { describeFailure } from "@/lib/report-failure";
import { SUPERVISOR_LABEL as L } from "@/lib/supervisor-label";
import { cn } from "@/lib/utils";
import { useStopAllSupervisors } from "./stop-all";
import { defaultUndoText, UndoControl } from "./undo";

/** 見出しの印と「番頭を全部止める」。番頭が1つも無ければ何も出さない */
export function SupervisorInboxHead({ onOpenSupervisor }: { onOpenSupervisor?: () => void }) {
  const state = useSupervisors();
  const stopAll = useStopAllSupervisors();
  if (!state || state.supervisors.length === 0) return null;
  const stopped = state.guard?.stoppedAll ?? false;
  const running = state.supervisors.filter((s) => !s.paused).length;
  return (
    <>
      <button
        type="button"
        onClick={onOpenSupervisor}
        data-testid="inbox-supervisor-mark"
        title={`${L}の画面を開く`}
        className={cn(
          "hidden items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-accent sm:inline-flex",
          stopped ? "font-medium text-turn" : "text-ink-2",
        )}
      >
        <UserCheck className="size-3.5" />
        {stopped ? `${L}を全部止めています` : `${L}が ${running} 件動いています`}
      </button>
      {stopped ? null : (
        <Button type="button" size="xs" disabled={stopAll.busy} onClick={() => stopAll.request("stop")} data-testid="inbox-supervisor-stop-all">
          {`${L}を全部止める`}
        </Button>
      )}
      {stopAll.dialog}
    </>
  );
}

/** 問いの種類の札 */
export function DecisionKindBadge({ kind }: { kind: string }) {
  const policy = useSupervisorPolicy();
  const human = isHumanOnlyKind(kind, policy);
  return (
    <span
      data-testid="inbox-decision-kind"
      data-kind={kind}
      title={kindTitle(kind, policy)}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-xs",
        human ? "border-turn/50 text-turn" : "border-border text-ink-2",
      )}
    >
      {kindShortTitle(kind, policy)}
    </span>
  );
}

/**
 * **番頭がその問いに答えられないわけ**（番頭のいる Project だけ）。host の断りと同じ順：外から来た文を読んだターン・種類が無い・人に回す
 * 種類・その Project で任せていない行い。答えられるなら何も出さない
 */
export function SupervisorCannotAnswer({ projectId, kind, readExternal }: { projectId: string | undefined; kind: string | undefined; readExternal: boolean }) {
  const state = useSupervisors();
  const supervised = projectId !== undefined && (state?.supervisors.some((s) => s.projectId === projectId) ?? false);
  const instance = useSupervisorPolicy(supervised);
  const effective = useProjectSupervisorPolicy(supervised ? projectId : undefined);
  if (!supervised) return null;
  let why: string | undefined;
  if (readExternal) why = "外から来た文を読んだターンです";
  else if (kind === undefined || kind === "") why = "種類が書かれていません";
  else if (isHumanOnlyKind(kind, instance)) why = `${kindShortTitle(kind, instance)}に当たります`;
  else if (effective && !(effective.delegate as readonly string[]).includes(kind)) why = `この Project では「${kindShortTitle(kind, instance)}」を任せていません`;
  if (!why) return null;
  return (
    <p data-testid="inbox-supervisor-cannot" className="mt-1 text-xs text-ink-3">
      {`${L}は答えられません：${why}`}
    </p>
  );
}

/** 番頭のカードの印（判断役の `JudgeNote` の番頭版）。`judge.by === "supervisor"` のものと、番頭の頼み（`instructed`）を出す */
export function SupervisorJudgeNote({ judge, carried, threadId }: { judge: RealReviewJudge | undefined; carried: RealReviewJudge | undefined; threadId: string }) {
  const own = judge?.by === "supervisor" ? judge : undefined;
  const fromCarried = carried?.by === "supervisor" ? carried : undefined;
  if (!own && !fromCarried) return null;
  const answers = (j: RealReviewJudge) => j.answers ?? [];
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      {fromCarried?.kind === "instructed" ? (
        <InstructedLine judge={fromCarried} threadId={threadId} testId="inbox-supervisor-carried" />
      ) : fromCarried?.kind === "decided-by-automation" ? (
        <p data-testid="inbox-supervisor-carried" className="flex items-start gap-1.5 text-ink-2">
          <CheckCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            {`前のターンで、${L}が`}
            {answers(fromCarried)
              .map((a) => `「${a.label}」を選んで進めました（${a.reason}）`)
              .join("。")}
          </span>
        </p>
      ) : null}
      {own?.kind === "decided-by-automation" ? (
        <div data-testid="inbox-supervisor-judge" data-kind={own.kind} className="rounded-md bg-surface-2 px-3 py-2">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <CheckCheck className="size-4 shrink-0 text-primary" />
            {`${L}が決めました`}
          </p>
          <ul className="mt-1 space-y-0.5 text-ink-2">
            {answers(own).map((a) => (
              <li key={a.question} data-testid="inbox-supervisor-answer">
                「{a.label}」——{a.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-3">元の会話の AI は、この答えで進めています。</p>
          <JudgeUndo threadId={threadId} judge={own} />
        </div>
      ) : own?.kind === "deferred" ? (
        <p data-testid="inbox-supervisor-judge" data-kind={own.kind} className="flex items-start gap-1.5 text-ink-2">
          <Hand className="mt-0.5 size-4 shrink-0 text-turn" />
          <span>{`${L}は人に回しました：${own.reason ?? ""}`}</span>
        </p>
      ) : own?.kind === "incomplete" ? (
        <p data-testid="inbox-supervisor-judge" data-kind={own.kind} className="flex items-start gap-1.5 text-ink-2">
          <Hand className="mt-0.5 size-4 shrink-0 text-turn" />
          <span>{`${L}は答えきれずに人に回しました（${own.total ?? "?"} 問中 ${own.answered ?? 0} 問）。あなたが決めてください`}</span>
        </p>
      ) : own?.kind === "instructed" ? (
        <InstructedLine judge={own} threadId={threadId} testId="inbox-supervisor-judge" />
      ) : null}
    </div>
  );
}

function InstructedLine({ judge, threadId, testId }: { judge: RealReviewJudge; threadId: string; testId: string }) {
  return (
    <div data-testid={testId} data-kind="instructed" className="rounded-md bg-surface-2 px-3 py-2 text-ink-2">
      <p className="flex items-start gap-1.5">
        <UserCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>{`${L}の頼み（${judge.instruction?.title ?? judge.instruction?.action ?? "?"}）で進めました——${judge.reason ?? ""}`}</span>
      </p>
      <JudgeUndo threadId={threadId} judge={judge} />
    </div>
  );
}

/** カードの「取り消す」。押してからその会話の番頭の記録を引き、このカードの決め・頼みに当たるものを取り消す */
function JudgeUndo({ threadId, judge }: { threadId: string; judge: RealReviewJudge }) {
  const policy = useSupervisorPolicy();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; entry: RealSupervisorLogEntry; all: RealSupervisorLogEntry[] }
    | { kind: "message"; text: string }
  >({ kind: "idle" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const all = await listRealSupervisorLog({ thread: threadId, kinds: ["answered", "instructed"] });
      const entry = matchAct(all, judge);
      if (!entry) setState({ kind: "message", text: "記録が見つからないので取り消せません" });
      else if (!entry.undoable) setState({ kind: "message", text: entry.undoneBy ? "もう取り消しました" : "これは取り消せません" });
      else setState({ kind: "ready", entry, all });
    } catch (err) {
      setState({ kind: "message", text: `記録を読めませんでした：${describeFailure(err)}` });
    }
  }

  if (state.kind === "ready") {
    return (
      <div className="mt-2">
        <UndoControl act={state.entry} initialText={defaultUndoText(state.entry, state.all, policy)} onUndone={() => undefined} startOpen />
      </div>
    );
  }
  if (state.kind === "message") return <p className="mt-1.5 text-xs text-ink-3" data-testid="inbox-supervisor-undo-message">{state.text}</p>;
  return (
    <div className="mt-2">
      <Button type="button" size="xs" variant="outline" disabled={state.kind === "loading"} onClick={() => void load()} data-testid="inbox-supervisor-undo">
        <RotateCcw />
        取り消す
      </Button>
    </div>
  );
}

/**
 * カードの決め・頼みに当たる記録。頼みは指示の id で、選んだ答えは同じ問い・選択肢のうち時刻がいちばん近いもの（カードは記録の id を
 * 持たない——記録の id は host が読むたびに付ける）
 */
export function matchAct(all: readonly RealSupervisorLogEntry[], judge: RealReviewJudge): RealSupervisorLogEntry | undefined {
  if (judge.kind === "instructed") return all.find((a) => a.kind === "instructed" && a.actionId === judge.instruction?.actionId);
  const first = judge.answers?.[0];
  if (!first) return undefined;
  const at = Date.parse(judge.at);
  return all
    .filter((a) => a.kind === "answered" && a.question === first.question && a.choice === first.choice && a.label === first.label)
    .sort((x, y) => Math.abs(Date.parse(x.at) - at) - Math.abs(Date.parse(y.at) - at))[0];
}
