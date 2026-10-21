"use client";

// **番頭の写し**（決定・2026-10-21、v4-frontend.md §6.54。追加・Backlog #511）。番頭は host の自動化4件の束（アーキ仕様 §4.5）で、
// 画面は「最後に host から聞いた一覧と方針」を持つだけ（規則3）。取るのは番頭を見る面（番頭の画面・受信箱）が初めて描かれたとき。
// そのあとは出来事の流れで取り直す（自動化の写しと同じ、`automations.ts`）：
//   automations.changed（番頭の自動化も含む——置いた・止めた・回を書いた・記録を書いた）→ 一覧を取り直す
//   hello（繋ぎ直した）→ 取り直す
// 記録と1日のまとめは面が自分で取る。一覧を取り直すたびに `version` が進むので、それを見て取り直す。

import { useEffect, useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import {
  getRealSupervisorPolicy,
  listRealSupervisors,
  type RealSupervisor,
  type RealSupervisorAct,
  type RealSupervisorGuard,
  type RealSupervisorPolicy,
} from "./client";
import { reportFailure } from "@/lib/report-failure";
import { SUPERVISOR_LABEL } from "@/lib/supervisor-label";

export interface SupervisorsState {
  supervisors: readonly RealSupervisor[];
  guard?: RealSupervisorGuard;
  /** 取り直した回数（記録・まとめを取り直す合図） */
  version: number;
}

let state: SupervisorsState | undefined;
let loading: Promise<void> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** 全体の方針（行いの題つき）と、Project ごとの効いている方針 */
let instancePolicy: RealSupervisorPolicy | undefined;
let projectPolicies: ReadonlyMap<string, RealSupervisorPolicy> = new Map();
const listeners = new Set<() => void>();
let wired = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    // 一度も見ていなければ取らない。出来事は続けて来るので、少し待って1回にまとめる
    if ((event.type === "automations.changed" || event.type === "hello") && state) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshSupervisors().catch(() => undefined);
      }, 300);
    }
  });
  startRealAppEvents();
}

