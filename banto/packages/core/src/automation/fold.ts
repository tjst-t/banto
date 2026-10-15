// docs/specs/v4-architecture.md §4.3「自動化」の台帳（決定・2026-10-15）。
//
// **project-thread の fold には入れない**——`automation.fired` は一番よく増える出来事なので、全 Thread の読み直しを
// 重くしない。`runtime-config` と同じく独立した fold と snapshot を持つ。Configuration（`config/runtime.ts`）は平らな
// 鍵と値で、履歴を持つ構造は載らない。

import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";

/** 直近の回は1件の自動化につき、これだけ fold に持つ。古いものは events.jsonl にだけ残る */
export const AUTOMATION_RUNS_KEPT = 50;

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
          runs: [],
          received: [],
        });
        break;
      }
      case "automation.updated":
        if (!current) return state;
        automations.set(current.id, { ...current, ...event.payload.changes, updatedAt: raw.ts });
        break;
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
        automations.set(current.id, { ...rest, paused: false });
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
        automations.set(current.id, { ...current, runs, received });
        break;
      }
      default:
        return state;
    }
    return { automations };
  },
};
