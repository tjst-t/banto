// docs/specs/v4-architecture.md §4.3「置き場——core」の台帳。読み書きは画面（HTTP）からも AI の tool からもここを通る
// ——入力の確かめをここに1つ置く（どちらの口から来ても同じ決まりで断る）。

import { randomUUID } from "node:crypto";
import { eventWhereProblem, type EventDeclaration, type EventWhere } from "@banto/module-contract";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import {
  automationFold,
  type Automation,
  type AdvanceAct,
  type AutomationChanges,
  type AutomationCreatedBy,
  type AutomationFields,
  type AutomationReadModel,
  type AutomationReceived,
  type AutomationRepeat,
  type AutomationRun,
  type AutomationSignature,
  type AutomationSource,
  type AutomationTarget,
  type PatrolNoteChange,
  type SupervisorAct,
} from "./fold.js";
import { cronExpressionProblem } from "./schedule.js";
import { BANTO_EVENTS, bantoEventDeclaration, isJudgeAutomation, TURN_DECISIONS_EVENT } from "./turn-decisions.js";
import { DECISION_KINDS, HUMAN_ONLY_KINDS, isDecisionKind, type DecisionKind } from "../supervisor/policy.js";

/** 見回りが1日に出せる気づきの既定と上限（アーキ仕様 §4.4「知らせる tool」） */
export const PATROL_DAILY_LIMIT_DEFAULT = 10;
const PATROL_DAILY_LIMIT_MAX = 50;

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
  /**
   * その Project で出来事を名乗っている Module ごとの名乗り（作るフォームの「出どころ→出来事」と、AI が名乗っていない名前を
   * 渡したときに返す一覧、追加・2026-10-16）。名乗りの読めない Module は入れない
   */
  list(projectId: string): AutomationEventSource[];
}

/** 出どころ1つ（Module の名前か `banto`）と、それが名乗る出来事 */
export interface AutomationEventSource {
  source: string;
  events: EventDeclaration[];
}

export class AutomationStore {
  private readonly projection: SnapshotProjection<AutomationReadModel>;
  private readonly listeners = new Set<(change: { projectId: string; id: string }) => void>();
  private eventCatalog: AutomationEventCatalog | undefined;