/** 一覧を取り直す。失敗は呼んだ側に返し、ここでも知らせる（黙らない、規則2） */
export function refreshSupervisors(): Promise<void> {
  wire();
  if (loading) return loading;
  loading = listRealSupervisors()
    .then((body) => {
      state = { supervisors: body.supervisors, ...(body.guard ? { guard: body.guard } : {}), version: (state?.version ?? 0) + 1 };
      notify();
    })
    .catch((err: unknown) => {
      reportFailure(`${SUPERVISOR_LABEL}の一覧を読み込めませんでした`, err);
      throw err;
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

/** 番頭の一覧と守りの今。`load` なら、まだ取っていなければ取りに行く。取れるまでは undefined */
export function useSupervisors(load = true): SupervisorsState | undefined {
  const value = useSyncExternalStore(subscribe, () => state, () => undefined);
  useEffect(() => {
    if (load && !state) void refreshSupervisors().catch(() => undefined);
  }, [load]);
  return value;
}

/** 操作の応答で返ってきた番頭で、写しを置き換える（流れてくる知らせでも取り直される） */
export function replaceSupervisor(next: RealSupervisor): void {
  if (!state) return;
  const at = state.supervisors.findIndex((s) => s.id === next.id);
  state = {
    ...state,
    supervisors: at >= 0 ? state.supervisors.map((s, i) => (i === at ? next : s)) : [...state.supervisors, next],
  };
  notify();
}

// ---- 方針 ----

export async function refreshSupervisorPolicy(projectId?: string): Promise<RealSupervisorPolicy> {
  const policy = await getRealSupervisorPolicy(projectId);
  notePolicy(projectId, policy);
  return policy;
}

/** host が返した方針を覚える。全体を変えたら Project の効いている方針も変わるので、覚えていた分は捨てる */
export function notePolicy(projectId: string | undefined, policy: RealSupervisorPolicy): void {
  if (projectId) projectPolicies = new Map(projectPolicies).set(projectId, policy);
  else {
    instancePolicy = policy;
    projectPolicies = new Map();
  }
  notify();
}

/** 全体の方針（行いの題つき）。取れるまでは undefined */
export function useSupervisorPolicy(load = true): RealSupervisorPolicy | undefined {
  const value = useSyncExternalStore(subscribe, () => instancePolicy, () => undefined);
  useEffect(() => {
    if (load && !instancePolicy) {
      refreshSupervisorPolicy().catch((err: unknown) => reportFailure(`${SUPERVISOR_LABEL}の方針を読み込めませんでした`, err));
    }
  }, [load]);
  return value;
}

/** その Project で効いている方針（Project の層の値つき）。`projectId` が無ければ取らない */
export function useProjectSupervisorPolicy(projectId: string | undefined): RealSupervisorPolicy | undefined {
  const value = useSyncExternalStore(subscribe, () => (projectId ? projectPolicies.get(projectId) : undefined), () => undefined);
  useEffect(() => {
    if (projectId && !projectPolicies.has(projectId)) {
      refreshSupervisorPolicy(projectId).catch((err: unknown) => reportFailure(`${SUPERVISOR_LABEL}の方針を読み込めませんでした`, err));
    }
  }, [projectId, value]);
  return value;
}

// ---- 文にする（画面・受信箱・会話で同じ言い方にする） ----

/** 行い・問いの種類の短い呼び名。題が引けなければ名前のまま */
export function kindShortTitle(kind: string, policy: Pick<RealSupervisorPolicy, "catalog"> | undefined): string {
  const c = policy?.catalog;
  return c?.actions.find((a) => a.action === kind)?.short ?? c?.humanOnly.find((k) => k.kind === kind)?.short ?? kind;
}

/** 行い・問いの種類の説明（長いほう） */
export function kindTitle(kind: string, policy: Pick<RealSupervisorPolicy, "catalog"> | undefined): string {
  const c = policy?.catalog;
  return c?.actions.find((a) => a.action === kind)?.title ?? c?.humanOnly.find((k) => k.kind === kind)?.title ?? kind;
}

/** 人に回す種類か（どの方針でも番頭は答えない） */
export function isHumanOnlyKind(kind: string, policy: Pick<RealSupervisorPolicy, "catalog"> | undefined): boolean {
  return policy?.catalog.humanOnly.some((k) => k.kind === kind) ?? ["spec", "publish", "money", "destructive"].includes(kind);
}

/** 記録の種類の呼び名（絞り込みの選び先と行の頭） */
export const ACT_KIND_LABEL: Readonly<Record<RealSupervisorAct["kind"], string>> = {
  answered: "選んだ",
  instructed: "頼んだ",
  "factory-started": "Factory に流した",
  "factory-answered": "Factory に答えた",
  deferred: "人に回した",
  dropped: "捨てた",
  refused: "断られた",
  skipped: "回を飛ばした",
  undone: "人が取り消した",
};

/** 記録1件の「したこと」（理由は別に出す） */
export function describeAct(act: RealSupervisorAct, policy: Pick<RealSupervisorPolicy, "catalog"> | undefined): string {
  const q = act.question !== undefined ? `問い ${act.question}：` : "";
  switch (act.kind) {
    case "answered":
      return `${q}「${act.label ?? "?"}」を選んだ`;
    case "instructed":
      return `「${act.action ? kindShortTitle(act.action, policy) : "?"}」を頼んだ${act.hasNote ? "（補足つき）" : ""}`;
    case "factory-started":
      return `Factory に流した（${(act.items ?? []).join("・") || "?"}）`;
    case "factory-answered":
      return `Factory に答えた（${act.item ?? "?"}・${act.stage ?? "?"}：${act.action ?? "?"}）`;
    case "deferred":
      return `${q}人に回した`;
    case "dropped":
      return `頼んだ「${act.action ? kindShortTitle(act.action, policy) : "?"}」を捨てた`;
    case "refused":
      return `${q}断られた${act.action ? `（${kindShortTitle(act.action, policy)}）` : act.decisionKind ? `（${kindShortTitle(act.decisionKind, policy)}）` : ""}`;
    case "skipped":
      return "回を飛ばした";
    case "undone":
      return "人が取り消した";
  }
}

/** 番頭の今の様子。目立たせるのは人に回しているとき（上限・閾値）と全部止めているとき */
export function supervisorStatus(s: Pick<RealSupervisor, "paused" | "pausedReason" | "stoppedAll" | "handedToHuman">): {
  tone: "ok" | "attention" | "muted";
  text: string;
} {
  if (s.stoppedAll) return { tone: "attention", text: "全部止めたので止まっています" };
  if (s.paused) return { tone: "muted", text: `一時停止しています${s.pausedReason ? `（${s.pausedReason}）` : ""}` };
  if (s.handedToHuman) return { tone: "attention", text: s.handedToHuman };
  return { tone: "ok", text: "動いています" };
}

/** 最後に起きた時刻（回か記録の新しいほう）。まだ何も無ければ undefined */
export function lastActivityAt(s: Pick<RealSupervisor, "automations" | "acts">): string | undefined {
  const times = [...s.automations.flatMap((a) => (a.runs[0] ? [a.runs[0].at] : [])), ...(s.acts[0] ? [s.acts[0].at] : [])];
  return times.sort().at(-1);
}

/** その Thread が番頭の会話なら、その番頭（写しにあれば） */
export function supervisorOfThread(threadId: string): RealSupervisor | undefined {
  return state?.supervisors.find((s) => s.threadId === threadId);
}
