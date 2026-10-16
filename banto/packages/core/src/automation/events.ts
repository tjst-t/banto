// docs/specs/v4-architecture.md §4.3「段2：出来事をきっかけにする」——**Module が知らせた出来事を受け、待つ自動化に溜める**。
//
// - 受け口は host の中継の `relayEmitEvent`（`relay/host-relay-endpoint.ts`）。どの Project の出来事かは接続から決まる
//   （Module の申告は使わない）。ここでは宣言との照合・重複落とし・輪の止め方をして、条件に合う自動化に
//   `automation.received` を積み、まとめ役（`batcher.ts`、Webhook と共通）に渡す
// - **属性・`text`・`causedBy` は申告**（コンテナの中の AI は合言葉を読める）。信じるのは接続から決めた Project と宣言との
//   照合だけ。`causedBy` を省けばホップ 0 になるので、輪を止めるのは「同じ自動化・同じ出来事・同じ主体」の回数の歯止め
//   ——**歯止めは外せない**
// - **速さでは断らずにまとめる**。断るのは宣言違反だけ。溜める上限を超えた自動化には積まず、ログに残す
// - **待つ自動化が無い出来事も「受け取った」と返す**（残さない）——出口の箱を空けるため
// - **重複落としは消えない置き場に**：Project＋出どころごとに「見た `eventId` と時刻」を自動化の台帳とは別の fold に持ち、
//   7日で刈る。host を起こし直しても、箱からの出し直しを二度受けない
// - **始まりの印を持ち越す**：出来事を名乗る Module への AI のターンからの呼び出しだけ、呼び出しの印（`dev.banto/callId`）・
//   Thread・ターン・ホップ・そのターンが自動化の回ならその回を別の fold に残し、14日で刈る。出来事の `causedBy` から引けたら、
//   ホップ＋1・起こした Thread・起こした自動化の回を付ける。**自分の回が起こした出来事では、その自動化を起こさない**（既定）

import { randomUUID } from "node:crypto";
import {
  CORE_EVENT_SOURCE,
  EVENT_ID_MAX,
  EVENT_TEXT_MAX_BYTES,
  eventFieldsProblem,
  eventMatchesWhere,
  eventNameProblem,
  type EventDeclaration,
  type EventFieldValue,
} from "@banto/module-contract";
import type { EventLog, StoredEvent } from "../event-store/log.js";
import { SnapshotProjection, type Fold } from "../event-store/snapshot.js";
import type { Automation, AutomationReceivedEvent } from "./fold.js";
import type { AutomationStore } from "./store.js";
import type { AutomationRunner } from "./runner.js";
import { AutomationBatcher } from "./batcher.js";

/** 見た `eventId` を覚えておく日数 */
export const EVENT_SEEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 呼び出しの写しを覚えておく日数 */
export const EVENT_CALL_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * **同じ自動化が同じ出来事・同じ主体で起きるのは、この窓でこの回数まで**（アーキ仕様 §4.3「輪を止める」）。超えたら溜めずに
 * 飛ばし、理由を残す。**外せない**——自動化ごとの設定にしない
 */
export const EVENT_RATE = { windowMs: 60 * 60 * 1000, max: 6 } as const;

/** 自動化ごとに溜めておける件数（Webhook と同じ。超えた分はその自動化には積まずログに残す） */
export const EVENT_PENDING_MAX = 100;

/** 刈るのは、最後に刈ってからこれだけ時刻が進んだとき（fold を読み直すたびに全件を見ない） */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

// ---- 見た eventId（重複落とし） ----------------------------------------------------------------------------------

export interface EventSeenReadModel {
  /** `<projectId>\0<出どころ>\0<eventId>` → 見た時刻 */
  seen: Map<string, string>;
  prunedAt: string;
}

const seenKey = (projectId: string, source: string, eventId: string) => `${projectId}\0${source}\0${eventId}`;

/** fold は読み直しの速さのため、Map をその場で書き換える（状態を持つのは SnapshotProjection だけ） */
export const eventSeenFold: Fold<EventSeenReadModel> = {
  initial: () => ({ seen: new Map(), prunedAt: "" }),
  apply(state, raw: StoredEvent): EventSeenReadModel {
    if (raw.type !== "event.seen") return state;
    const p = raw.payload as { projectId: string; source: string; eventId: string };
    state.seen.set(seenKey(p.projectId, p.source, p.eventId), raw.ts);
    return prune(state, raw.ts, EVENT_SEEN_KEEP_MS, state.seen, (at) => at);
  },
};

