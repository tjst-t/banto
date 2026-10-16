// docs/specs/v4-architecture.md §4.3「置き場——core」の台帳。読み書きは画面（HTTP）からも AI の tool からもここを通る
// ——入力の確かめをここに1つ置く（どちらの口から来ても同じ決まりで断る）。

import { randomUUID } from "node:crypto";
import { eventWhereProblem, type EventDeclaration, type EventWhere } from "@banto/module-contract";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import {
  automationFold,
  type Automation,
  type AutomationCreatedBy,
  type AutomationFields,
  type AutomationReadModel,
  type AutomationReceived,
  type AutomationRepeat,
  type AutomationRun,
  type AutomationSignature,
  type AutomationSource,
  type AutomationTarget,
} from "./fold.js";
import { cronExpressionProblem } from "./schedule.js";

/** 入力が決まりに合わない（画面・AI に理由をそのまま返す） */
export class AutomationInputError extends Error {}
export class AutomationNotFoundError extends Error {}

const NAME_MAX = 120;
const INSTRUCTION_MAX = 20_000;
/** 「N 時間ごと」の上限（1週間）。間隔の最短15分は時間の単位では下回れない */
const INTERVAL_HOURS_MAX = 168;
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** Webhook のまとめる待ち時間の上限（5分）。0 は1件ずつ */
const WEBHOOK_BATCH_SECONDS_MAX = 300;
/** 既定の待ち時間（アーキ仕様 §4.3「まとめる」） */
export const WEBHOOK_BATCH_SECONDS_DEFAULT = 30;
/** 署名の入るヘッダの既定（GitHub・Gitea と同じ名前） */
export const WEBHOOK_SIGNATURE_HEADER_DEFAULT = "X-Hub-Signature-256";
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ALIAS_MAX = 200;
/** 出来事のまとめる待ち時間の既定（Webhook と同じ） */
export const EVENT_BATCH_SECONDS_DEFAULT = WEBHOOK_BATCH_SECONDS_DEFAULT;

/**
 * **台帳から Module の宣言を引く口**（アーキ仕様 §4.3「段2」の「条件」）。その Project で、出来事の名前を名乗っている
 * Module の名乗り。無ければ undefined（作るときに断る）
 */
export interface AutomationEventCatalog {
  find(projectId: string, name: string): EventDeclaration | undefined;
}

export class AutomationStore {
  private readonly projection: SnapshotProjection<AutomationReadModel>;
  private readonly listeners = new Set<(change: { projectId: string; id: string }) => void>();
  private eventCatalog: AutomationEventCatalog | undefined;

