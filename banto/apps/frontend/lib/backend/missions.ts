"use client";

// **会話の任務**（追加・2026-10-20、v4-frontend.md §6.47、アーキ仕様 §4.4「任務」）。
//
// 会話のヘッダの「任務」の札と面・サイドバーの Thread の行の下の1行・受信箱の「枠を延ばす」に出す。真実は host（Event Store の
// `mission.*` を畳んだ Thread の任務）。画面は出来事の流れで写しを持つだけ（規則3、`rate-limit-waits.ts` と同じ形）：
//   hello → その時点の一覧で**丸ごと置き換える**／mission.changed → その Thread の分を置き換える
// 画面から変えた（延ばす・止める・起こす・始める）ときは、host の返事でも置き換える（流れより先に画面へ返るので）

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import type { RealMission } from "./client";

let byThread: ReadonlyMap<string, RealMission> = new Map();
const listeners = new Set<() => void>();
let wired = false;

function set(next: ReadonlyMap<string, RealMission>): void {
  byThread = next;
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（`real-projects-bootstrap.tsx`）——hello を取り逃さないため */
export function wireMissions(): void {
  wire();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      set(new Map((event.missions ?? []).map((m) => [m.threadId, m.mission] as const)));
    } else if (event.type === "mission.changed") {
      noteMission(event.threadId, event.mission);
    }
  });
  startRealAppEvents();
}

/** host が返した今の任務で置き換える（画面から変えたとき） */
export function noteMission(threadId: string, mission: RealMission): void {
  const next = new Map(byThread);
  next.set(threadId, mission);
  set(next);
}

function subscribe(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Thread の任務（終わった任務も、次を始めるまで残る）。1度も始めていなければ undefined */
export function useThreadMission(threadId: string | undefined): RealMission | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? byThread.get(threadId) : undefined),
    () => undefined,
  );
}

/** 人に返っていて、人が延ばすか終えるかを決める任務（枠を使い切った・止まっている） */
export function missionNeedsHuman(m: RealMission): boolean {
  return m.status === "exhausted" || m.status === "stalled";
}

/** 札・サイドバーの1行を出す任務（動いている・人に返っている）。終わった・止めた任務は出さない */
export function missionIsOpen(m: RealMission | undefined): m is RealMission {
  return m !== undefined && (m.status === "active" || missionNeedsHuman(m));
}

/** 状態の言葉（面の見出し・受信箱の結末） */
export const MISSION_STATUS_TEXT: Record<RealMission["status"], string> = {
  active: "動いています",
  done: "任務が終わりました",
  "gave-up": "任務をあきらめました",
  exhausted: "枠を使い切りました",
  stalled: "止まっています",
  stopped: "止めました",
};

/** 起きたきっかけの言葉 */
export const MISSION_CAUSE_TEXT: Record<RealMission["history"][number]["cause"], string> = {
  time: "予約の時刻",
  event: "待っていた出来事",
  "event-timeout": "出来事が来ないまま待つ上限",
  human: "人が起こした",
};

/** 起きた回の結果の言葉 */
export const MISSION_RESULT_TEXT: Record<NonNullable<RealMission["history"][number]["result"]>, string> = {
  done: "何も無く終わった",
  decisions: "決めることを出した",
  waiting: "人の答えを待っている",
  failed: "失敗した",
};

/** 時刻を「10/21 10:30」で（今日なら「10:30」） */
export function shortTimeOf(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** 待っている出来事の呼び名（題が無ければ名前） */
export function awaitedEventOf(m: RealMission): string | undefined {
  const e = m.followup?.event;
  return e ? (e.title ?? e.name) : undefined;
}

/**
 * **サイドバーの1行**（§6.47）。「任務：次は 10:30（3/20）」「任務：〈出来事の題〉を待っています」「任務：枠を使い切りました」
 * 「任務：止まっています」。予約がまだ無い（起きた回が動いている）なら「任務：動いています（3/20）」
 */
export function missionLineOf(m: RealMission, now: number = Date.now()): string {
  const count = `${m.wakes}/${m.frame.maxWakes}`;
  if (m.status !== "active") return `任務：${MISSION_STATUS_TEXT[m.status]}`;
  const f = m.followup;
  if (f?.at) return `任務：次は ${shortTimeOf(f.at, now)}（${count}）`;
  const awaited = awaitedEventOf(m);
  if (awaited) return `任務：${awaited}を待っています`;
  return `任務：動いています（${count}）`;
}