// ---- 呼び出しの写し（輪を止める） ---------------------------------------------------------------------------------

/** 出来事を名乗る Module への、AI のターンからの呼び出し1件 */
export interface EventCallOrigin {
  callId: string;
  projectId: string;
  threadId: string;
  turnId?: string;
  /** その呼び出しをしたターンのホップ */
  hop: number;
  /** そのターンが自動化の回なら、その回 */
  automation?: { id: string; runId: string };
  at: string;
}

export interface EventCallReadModel {
  calls: Map<string, EventCallOrigin>;
  prunedAt: string;
}

export const eventCallFold: Fold<EventCallReadModel> = {
  initial: () => ({ calls: new Map(), prunedAt: "" }),
  apply(state, raw: StoredEvent): EventCallReadModel {
    if (raw.type !== "event.call_recorded") return state;
    const p = raw.payload as Omit<EventCallOrigin, "at">;
    state.calls.set(p.callId, { ...p, at: raw.ts });
    return prune(state, raw.ts, EVENT_CALL_KEEP_MS, state.calls, (c) => c.at);
  },
};

function prune<S extends { prunedAt: string }, V>(state: S, ts: string, keepMs: number, map: Map<string, V>, at: (v: V) => string): S {
  const now = Date.parse(ts);
  if (state.prunedAt && now - Date.parse(state.prunedAt) < PRUNE_EVERY_MS) return state;
  const cutoff = new Date(now - keepMs).toISOString();
  for (const [k, v] of map) if (at(v) < cutoff) map.delete(k);
  state.prunedAt = ts;
  return state;
}

/** 見た `eventId` と呼び出しの写しの置き場（自動化の台帳とも会話とも別の fold と snapshot） */
export class EventLedger {
  private readonly seen: SnapshotProjection<EventSeenReadModel>;
  private readonly calls: SnapshotProjection<EventCallReadModel>;

  constructor(dataDir: string, private readonly log: EventLog, private readonly now: () => Date = () => new Date()) {
    this.seen = new SnapshotProjection(dataDir, "automation-events-seen", log, eventSeenFold);
    this.calls = new SnapshotProjection(dataDir, "automation-event-calls", log, eventCallFold);
  }

  async load(): Promise<void> {
    await this.seen.load();
    await this.calls.load();
  }
  async save(): Promise<void> {
    await this.seen.save();
    await this.calls.save();
  }

  hasSeen(projectId: string, source: string, eventId: string): boolean {
    const at = this.seen.current.seen.get(seenKey(projectId, source, eventId));
    return at !== undefined && Date.parse(at) > this.now().getTime() - EVENT_SEEN_KEEP_MS;
  }

  async markSeen(projectId: string, source: string, eventId: string): Promise<void> {
    const event = await this.log.append("event.seen", { projectId, source, eventId });
    this.seen.applyOne(event);
  }

  async recordCall(origin: Omit<EventCallOrigin, "at">): Promise<void> {
    const event = await this.log.append("event.call_recorded", origin);
    this.calls.applyOne(event);
  }

  callOrigin(callId: string): EventCallOrigin | undefined {
    const c = this.calls.current.calls.get(callId);
    return c && Date.parse(c.at) > this.now().getTime() - EVENT_CALL_KEEP_MS ? c : undefined;
  }
}

// ---- 受ける ---------------------------------------------------------------------------------------------------

/** 出来事を出した呼び元（host が接続から決めたもの） */
export interface EventEmitter {
  projectId: string;
  /** 宣言の名前（出来事の名前の頭と一致しなければならない） */
  moduleName: string;
}

export type EmitEventReply = { accepted: true; duplicate?: true; queued: number } | { refused: string };

