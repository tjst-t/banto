import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import type {
  InboxReadModel,
  JudgmentItem,
  JudgmentSource,
  NoticeClaudeAccounts,
  NoticeRuntimeKey,
  ReviewAutomation,
  ReviewJudge,
  ReviewMission,
} from "./types.js";

export type InboxEvent =
  | {
      type: "inbox.judgment_raised";
      payload: {
        id: string;
        threadId: string;
        source: JudgmentSource;
        message: string;
        mode?: "form" | "url";
        requestedSchema?: unknown;
        url?: string;
        toolCallId?: string;
        withinToolCallId?: string;
        toolInput?: unknown;
        serverName?: string;
        choices?: string[];
      };
    }
  | { type: "inbox.judgment_answered"; payload: { id: string; answer: unknown } }
  | { type: "inbox.judgment_timed_out"; payload: { id: string } }
  | {
      type: "inbox.review_raised";
      payload: {
        id: string;
        threadId: string;
        summary: string;
        automation?: Omit<ReviewAutomation, "raisedSeq">;
        carriedJudge?: ReviewJudge;
        mission?: ReviewMission;
      };
    }
  | { type: "inbox.review_acknowledged"; payload: { id: string } }
  // 開いているカードに任務の結末を添えた（時計の刻みで期限を過ぎて止めた、追加・2026-10-20、アーキ仕様 §4.4「受信箱」）
  | { type: "inbox.review_mission_set"; payload: { id: string; summary: string; mission: ReviewMission } }
  | { type: "inbox.review_judged"; payload: { id: string; judge: ReviewJudge } }
  | {
      type: "inbox.notice_raised";
      payload: {
        id: string;
        projectId?: string;
        threadId?: string;
        dedupeKey: string;
        title: string;
        detail: string;
        resume?: { threadId: string; turnId: string };
        runtimeKey?: NoticeRuntimeKey;
        claudeAccounts?: NoticeClaudeAccounts;
      };
    }
  | { type: "inbox.notice_acknowledged"; payload: { id: string } };

export const inboxFold: Fold<InboxReadModel> = {
  initial: () => ({ items: new Map() }),
  apply(state, raw: StoredEvent): InboxReadModel {
    const event = raw as unknown as InboxEvent & { ts: string };
    const items = new Map(state.items);

    switch (event.type) {
      case "inbox.judgment_raised": {
        const item: JudgmentItem = {
          kind: "judgment",
          id: event.payload.id,
          threadId: event.payload.threadId,
          source: event.payload.source,
          message: event.payload.message,
          mode: event.payload.mode,
          requestedSchema: event.payload.requestedSchema,
          url: event.payload.url,
          toolCallId: event.payload.toolCallId,
          ...(event.payload.withinToolCallId ? { withinToolCallId: event.payload.withinToolCallId } : {}),
          toolInput: event.payload.toolInput,
          serverName: event.payload.serverName,
          ...(event.payload.choices ? { choices: event.payload.choices } : {}),
          liveness: "live",
          createdAt: raw.ts,
        };
        items.set(item.id, item);
        return { items };
      }
      case "inbox.judgment_answered": {
        const existing = items.get(event.payload.id);
        if (existing && existing.kind === "judgment") {
          items.set(existing.id, { ...existing, liveness: "answered", answer: event.payload.answer });
        }
        return { items };
      }
      case "inbox.judgment_timed_out": {
        const existing = items.get(event.payload.id);
        // 生きている間にしかタイムアウトは適用しない——既に答えたものを
        // タイムアウト表示にしない（イベント順序が入れ替わっても壊れないように）。
        if (existing && existing.kind === "judgment" && existing.liveness === "live") {
          items.set(existing.id, { ...existing, liveness: "timed_out" });
        }
        return { items };
      }
      case "inbox.review_raised": {
        items.set(event.payload.id, {
          kind: "review",
          id: event.payload.id,
          threadId: event.payload.threadId,
          summary: event.payload.summary,
          ...(event.payload.automation ? { automation: { ...event.payload.automation, raisedSeq: raw.seq } } : {}),
          ...(event.payload.carriedJudge ? { carriedJudge: event.payload.carriedJudge } : {}),
          ...(event.payload.mission ? { mission: event.payload.mission } : {}),
          acknowledged: false,
          createdAt: raw.ts,
        });
        return { items };
      }
      case "inbox.review_acknowledged": {
        const existing = items.get(event.payload.id);
        if (existing && existing.kind === "review") {
          items.set(existing.id, { ...existing, acknowledged: true });
        }
        return { items };
      }
      case "inbox.review_mission_set": {
        const existing = items.get(event.payload.id);
        if (existing && existing.kind === "review") {
          items.set(existing.id, { ...existing, summary: event.payload.summary, mission: event.payload.mission });
        }
        return { items };
      }
      case "inbox.review_judged": {
        const existing = items.get(event.payload.id);
        if (existing && existing.kind === "review") items.set(existing.id, { ...existing, judge: event.payload.judge });
        return { items };
      }
      case "inbox.notice_raised": {
        items.set(event.payload.id, {
          kind: "notice",
          id: event.payload.id,
          projectId: event.payload.projectId,
          ...(event.payload.threadId ? { threadId: event.payload.threadId } : {}),
          dedupeKey: event.payload.dedupeKey,
          title: event.payload.title,
          detail: event.payload.detail,
          ...(event.payload.resume ? { resume: event.payload.resume } : {}),
          ...(event.payload.runtimeKey ? { runtimeKey: event.payload.runtimeKey } : {}),
          ...(event.payload.claudeAccounts ? { claudeAccounts: event.payload.claudeAccounts } : {}),
          acknowledged: false,
          createdAt: raw.ts,
        });
        return { items };
      }
      case "inbox.notice_acknowledged": {
        const existing = items.get(event.payload.id);
        if (existing && existing.kind === "notice") {
          items.set(existing.id, { ...existing, acknowledged: true });
        }
        return { items };
      }
      default:
        return state;
    }
  },
};