  constructor(dataDir: string, private readonly log: EventLog) {
    // 版 2：`clockFrom`（時計の数え始め）を足した。版 3：番頭の記録の `actId`・一時停止の `pausedScope`（Backlog #510）
    this.projection = new SnapshotProjection(dataDir, "automations", log, automationFold, 3);
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

  /**
   * **その Project で待てる出来事**（出どころごと。banto 自身が先頭）。口が無い構成では banto 自身の出来事だけ
   */
  eventSources(projectId: string): AutomationEventSource[] {
    return [{ source: "banto", events: [...BANTO_EVENTS] }, ...(this.eventCatalog?.list(projectId) ?? [])];
  }

  /**
   * **作る前の確かめ**（出来事が名乗られているか・条件が名乗りに合うか・判断役の届け先）。AI の tool は人に聞く前にこれを通す
   * ——人が許したあとで「入力が違う」と断らないように。`create`・`update` も同じものを通る。直すときは、きっかけを変えた
   * ときだけ名乗りと照らす（`sourceChanged`——名前だけ直すのを、あとで Module を外したことで断らない）
   */
  checkFields(projectId: string, fields: Pick<AutomationFields, "source" | "target" | "mode">, sourceChanged = true): void {
    if (sourceChanged && fields.source.kind === "event") this.checkEventSource(projectId, fields.source);
    checkJudgeTarget(fields);
    if (sourceChanged) this.checkJudgeBesideSupervisor(projectId, fields);
  }

  /**
   * **番頭のいる Project に判断役を置かない**（アーキ仕様 §4.5「番頭を置いた Project では判断役を作れない」）——同じ決めることに
   * 二人で答えると、種類による断り（番頭だけに効く）をくぐれる
   */
  private checkJudgeBesideSupervisor(projectId: string, fields: Pick<AutomationFields, "source" | "mode">): void {
    if (fields.mode === "supervisor" || !isJudgeAutomation(fields)) return;
    if (this.supervisorAutomations(projectId).length > 0) {
      throw new AutomationInputError(
        `この Project には番頭がいるので、${TURN_DECISIONS_EVENT} を待つ自動化（判断役）は作れません（番頭が決めることに答えます）`,
      );
    }
  }

  /** その Project の番頭の自動化（番頭は Project に1つ） */
  supervisorAutomations(projectId: string): Automation[] {
    return this.list(projectId).filter((a) => a.mode === "supervisor");
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
    this.checkFields(input.projectId, fields);
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
    if (current.mode === "supervisor") throw new AutomationInputError("番頭の自動化は直せません（番頭の画面で扱います）");
    const parsed = parseAutomationChanges(changes, current);
    this.checkFields(
      current.projectId,
      { source: parsed.source ?? current.source, target: parsed.target ?? current.target, ...(current.mode ? { mode: current.mode } : {}) },
      parsed.source !== undefined,
    );
    await this.append("automation.updated", { id, changes: parsed });
    return this.mustGet(id);
  }

  /**
   * `scope: "stop-all"`＝番頭を全部止めた（全部を再開する口が再開する）。全部止めて止まっているものを Project ごとに止め直すと、
   * 印を外して書き直す（全部を再開しても残す）
   */
  async pause(id: string, reason?: string, opts: { scope?: "stop-all" } = {}): Promise<Automation> {
    const current = this.mustGet(id);
    if (current.paused && (current.pausedScope !== "stop-all" || opts.scope === "stop-all")) return current;
    await this.append("automation.paused", { id, ...(reason ? { reason } : {}), ...(opts.scope ? { scope: opts.scope } : {}) });
    return this.mustGet(id);
  }

  async resume(id: string): Promise<Automation> {
    const current = this.mustGet(id);
    if (!current.paused) return current;
    // 番頭を置いたときに一時停止した判断役を、番頭がいるまま再開させない
    this.checkJudgeBesideSupervisor(current.projectId, current);
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

  /**
   * **見回りの手帳に書く**（アーキ仕様 §4.4「手帳」）。人・AI の入力（`update`）からは書けない——host が `notify` と受信箱の
   * 押したものから書く
   */
  async notePatrol(id: string, key: string, change: PatrolNoteChange, title?: string): Promise<void> {
    const current = this.mustGet(id);
    if (current.mode !== "patrol") throw new Error(`自動化 ${id} は見回りではありません`);
    await this.append("automation.patrol_noted", { id, key, change, ...(title ? { title } : {}) });
  }

  /**
   * **番頭の自動化を作る**（アーキ仕様 §4.5「番頭の作り」）。人・AI の入力の口（`create`）を通らない——欄は `supervisor/supervisors.ts`
   * が組んだもの。出来事の名乗りとは照らさない（Factory が入っていない Project では、その出来事が届かないだけ）
   */
  async createSupervisorAutomation(input: { projectId: string; supervisorId: string; fields: AutomationFields }): Promise<Automation> {
    if (input.fields.mode !== "supervisor") throw new Error("番頭の自動化ではありません");
    const id = newAutomationId();
    await this.append("automation.created", {
      id,
      projectId: input.projectId,
      createdBy: { kind: "human" },
      ...input.fields,
      supervisorId: input.supervisorId,
    });
    return this.mustGet(id);
  }

  /** **番頭の時刻のきっかけを直す**（再開したときに今の方針の間隔に揃える）。人・AI の入力（`update`）からは直せない */
  async setSupervisorSource(id: string, source: AutomationSource): Promise<Automation> {
    const current = this.mustGet(id);
    if (current.mode !== "supervisor") throw new Error(`自動化 ${id} は番頭ではありません`);
    await this.append("automation.updated", { id, changes: { source } });
    return this.mustGet(id);
  }

  /** **番頭の記録に書く**（アーキ仕様 §4.5「記録」）。host が書く——人・AI の入力からは書けない */
  async recordSupervisorAct(id: string, act: SupervisorAct): Promise<void> {
    const current = this.mustGet(id);
    if (current.mode !== "supervisor") throw new Error(`自動化 ${id} は番頭ではありません`);
    await this.append("automation.supervisor_acted", { id, ...act });
  }

  /**
   * **進める自動化の記録に書く**（アーキ仕様 §4.3「判断役の一般化」）。host が書く——人・AI の入力からは書けない。`canAdvanceProject` か
   * `delegateKinds` を持つ自動化だけ（ほかの自動化の台帳の形を変えない）
   */
  async recordAdvanceAct(id: string, act: AdvanceAct): Promise<void> {
    const current = this.mustGet(id);
    if (current.mode === "supervisor" || (current.canAdvanceProject !== true && current.delegateKinds === undefined)) {
      throw new Error(`自動化 ${id} は進める自動化ではありません`);
    }
    await this.append("automation.advance_acted", { id, ...act });
  }

  /** Webhook で受けたものを残す（届けるまで溜める。届けた回の `automation.fired` の `receivedIds` で外れる） */
  async recordReceived(id: string, received: AutomationReceived): Promise<void> {
    this.mustGet(id);
    await this.append("automation.received", { id, ...received });
  }

  /** 出来事の名前が、その Project の Module に名乗られているか・条件が名乗りの属性に合うか */
  private checkEventSource(projectId: string, source: Extract<AutomationSource, { kind: "event" }>): void {
    this.checkEventWait(projectId, source.event, source.where);
  }

  /**
   * **待つ出来事が名乗られているか・条件が名乗りに合うか**。合えばその名乗りを返し、合わなければ `AutomationInputError`（AI が
   * 読んで直せる文——待てる出来事の一覧つき）。自動化の出来事のきっかけと、任務の予約の出来事（アーキ仕様 §4.4）が同じ決まりで使う
   */
  checkEventWait(projectId: string, event: string, where: EventWhere | undefined): EventDeclaration {
    const source = { event, where };
    // banto 自身の出来事（`banto.*`）は core が名乗る——Module の宣言からは引かない
    const core = bantoEventDeclaration(source.event);
    if (!core && !this.eventCatalog) throw new AutomationInputError("この banto は出来事のきっかけを受けられません");
    const declared = core ?? this.eventCatalog?.find(projectId, source.event);
    if (!declared) {
      // 待てるものを並べて返す——AI はここで名前を知る（名乗りは Project ごとに違う）
      const known = this.eventSources(projectId).flatMap((s) => s.events.map((e) => `${e.name}（${e.title}）`));
      throw new AutomationInputError(
        `この Project には出来事 ${source.event} を名乗っている Module がありません。待てる出来事：${known.join("、")}`,
      );
    }
    const problem = eventWhereProblem(declared, source.where);
    if (problem) throw new AutomationInputError(problem);
    return declared;
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
/**
 * **判断役の届け先は専用の Fork に限る**（アーキ仕様 §4.3「banto.turn-decisions と判断役」の「守り」）——既存の Thread（Base 等）を
 * 届け先にすると、その会話の承認を「必ず聞く」に固定することになる
 */
function checkJudgeTarget(fields: Pick<AutomationFields, "source" | "target" | "mode">): void {
  // 見回りの回は読むだけで answer_decision を持たない——判断役にはなれない（§4.4「判断役の道を断つ」）
  if (isJudgeAutomation(fields) && fields.mode === "patrol") {
    throw new AutomationInputError(`見回りは ${TURN_DECISIONS_EVENT} を待てません（判断役にはなれません）`);
  }
  if (isJudgeAutomation(fields) && fields.target.kind !== "dedicated") {
    throw new AutomationInputError(`${TURN_DECISIONS_EVENT} を待つ自動化（判断役）の届け先は、専用の Fork だけです`);
  }
}

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

function parseMode(v: unknown): "patrol" | undefined {
  if (v === undefined || v === "normal") return undefined;
  if (v === "patrol") return "patrol";
  // **番頭は人が番頭の画面から作る**（アーキ仕様 §4.5「AI の create_automation では番頭を作れない」）
  if (v === "supervisor") throw new AutomationInputError("番頭（mode: supervisor）は自動化としては作れません。人が番頭の画面から置きます");
  throw new AutomationInputError("mode は normal（ふつう）か patrol（見回り）です");
}

/**
 * **判断役が選んでよい問いの種類**（`delegateKinds`）。決めることの種類の配列で、人に回す種類は入れられない（入れても選べない
 * ——任せたつもりにさせない）。表の順に並べ直し、重なりは1つに
 */
function parseDelegateKinds(v: unknown): DecisionKind[] {
  if (!Array.isArray(v)) throw new AutomationInputError(`delegateKinds（選んでよい問いの種類）は種類の配列で渡してください（${DECISION_KINDS.join("・")}）`);
  for (const k of v) {
    if (!isDecisionKind(k)) throw new AutomationInputError(`delegateKinds の「${String(k)}」は知らない種類です（${DECISION_KINDS.join("・")}）`);
    if ((HUMAN_ONLY_KINDS as readonly string[]).includes(k)) {
      throw new AutomationInputError(`delegateKinds の「${k}」は人が決める種類なので任せられません（${HUMAN_ONLY_KINDS.join("・")}）`);
    }
  }
  return DECISION_KINDS.filter((k) => v.includes(k));
}

function parseCanAdvanceProject(v: unknown): boolean {
  if (typeof v !== "boolean") throw new AutomationInputError("canAdvanceProject は true か false で渡してください");
  return v;
}

const JUDGE_ONLY_DELEGATE_KINDS = `delegateKinds は ${TURN_DECISIONS_EVENT} を待つ自動化（判断役）だけの欄です`;
/** 見回りの回は読むだけ——止まった会話に頼む・Factory に流すは読むだけではない（アーキ仕様 §4.4「読むだけの回」） */
const PATROL_CANNOT_ADVANCE = "見回り（mode: patrol）は読むだけの回なので、canAdvanceProject（止まった会話を進める権限）を持てません";

/** 判断役の一般化の2つの欄（作るとき）。無ければ何も足さない——今までの自動化と同じ形 */
function parseAdvanceFields(raw: Record<string, unknown>, source: AutomationSource): Pick<AutomationFields, "delegateKinds" | "canAdvanceProject"> {
  const out: Pick<AutomationFields, "delegateKinds" | "canAdvanceProject"> = {};
  if (raw.delegateKinds !== undefined && raw.delegateKinds !== null) {
    if (!isJudgeAutomation({ source })) throw new AutomationInputError(JUDGE_ONLY_DELEGATE_KINDS);
    out.delegateKinds = parseDelegateKinds(raw.delegateKinds);
  }
  if (raw.canAdvanceProject !== undefined && parseCanAdvanceProject(raw.canAdvanceProject)) out.canAdvanceProject = true;
  return out;
}

function parseDailyFindingLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > PATROL_DAILY_LIMIT_MAX) {
    throw new AutomationInputError(`dailyFindingLimit（1日の気づきの上限）は 1〜${PATROL_DAILY_LIMIT_MAX} の整数で渡してください`);
  }
  return v;
}

export function parseAutomationFields(raw: unknown): AutomationFields {
  if (!isRecord(raw)) throw new AutomationInputError("自動化の中身はオブジェクトで渡してください");
  const mode = parseMode(raw.mode);
  if (mode === "patrol") {
    // **見回りの届け先は専用の Fork・毎回まっさらに固定**し、完了した回は受信箱に出さない（アーキ仕様 §4.4「違うところ」）
    // ——違う値を渡されたら黙って直さずに断る（規則2）
    if (raw.target !== undefined) {
      const t = parseTarget(raw.target);
      if (t.kind !== "dedicated" || t.mode !== "fresh") {
        throw new AutomationInputError("見回りの届け先は専用の Fork（毎回まっさら）だけです");
      }
    }
    if (raw.reviewOnDone === true) throw new AutomationInputError("見回りは完了した回を受信箱に出しません（気づきは notify で出します）");
    if (raw.canAdvanceProject === true) throw new AutomationInputError(PATROL_CANNOT_ADVANCE);
    if (raw.delegateKinds !== undefined && raw.delegateKinds !== null) throw new AutomationInputError(JUDGE_ONLY_DELEGATE_KINDS);
    return {
      name: parseName(raw.name),
      instruction: parseInstruction(raw.instruction),
      source: parseSource(raw.source),
      target: { kind: "dedicated", mode: "fresh" },
      reviewOnDone: false,
      mode,
      dailyFindingLimit: raw.dailyFindingLimit === undefined ? PATROL_DAILY_LIMIT_DEFAULT : parseDailyFindingLimit(raw.dailyFindingLimit),
    };
  }
  if (raw.dailyFindingLimit !== undefined) throw new AutomationInputError("dailyFindingLimit は見回り（mode: patrol）だけの欄です");
  const source = parseSource(raw.source);
  return {
    name: parseName(raw.name),
    instruction: parseInstruction(raw.instruction),
    source,
    target: parseTarget(raw.target ?? { kind: "dedicated", mode: "fresh" }),
    reviewOnDone: raw.reviewOnDone === undefined ? true : parseReviewOnDone(raw.reviewOnDone),
    ...parseAdvanceFields(raw, source),
  };
}

export function parseAutomationChanges(raw: unknown, current: Automation): AutomationChanges {
  if (!isRecord(raw)) throw new AutomationInputError("直す中身はオブジェクトで渡してください");
  const changes: AutomationChanges = {};
  if (raw.name !== undefined) changes.name = parseName(raw.name);
  if (raw.instruction !== undefined) changes.instruction = parseInstruction(raw.instruction);
  if (raw.source !== undefined) {
    changes.source = parseSource(raw.source);
    // Webhook の受け口の印は作ったときにしか出さない——種類を変えると、印の無い Webhook・印の残った時刻ができる
    if (changes.source.kind !== current.source.kind) {
      throw new AutomationInputError("きっかけの種類（決まった時刻／Webhook／出来事）は変えられません。作り直してください");
    }
  }
  // **種類は作ったあと変えない**（アーキ仕様 §4.4「mode は作ったあと変えない」）。同じ値なら直したことにしない
  if (raw.mode !== undefined && parseMode(raw.mode) !== current.mode) {
    throw new AutomationInputError("種類（ふつう／見回り）は変えられません。作り直してください");
  }
  const patrol = current.mode === "patrol";
  if (raw.target !== undefined) {
    changes.target = parseTarget(raw.target, current.target);
    if (patrol && (changes.target.kind !== "dedicated" || changes.target.mode !== "fresh")) {
      throw new AutomationInputError("見回りの届け先は専用の Fork（毎回まっさら）だけです");
    }
  }
  if (raw.reviewOnDone !== undefined) {
    changes.reviewOnDone = parseReviewOnDone(raw.reviewOnDone);
    if (patrol && changes.reviewOnDone) throw new AutomationInputError("見回りは完了した回を受信箱に出しません（気づきは notify で出します）");
  }
  if (raw.dailyFindingLimit !== undefined) {
    if (!patrol) throw new AutomationInputError("dailyFindingLimit は見回り（mode: patrol）だけの欄です");
    changes.dailyFindingLimit = parseDailyFindingLimit(raw.dailyFindingLimit);
  }
  // **判断役の一般化の2つの欄**。`delegateKinds: null` は外す
  if (raw.delegateKinds === null) changes.delegateKinds = null;
  else if (raw.delegateKinds !== undefined) {
    if (patrol) throw new AutomationInputError(JUDGE_ONLY_DELEGATE_KINDS);
    changes.delegateKinds = parseDelegateKinds(raw.delegateKinds);
  }
  // きっかけを判断役でないものに変えるなら、残る delegateKinds は持てない（外してから変える）
  const kindsAfter = changes.delegateKinds === null ? undefined : (changes.delegateKinds ?? current.delegateKinds);
  if (kindsAfter !== undefined && !isJudgeAutomation({ source: changes.source ?? current.source })) {
    throw new AutomationInputError(`${JUDGE_ONLY_DELEGATE_KINDS}（外すなら delegateKinds: null）`);
  }
  if (raw.canAdvanceProject !== undefined) {
    changes.canAdvanceProject = parseCanAdvanceProject(raw.canAdvanceProject);
    if (changes.canAdvanceProject && patrol) throw new AutomationInputError(PATROL_CANNOT_ADVANCE);
  }
  if (Object.keys(changes).length === 0) {
    throw new AutomationInputError(
      "直す欄がありません（name・instruction・source・target・reviewOnDone・dailyFindingLimit・delegateKinds・canAdvanceProject）",
    );
  }
  return changes;
}
