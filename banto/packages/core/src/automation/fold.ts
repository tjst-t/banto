// docs/specs/v4-architecture.md §4.3「自動化」の台帳（決定・2026-10-15）。
//
// **project-thread の fold には入れない**——`automation.fired` は一番よく増える出来事なので、全 Thread の読み直しを
// 重くしない。`runtime-config` と同じく独立した fold と snapshot を持つ。Configuration（`config/runtime.ts`）は平らな
// 鍵と値で、履歴を持つ構造は載らない。

import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";

/** 直近の回は1件の自動化につき、これだけ fold に持つ。古いものは events.jsonl にだけ残る */
export const AUTOMATION_RUNS_KEPT = 50;

/**
 * **専用の Fork はこの回数届けたら乗り換える**（アーキ仕様 §4.3「乗り換え」。仮置きの値・2026-10-15——困ったら変える）。
 * 毎回まっさらでも Clear のたびに会話の記録・印・手放したセッションが1本の Fork に積もる。1時間ごとなら2日で1本
 */
export const AUTOMATION_FORK_RUNS = 48;

/** 時刻の繰り返し。`time` は "H:MM"（24時間）、`day` は 0＝日曜 */
export type AutomationRepeat =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "interval"; hours: number }
  | { kind: "cron"; expr: string };

/** きっかけの出どころ。段1の Webhook は Backlog `automation-webhook` で足す */
export type AutomationSource = { kind: "time"; repeat: AutomationRepeat; timeZone: string };

/**
 * 届け先。`dedicated`＝自動化専用の Fork（`threadId` は Fork を立てたあとに入る——立てるのは Backlog
 * `automation-deliver`）。`thread`＝既存の Thread に Clear せずに
 */
export type AutomationTarget =
  | { kind: "dedicated"; mode: "fresh" | "continue"; threadId?: string }
  | { kind: "thread"; threadId: string };

export type AutomationCreatedBy = { kind: "human" } | { kind: "ai"; threadId: string };

/** 1回分の結果。`running` はターンを始めたところ（同じ `runId` の後の記録で置き換わる） */
export type AutomationRunResult = "running" | "done" | "failed" | "waiting" | "skipped" | "rejected";

/** 何で動いたか。`manual`＝今すぐ動かす */
export type AutomationRunCause = "clock" | "manual" | "webhook";

export interface AutomationRun {
  runId: string;
  at: string;
  cause: AutomationRunCause;
  result: AutomationRunResult;
  /** 飛ばした・断った・失敗した理由（人が読める文） */
  reason?: string;
  /** 届けた Thread */
  threadId?: string;
  /** この回で専用の Fork を乗り換えたなら、閉じた前の Fork（境目の記録） */
  rotatedFrom?: string;
  /** 時計で動いた回の、予定の時刻（`at` は実際に動いた時刻。ずらした・止まっていた間を取り戻した回は違う） */
  scheduledFor?: string;
  /** 同時に動いている自動化が多くてずらした理由（ずらした回だけ） */
  delayed?: string;
}

/** Webhook で受けて、まだ届けていないもの（`automation.received`） */
export interface AutomationReceived {
  receivedId: string;
  at: string;
  body: string;
}

/** 人と AI が作り・直せる欄 */
export interface AutomationFields {
  name: string;
  instruction: string;
  source: AutomationSource;
  target: AutomationTarget;
  /** 完了した回を受信箱に出すか（既定 true）。判断待ち・決めること・失敗した回は、これに依らずいつも出す */
  reviewOnDone: boolean;
}

export interface Automation extends AutomationFields {
  id: string;
  projectId: string;
  createdBy: AutomationCreatedBy;
  createdAt: string;
  updatedAt: string;
  paused: boolean;
  /** 一時停止した理由（人が押した・専用の Fork を閉じた等）。一時停止している間だけ持つ */
  pausedReason?: string;
  /** 新しい順、最大 `AUTOMATION_RUNS_KEPT` 件 */
  runs: AutomationRun[];
  /** 受けて、まだ届けていないもの（古い順） */
  received: AutomationReceived[];
  /**
   * いまの専用の Fork に届けた回数（乗り換えの数え、`AUTOMATION_FORK_RUNS`）。`runs` は 50 件で切れるので、そこから
   * 数え直さずに fold が数える。専用の Fork が変わると 0 から
   */
  threadRuns?: number;
  /**
   * **時計はこの時刻より後の回から数える**（止まっていた間の取り戻しの起点）。作った・きっかけを変えた・再開した時刻と、
   * 時計で動いた（飛ばした）回の予定の時刻のうち一番後
   */
  clockFrom: string;
}