  constructor(dataDir: string, private readonly log: EventLog) {
    // 版 2：`clockFrom`（時計の数え始め）を足した
    this.projection = new SnapshotProjection(dataDir, "automations", log, automationFold, 2);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  /** 出来事のきっかけを作る・直すときに照らす名乗りの口（無ければ出来事のきっかけは作れない） */
  setEventCatalog(catalog: AutomationEventCatalog): void {
    this.eventCatalog = catalog;
  }

  /** その Project の自動化（作った順） */
  list(projectId: string): Automation[] {
    return Array.from(this.projection.current.automations.values())
      .filter((a) => a.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 全 Project の自動化（時計が見る） */
  listAll(): Automation[] {
    return Array.from(this.projection.current.automations.values());
  }

  get(id: string): Automation | undefined {
    return this.projection.current.automations.get(id);
  }

  /** **台帳が変わった**（作った・直した・止めた・消した・回を書いた）。開いている画面に知らせるのに使う */
  onChange(listener: (change: { projectId: string; id: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Webhook の受け口の印のハッシュから引く（`webhook.ts`） */
  findByWebhookTokenHash(hash: string): Automation | undefined {
    for (const a of this.projection.current.automations.values()) if (a.webhookTokenHash === hash) return a;
    return undefined;
  }

  /**
   * 作る。Webhook の自動化は受け口の印のハッシュ（`webhookTokenHash`）が要る——印を出すのは HTTP の口（作ったときに
   * 1回だけ人に見せる）なので、それを通らない作り方（AI の tool）は断る。`id` は渡せば使う（署名の鍵を先に置くため）
   */
  async create(input: {
    projectId: string;
    createdBy: AutomationCreatedBy;
    fields: unknown;
    id?: string;
    webhookTokenHash?: string;
  }): Promise<Automation> {
    const fields = parseAutomationFields(input.fields);
    if (fields.source.kind === "event") this.checkEventSource(input.projectId, fields.source);
    if (fields.source.kind === "webhook" && !input.webhookTokenHash) {
      throw new AutomationInputError("Webhook の自動化は自動化の画面から作ってください（受け口の URL はそこで1回だけ見せます）");
    }
    const id = input.id ?? newAutomationId();
    await this.append("automation.created", {
      id,
      projectId: input.projectId,
      createdBy: input.createdBy,
      ...fields,
      ...(fields.source.kind === "webhook" ? { webhookTokenHash: input.webhookTokenHash } : {}),
    });
    return this.mustGet(id);
  }

  /** 渡した欄だけ直す。何も渡さなければ断る */
  async update(id: string, changes: unknown): Promise<Automation> {
    const current = this.mustGet(id);
    const parsed = parseAutomationChanges(changes, current);
    if (parsed.source?.kind === "event") this.checkEventSource(current.projectId, parsed.source);
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

  /** Webhook で受けたものを残す（届けるまで溜める。届けた回の `automation.fired` の `receivedIds` で外れる） */
  async recordReceived(id: string, received: AutomationReceived): Promise<void> {
    this.mustGet(id);
    await this.append("automation.received", { id, ...received });
  }

  /** 出来事の名前が、その Project の Module に名乗られているか・条件が名乗りの属性に合うか */
  private checkEventSource(projectId: string, source: Extract<AutomationSource, { kind: "event" }>): void {
    if (!this.eventCatalog) throw new AutomationInputError("この banto は出来事のきっかけを受けられません");
    const declared = this.eventCatalog.find(projectId, source.event);
    if (!declared) {
      throw new AutomationInputError(`この Project には出来事 ${source.event} を名乗っている Module がありません`);
    }
    const problem = eventWhereProblem(declared, source.where);
    if (problem) throw new AutomationInputError(problem);
  }

  private mustGet(id: string): Automation {
    const a = this.get(id);
    if (!a) throw new AutomationNotFoundError(`自動化が見つかりません: ${id}`);
    return a;
  }

  private async append(type: string, payload: { id: string; projectId?: string; [key: string]: unknown }): Promise<void> {
    // 消したあとは台帳から引けないので、Project は書く前に控える
    const projectId = payload.projectId ?? this.get(payload.id)?.projectId;
    const event = await this.log.append(type, payload);
    this.projection.applyOne(event);
    if (!projectId) return;
    for (const listener of this.listeners) listener({ projectId, id: payload.id });
  }
}

/** 自動化の id（作る前に要るとき——Webhook の署名の鍵を先に置く） */
export function newAutomationId(): string {
  return `auto-${randomUUID()}`;
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

function parseRepeat(v: unknown, timeZone: string): AutomationRepeat {
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
    case "cron": {
      // 読めない式・15分より短い間隔を台帳に残さない（規則2）
      if (typeof v.expr !== "string") throw new AutomationInputError("cron の expr（式）が要ります（例 0 9 * * 1-5）");
      const expr = v.expr.trim().split(/\s+/).join(" ");
      const problem = cronExpressionProblem(expr, timeZone);
      if (problem) throw new AutomationInputError(problem);
      return { kind: "cron", expr };
    }
    default:
      throw new AutomationInputError("source.repeat.kind は daily・weekdays・weekly・interval・cron のどれかです");
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

function parseSignature(v: unknown): AutomationSignature | undefined {
  // 既定はオン——確かめないなら false と明示する（書き忘れで誰でも動かせる口にしない）
  if (v === false || v === null) return undefined;
  if (!isRecord(v)) {
    throw new AutomationInputError("source.signature（署名の確かめ方）が要ります。確かめないなら false を渡してください");
  }
  const header = v.header === undefined ? WEBHOOK_SIGNATURE_HEADER_DEFAULT : v.header;
  if (typeof header !== "string" || !HEADER_PATTERN.test(header)) {
    throw new AutomationInputError("signature.header はヘッダの名前（英数字とハイフン、64文字まで）で渡してください");
  }
  if (typeof v.alias !== "string" || v.alias.trim() === "" || v.alias.length > ALIAS_MAX) {
    throw new AutomationInputError("signature.alias（署名の鍵の Vault の alias）が要ります");
  }
  return { header, alias: v.alias.trim() };
}

function parseSource(v: unknown): AutomationSource {
  if (!isRecord(v)) throw new AutomationInputError("source（きっかけ）が要ります");
  if (v.kind === "webhook") {
    const batch = v.batchSeconds === undefined ? WEBHOOK_BATCH_SECONDS_DEFAULT : v.batchSeconds;
    if (typeof batch !== "number" || !Number.isInteger(batch) || batch < 0 || batch > WEBHOOK_BATCH_SECONDS_MAX) {
      throw new AutomationInputError(`batchSeconds は 0〜${WEBHOOK_BATCH_SECONDS_MAX} の整数（秒）で渡してください`);
    }
    if (v.allowProjectContainer !== undefined && typeof v.allowProjectContainer !== "boolean") {
      throw new AutomationInputError("allowProjectContainer は true か false で渡してください");
    }
    const signature = parseSignature(v.signature);
    return {
      kind: "webhook",
      ...(signature ? { signature } : {}),
      batchSeconds: batch,
      allowProjectContainer: v.allowProjectContainer === true,
    };
  }
  if (v.kind === "event") {
    // 出来事の名前と条件の中身は台帳の名乗りと照らす（`checkEventSource`）。ここでは形だけ
    if (typeof v.event !== "string" || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(v.event)) {
      throw new AutomationInputError("source.event（出来事の名前、<出どころ>.<名前>）が要ります");
    }
    const batch = v.batchSeconds === undefined ? EVENT_BATCH_SECONDS_DEFAULT : v.batchSeconds;
    if (typeof batch !== "number" || !Number.isInteger(batch) || batch < 0 || batch > WEBHOOK_BATCH_SECONDS_MAX) {
      throw new AutomationInputError(`batchSeconds は 0〜${WEBHOOK_BATCH_SECONDS_MAX} の整数（秒）で渡してください`);
    }
    if (v.allowSelfTriggered !== undefined && typeof v.allowSelfTriggered !== "boolean") {
      throw new AutomationInputError("allowSelfTriggered は true か false で渡してください");
    }
    if (v.where !== undefined && !isRecord(v.where)) {
      throw new AutomationInputError("source.where は属性の名前ごとの値（か値の配列）で渡してください");
    }
    const where = v.where as EventWhere | undefined;
    return {
      kind: "event",
      event: v.event,
      ...(where && Object.keys(where).length > 0 ? { where } : {}),
      batchSeconds: batch,
      allowSelfTriggered: v.allowSelfTriggered === true,
    };
  }
  if (v.kind !== "time") throw new AutomationInputError("source.kind は time（決まった時刻）・webhook・event（出来事）のどれかです");
  const timeZone = parseTimeZone(v.timeZone);
  return { kind: "time", repeat: parseRepeat(v.repeat, timeZone), timeZone };
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

export function parseAutomationChanges(raw: unknown, current: Automation): Partial<AutomationFields> {
  if (!isRecord(raw)) throw new AutomationInputError("直す中身はオブジェクトで渡してください");
  const changes: Partial<AutomationFields> = {};
  if (raw.name !== undefined) changes.name = parseName(raw.name);
  if (raw.instruction !== undefined) changes.instruction = parseInstruction(raw.instruction);
  if (raw.source !== undefined) {
    changes.source = parseSource(raw.source);
    // Webhook の受け口の印は作ったときにしか出さない——種類を変えると、印の無い Webhook・印の残った時刻ができる
    if (changes.source.kind !== current.source.kind) {
      throw new AutomationInputError("きっかけの種類（決まった時刻／Webhook／出来事）は変えられません。作り直してください");
    }
  }
  if (raw.target !== undefined) changes.target = parseTarget(raw.target, current.target);
  if (raw.reviewOnDone !== undefined) changes.reviewOnDone = parseReviewOnDone(raw.reviewOnDone);
  if (Object.keys(changes).length === 0) {
    throw new AutomationInputError("直す欄がありません（name・instruction・source・target・reviewOnDone）");
  }
  return changes;
}
