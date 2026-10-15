// docs/specs/v4-architecture.md §4.3「置き場——core」の台帳。読み書きは画面（HTTP）からも AI の tool からもここを通る
// ——入力の確かめをここに1つ置く（どちらの口から来ても同じ決まりで断る）。

import { randomUUID } from "node:crypto";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import {
  automationFold,
  type Automation,
  type AutomationCreatedBy,
  type AutomationFields,
  type AutomationReadModel,
  type AutomationRepeat,
  type AutomationRun,
  type AutomationSource,
  type AutomationTarget,
} from "./fold.js";

/** 入力が決まりに合わない（画面・AI に理由をそのまま返す） */
export class AutomationInputError extends Error {}
export class AutomationNotFoundError extends Error {}

const NAME_MAX = 120;
const INSTRUCTION_MAX = 20_000;
/** 「N 時間ごと」の上限（1週間）。間隔の最短15分は時間の単位では下回れない */
const INTERVAL_HOURS_MAX = 168;
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export class AutomationStore {
  private readonly projection: SnapshotProjection<AutomationReadModel>;

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "automations", log, automationFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  /** その Project の自動化（作った順） */
  list(projectId: string): Automation[] {
    return Array.from(this.projection.current.automations.values())
      .filter((a) => a.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Automation | undefined {
    return this.projection.current.automations.get(id);
  }

  async create(input: {
    projectId: string;
    createdBy: AutomationCreatedBy;
    fields: unknown;
  }): Promise<Automation> {
    const fields = parseAutomationFields(input.fields);
    const id = `auto-${randomUUID()}`;
    await this.append("automation.created", { id, projectId: input.projectId, createdBy: input.createdBy, ...fields });
    return this.mustGet(id);
  }

  /** 渡した欄だけ直す。何も渡さなければ断る */
  async update(id: string, changes: unknown): Promise<Automation> {
    const current = this.mustGet(id);
    const parsed = parseAutomationChanges(changes, current);
    await this.append("automation.updated", { id, changes: parsed });
    return this.mustGet(id);
  }

  async pause(id: string, reason?: string): Promise<Automation> {
    const current = this.mustGet(id);
    if (current.paused) return current;
    await this.append("automation.paused", { id, ...(reason ? { reason } : {}) });
    return this.mustGet(id);
  }

  async resume(id: string): Promise<Automation> {
    const current = this.mustGet(id);
    if (!current.paused) return current;
    await this.append("automation.resumed", { id });
    return this.mustGet(id);
  }

  async remove(id: string): Promise<void> {
    this.mustGet(id);
    await this.append("automation.removed", { id });
  }

  /**
   * **専用の Fork を入れる**（立てた・乗り換えた・閉じていたので立て直した）。人・AI の入力（`update`）からは入れられない
   * ——host が立てたものだけ
   */
  async setDedicatedThread(id: string, threadId: string): Promise<Automation> {
    const current = this.mustGet(id);
    if (current.target.kind !== "dedicated") throw new Error(`自動化 ${id} の届け先は専用の Fork ではありません`);
    await this.append("automation.updated", { id, changes: { target: { ...current.target, threadId } } });
    return this.mustGet(id);
  }

  /** 1回分の結果を残す。同じ `runId` を後でもう一度書くと置き換わる（running → done 等） */
  async recordRun(id: string, run: AutomationRun, receivedIds?: string[]): Promise<void> {
    this.mustGet(id);
    await this.append("automation.fired", { id, ...run, ...(receivedIds?.length ? { receivedIds } : {}) });
  }

  private mustGet(id: string): Automation {
    const a = this.get(id);
    if (!a) throw new AutomationNotFoundError(`自動化が見つかりません: ${id}`);
    return a;
  }

  private async append(type: string, payload: unknown): Promise<void> {
    const event = await this.log.append(type, payload);
    this.projection.applyOne(event);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseName(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new AutomationInputError("name（名前）が要ります");
  const name = v.trim();
  if (name.length > NAME_MAX) throw new AutomationInputError(`name は ${NAME_MAX} 文字までです`);
  return name;
}

function parseInstruction(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new AutomationInputError("instruction（毎回届ける指示）が要ります");
  if (v.length > INSTRUCTION_MAX) throw new AutomationInputError(`instruction は ${INSTRUCTION_MAX} 文字までです`);
  return v;
}

function parseTime(v: unknown): string {
  if (typeof v !== "string" || !TIME_PATTERN.test(v)) {
    throw new AutomationInputError("time は H:MM（24時間、例 9:00）で渡してください");
  }
  return v;
}

function parseRepeat(v: unknown): AutomationRepeat {
  if (!isRecord(v)) throw new AutomationInputError("source.repeat が要ります");
  switch (v.kind) {
    case "daily":
    case "weekdays":
      return { kind: v.kind, time: parseTime(v.time) };
    case "weekly":
      if (typeof v.day !== "number" || !Number.isInteger(v.day) || v.day < 0 || v.day > 6) {
        throw new AutomationInputError("weekly の day は 0（日曜）〜6（土曜）で渡してください");
      }
      return { kind: "weekly", day: v.day, time: parseTime(v.time) };
    case "interval":
      if (typeof v.hours !== "number" || !Number.isInteger(v.hours) || v.hours < 1 || v.hours > INTERVAL_HOURS_MAX) {
        throw new AutomationInputError(`interval の hours は 1〜${INTERVAL_HOURS_MAX} の整数で渡してください`);
      }
      return { kind: "interval", hours: v.hours };
    case "cron":
      // 式を読む部品は時計（Backlog `automation-clock`）と一緒に入る。読めない式を台帳に残さない（規則2）
      throw new AutomationInputError("cron の式はまだ使えません（毎日・平日・毎週・N 時間ごとを使ってください）");
    default:
      throw new AutomationInputError("source.repeat.kind は daily・weekdays・weekly・interval のどれかです");
  }
}

function parseTimeZone(v: unknown): string {
  if (typeof v !== "string" || v === "") throw new AutomationInputError("source.timeZone が要ります（例 Asia/Tokyo）");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
  } catch {
    throw new AutomationInputError(`知らないタイムゾーンです: ${v}`);
  }
  return v;
}

function parseSource(v: unknown): AutomationSource {
  if (!isRecord(v)) throw new AutomationInputError("source（きっかけ）が要ります");
  if (v.kind !== "time") throw new AutomationInputError("source.kind は今は time だけです");
  return { kind: "time", repeat: parseRepeat(v.repeat), timeZone: parseTimeZone(v.timeZone) };
}

/**
 * 届け先。専用の Fork の `threadId` は host が立てたあとに入れるもので、人・AI からは受けない
 * （届け先を既存の Thread に変えたいときは `thread` を使う）
 */
function parseTarget(v: unknown, current?: AutomationTarget): AutomationTarget {
  if (!isRecord(v)) throw new AutomationInputError("target（届け先）が要ります");
  if (v.kind === "dedicated") {
    if (v.mode !== "fresh" && v.mode !== "continue") {
      throw new AutomationInputError("target.mode は fresh（毎回まっさら）か continue（前の回を引き継ぐ）です");
    }
    const threadId = current?.kind === "dedicated" ? current.threadId : undefined;
    return { kind: "dedicated", mode: v.mode, ...(threadId ? { threadId } : {}) };
  }
  if (v.kind === "thread") {
    if (typeof v.threadId !== "string" || v.threadId === "") throw new AutomationInputError("target.threadId が要ります");
    return { kind: "thread", threadId: v.threadId };
  }
  throw new AutomationInputError("target.kind は dedicated か thread です");
}

function parseReviewOnDone(v: unknown): boolean {
  if (typeof v !== "boolean") throw new AutomationInputError("reviewOnDone は true か false で渡してください");
  return v;
}

export function parseAutomationFields(raw: unknown): AutomationFields {
  if (!isRecord(raw)) throw new AutomationInputError("自動化の中身はオブジェクトで渡してください");
  return {
    name: parseName(raw.name),
    instruction: parseInstruction(raw.instruction),
    source: parseSource(raw.source),
    target: parseTarget(raw.target ?? { kind: "dedicated", mode: "fresh" }),
    reviewOnDone: raw.reviewOnDone === undefined ? true : parseReviewOnDone(raw.reviewOnDone),
  };
}

function parseAutomationChanges(raw: unknown, current: Automation): Partial<AutomationFields> {
  if (!isRecord(raw)) throw new AutomationInputError("直す中身はオブジェクトで渡してください");
  const changes: Partial<AutomationFields> = {};
  if (raw.name !== undefined) changes.name = parseName(raw.name);
  if (raw.instruction !== undefined) changes.instruction = parseInstruction(raw.instruction);
  if (raw.source !== undefined) changes.source = parseSource(raw.source);
  if (raw.target !== undefined) changes.target = parseTarget(raw.target, current.target);
  if (raw.reviewOnDone !== undefined) changes.reviewOnDone = parseReviewOnDone(raw.reviewOnDone);
  if (Object.keys(changes).length === 0) {
    throw new AutomationInputError("直す欄がありません（name・instruction・source・target・reviewOnDone）");
  }
  return changes;
}