export interface AutomationReadModel {
  automations: Map<string, Automation>;
}

export type AutomationEvent =
  | {
      type: "automation.created";
      payload: AutomationFields & { id: string; projectId: string; createdBy: AutomationCreatedBy };
    }
  | { type: "automation.updated"; payload: { id: string; changes: Partial<AutomationFields> } }
  | { type: "automation.paused"; payload: { id: string; reason?: string } }
  | { type: "automation.resumed"; payload: { id: string } }
  | { type: "automation.removed"; payload: { id: string } }
  | { type: "automation.received"; payload: { id: string } & AutomationReceived }
  | {
      type: "automation.fired";
      payload: { id: string } & AutomationRun & {
        /** この回で届けた `automation.received`（溜めていたものから外す） */
        receivedIds?: string[];
      };
    };

export const automationFold: Fold<AutomationReadModel> = {
  initial: () => ({ automations: new Map() }),
  apply(state, raw: StoredEvent): AutomationReadModel {
    const event = raw as unknown as AutomationEvent;
    if (!event.type.startsWith("automation.")) return state;
    const automations = new Map(state.automations);
    const current = "id" in event.payload ? automations.get(event.payload.id) : undefined;

    switch (event.type) {
      case "automation.created": {
        const { id, projectId, createdBy, ...fields } = event.payload;
        automations.set(id, {
          ...fields,
          id,
          projectId,
          createdBy,
          createdAt: raw.ts,
          updatedAt: raw.ts,
          paused: false,
          clockFrom: raw.ts,
          runs: [],
          received: [],
        });
        break;
      }
      case "automation.updated": {
        if (!current) return state;
        const next = { ...current, ...event.payload.changes, updatedAt: raw.ts };
        if (event.payload.changes.source) next.clockFrom = raw.ts;
        if (next.target.threadId !== current.target.threadId) next.threadRuns = 0;
        automations.set(current.id, next);
        break;
      }
      case "automation.paused": {
        if (!current) return state;
        const { pausedReason: _drop, ...rest } = current;
        automations.set(current.id, {
          ...rest,
          paused: true,
          ...(event.payload.reason ? { pausedReason: event.payload.reason } : {}),
        });
        break;
      }
      case "automation.resumed": {
        if (!current) return state;
        const { pausedReason: _drop, ...rest } = current;
        automations.set(current.id, { ...rest, paused: false, clockFrom: raw.ts });
        break;
      }
      case "automation.removed":
        if (!current) return state;
        automations.delete(current.id);
        break;
      case "automation.received": {
        if (!current) return state;
        const { id: _id, ...received } = event.payload;
        automations.set(current.id, { ...current, received: [...current.received, received] });
        break;
      }
      case "automation.fired": {
        if (!current) return state;
        const { id: _id, receivedIds, ...run } = event.payload;
        // 同じ回の後の記録（running → done 等）は置き換える。位置は最初に記録したところのまま
        const at = current.runs.findIndex((r) => r.runId === run.runId);
        const runs =
          at >= 0
            ? current.runs.map((r, i) => (i === at ? run : r))
            : [run, ...current.runs].slice(0, AUTOMATION_RUNS_KEPT);
        const consumed = new Set(receivedIds ?? []);
        const received = consumed.size > 0 ? current.received.filter((r) => !consumed.has(r.receivedId)) : current.received;
        // いまの専用の Fork に届けた回を数える（同じ回の後の記録・飛ばした回・断った回は数えない）
        const deliveredHere =
          at < 0 &&
          run.result !== "skipped" &&
          run.result !== "rejected" &&
          current.target.kind === "dedicated" &&
          run.threadId !== undefined &&
          run.threadId === current.target.threadId;
        const clockFrom = run.scheduledFor && run.scheduledFor > current.clockFrom ? run.scheduledFor : current.clockFrom;
        automations.set(current.id, {
          ...current,
          runs,
          received,
          clockFrom,
          ...(deliveredHere ? { threadRuns: (current.threadRuns ?? 0) + 1 } : {}),
        });
        break;
      }
      default:
        return state;
    }
    return { automations };
  },
};