export interface AutomationEventsDeps {
  automations: AutomationStore;
  ledger: EventLedger;
  runner: Pick<AutomationRunner, "run">;
  /** ターンが終わった（届け先が空いたかもしれない）を聞く */
  onTurnEnded(listener: (threadId: string) => void): void;
  /** その Project で、その Module が名乗る出来事（宣言から。読めなければ投げる） */
  declaredEvents(projectId: string, moduleName: string): EventDeclaration[];
  /** Project が閉じているか（閉じている間は溜めない——受け取りはする） */
  projectClosed(projectId: string): boolean;
  now?: () => Date;
  log?: (message: string) => void;
  limits?: { pendingMax?: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class AutomationEvents {
  private readonly batcher: AutomationBatcher;
  /** 回数の歯止めの数え（`<自動化>\0<出来事名>\0<主体>` → 起こした時刻） */
  private readonly rate = new Map<string, number[]>();
  /** 受けている途中の eventId（同じものが同時に来ても二度積まない） */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: AutomationEventsDeps) {
    this.batcher = new AutomationBatcher("event", {
      automations: deps.automations,
      runner: deps.runner,
      onTurnEnded: deps.onTurnEnded,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
  }

  /** 溜まったものをまとめ直して届け始める（`resumeAll` と待ち受けの開始のあと） */
  start(): void {
    this.batcher.start();
  }

  stop(): void {
    this.batcher.stop();
  }

  /** **出来事を1件受ける**。宣言違反は断る（理由を返す）。それ以外は受け取った（待つ自動化が無くても）と返す */
  async receive(from: EventEmitter, raw: unknown): Promise<EmitEventReply> {
    if (!isRecord(raw)) return { refused: "出来事はオブジェクトで渡してください" };
    const nameProblem = eventNameProblem(raw.name, from.moduleName);
    if (nameProblem) return { refused: nameProblem };
    const name = raw.name as string;
    let declarations: EventDeclaration[];
    try {
      declarations = this.deps.declaredEvents(from.projectId, from.moduleName);
    } catch (err) {
      return { refused: `${from.moduleName} の出来事の名乗りが読めません：${err instanceof Error ? err.message : String(err)}` };
    }
    const declared = declarations.find((d) => d.name === name);
    if (!declared) return { refused: `${from.moduleName} は出来事 ${name} を名乗っていません` };
    if (typeof raw.eventId !== "string" || raw.eventId === "" || raw.eventId.length > EVENT_ID_MAX) {
      return { refused: `eventId（重複落としの印、${EVENT_ID_MAX} 字まで）が要ります` };
    }
    const eventId = raw.eventId;
    if (typeof raw.occurredAt !== "string" || !Number.isFinite(Date.parse(raw.occurredAt))) {
      return { refused: "occurredAt（起きた時刻、ISO 8601）が要ります" };
    }
    const fieldsProblem = eventFieldsProblem(declared, raw.fields);
    if (fieldsProblem) return { refused: fieldsProblem };
    const fields = (raw.fields ?? {}) as Record<string, EventFieldValue>;
    if (raw.text !== undefined && typeof raw.text !== "string") return { refused: "text は文字列で渡してください" };
    if (raw.causedBy !== undefined && !(isRecord(raw.causedBy) && typeof raw.causedBy.callId === "string")) {
      return { refused: "causedBy は { callId } で渡してください" };
    }

    const key = `${from.projectId}\0${from.moduleName}\0${eventId}`;
    if (this.inFlight.has(key) || this.deps.ledger.hasSeen(from.projectId, from.moduleName, eventId)) {
      return { accepted: true, duplicate: true, queued: 0 };
    }
    this.inFlight.add(key);
    try {
      const queued = await this.queue(from, declared, {
        eventId,
        occurredAt: raw.occurredAt,
        fields,
        ...(typeof raw.text === "string" ? { text: raw.text } : {}),
        ...(isRecord(raw.causedBy) ? { callId: raw.causedBy.callId as string } : {}),
      });
      // 見たことは積んだあとに残す——積む前に落ちたら、箱からの出し直しで受け直せる
      await this.deps.ledger.markSeen(from.projectId, from.moduleName, eventId);
      return { accepted: true, queued };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * **banto 自身の出来事を1件出す**（出どころ `banto`、アーキ仕様 §4.3「banto 自身」）。core が書くので照合は名乗りとの
   * 突き合わせだけ（合わなければ投げる——core の書き間違い）。起こしたターンは印を引かずに直に渡す（ホップ＋1・自分の回の判定）
   */
  async emitFromCore(
    projectId: string,
    declared: EventDeclaration,
    event: { eventId: string; occurredAt: string; fields: Record<string, EventFieldValue>; text?: string },
    causedBy?: Omit<EventCallOrigin, "callId" | "projectId" | "at">,
  ): Promise<number> {
    const problem = eventNameProblem(declared.name, CORE_EVENT_SOURCE) ?? eventFieldsProblem(declared, event.fields);
    if (problem) throw new Error(`banto の出来事 ${declared.name} の形が名乗りに合いません：${problem}`);
    const key = `${projectId}\0${CORE_EVENT_SOURCE}\0${event.eventId}`;
    if (this.inFlight.has(key) || this.deps.ledger.hasSeen(projectId, CORE_EVENT_SOURCE, event.eventId)) return 0;
    this.inFlight.add(key);
    try {
      const origin = causedBy ? { ...causedBy, projectId } : undefined;
      const queued = await this.queue({ projectId, moduleName: CORE_EVENT_SOURCE }, declared, event, origin);
      await this.deps.ledger.markSeen(projectId, CORE_EVENT_SOURCE, event.eventId);
      return queued;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** 条件に合う自動化に積む。積んだ数を返す */
  private async queue(
    from: EventEmitter,
    declared: EventDeclaration,
    event: { eventId: string; occurredAt: string; fields: Record<string, EventFieldValue>; text?: string; callId?: string },
    /** core が直に渡す起こしたターン（banto 自身の出来事）。無ければ `callId` から引く */
    direct?: Omit<EventCallOrigin, "callId" | "at">,
  ): Promise<number> {
    const waiting = this.deps.automations
      .list(from.projectId)
      .filter((a) => a.source.kind === "event" && a.source.event === declared.name && !a.paused && eventMatchesWhere(a.source.where, event.fields));
    if (waiting.length === 0 || this.deps.projectClosed(from.projectId)) return 0;

    // **始まりの印**：引けたらホップ＋1・起こした Thread・起こした自動化の回。印は申告なので、別の Project の呼び出しは引かない
    const origin = direct ?? (event.callId ? this.deps.ledger.callOrigin(event.callId) : undefined);
    const causedBy = origin && origin.projectId === from.projectId ? origin : undefined;
    const hop = causedBy ? causedBy.hop + 1 : 0;

    const now = this.now();
    let text = event.text;
    let truncatedFrom: number | undefined;
    if (text !== undefined) {
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length > EVENT_TEXT_MAX_BYTES) {
        truncatedFrom = bytes.length;
        text = bytes.subarray(0, EVENT_TEXT_MAX_BYTES).toString("utf8");
      }
    }
    const subject = declared.subject !== undefined ? String(event.fields[declared.subject] ?? "") : "";
    const pendingMax = this.deps.limits?.pendingMax ?? EVENT_PENDING_MAX;

    let queued = 0;
    for (const a of waiting) {
      // **自分の回のターンが起こした出来事では、その自動化を起こさない**（既定。自動化ごとに外せる）
      if (causedBy?.automation?.id === a.id && !(a.source.kind === "event" && a.source.allowSelfTriggered)) continue;
      const skipped = await this.overRate(a, declared, subject, now);
      if (skipped) continue;
      if (a.received.length >= pendingMax) {
        this.log(`[host] 自動化 ${a.id} は届けられずに溜まっているものが上限（${pendingMax} 件）なので、出来事 ${declared.name}（${event.eventId}）を積みませんでした`);
        continue;
      }
      const received: AutomationReceivedEvent = {
        kind: "event",
        receivedId: randomUUID(),
        at: now.toISOString(),
        name: declared.name,
        title: declared.title,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        fields: event.fields,
        ...(text !== undefined ? { text } : {}),
        ...(truncatedFrom !== undefined ? { truncatedFrom } : {}),
        hop,
        ...(causedBy ? { causedBy: { threadId: causedBy.threadId, ...(causedBy.turnId ? { turnId: causedBy.turnId } : {}) } } : {}),
      };
      await this.deps.automations.recordReceived(a.id, received);
      this.batcher.consider(a.id);
      queued++;
    }
    return queued;
  }

  /** **回数の歯止め**（自動化＋出来事名＋主体で 60分に6回）。超えたら飛ばした理由を台帳に残して true */
  private async overRate(a: Automation, declared: EventDeclaration, subject: string, now: Date): Promise<boolean> {
    const key = `${a.id}\0${declared.name}\0${subject}`;
    const since = now.getTime() - EVENT_RATE.windowMs;
    const times = (this.rate.get(key) ?? []).filter((t) => t > since);
    if (times.length >= EVENT_RATE.max) {
      this.rate.set(key, times);
      const who = declared.subject !== undefined ? `（${declared.fields[declared.subject]?.title ?? declared.subject}：${subject}）` : "";
      await this.deps.automations.recordRun(a.id, {
        runId: randomUUID(),
        at: now.toISOString(),
        cause: "event",
        result: "skipped",
        reason: `同じ出来事 ${declared.name}${who}で ${EVENT_RATE.windowMs / 60_000} 分に ${EVENT_RATE.max} 回動いたので、この回は飛ばしました（輪になっていないか確かめてください）`,
      });
      return true;
    }
    times.push(now.getTime());
    this.rate.set(key, times);
    return false;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}
