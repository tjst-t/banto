// **出来事を名乗る・知らせる**（追加・2026-10-16、アーキ仕様 §4.3「段2：出来事をきっかけにする」）。
//
// Module は宣言（`dev.banto/module` の `events`）で、出す出来事を名乗る——出来事ごとに `name`（`<出どころ>.<名前>`、
// 出どころは宣言した Module 自身の名前）・`title`・`description`・`fields`（属性ごとに `type`・`title`・任意の `enum`）・
// 任意の `subject`（回数の歯止めの鍵にする属性）。core は中身を知らず、画面と AI にそのまま見せる。
//
// 起きたら host の中継の `relayEmitEvent` で知らせる。**宣言に無い出来事・型の合わない属性は host が断る**。名乗りと照合の
// 決まりはここに1つだけ置く（host が受けるときも、自動化の条件（`where`）を作るときも同じものを通す、規則3）。
//
// **属性・`text`・`causedBy` は申告**——コンテナの中の AI は Module の合言葉を読め、`relayEmitEvent` を直接呼べる。
// host が信じるのは接続から決めた Project と、宣言との照合だけ。

import { ModuleMetaError } from "./meta.js";

/** host の中継で出来事を知らせる tool の名前 */
export const RELAY_EMIT_EVENT_TOOL = "relayEmitEvent";

/** core だけが出す出来事の出どころ（`banto.turn-decisions` 等）。Module は名乗れない */
export const CORE_EVENT_SOURCE = "banto";

/** 出来事の `text` の上限（バイト）。超えた分は host が切る */
export const EVENT_TEXT_MAX_BYTES = 16 * 1024;

/** 出す側が付ける重複落としの印の長さの上限 */
export const EVENT_ID_MAX = 200;

export type EventFieldType = "string" | "number" | "boolean";
export type EventFieldValue = string | number | boolean;

export interface EventFieldDeclaration {
  type: EventFieldType;
  title: string;
  /** 取りうる値（書いてあれば、それ以外は受けない） */
  enum?: EventFieldValue[];
}

export interface EventDeclaration {
  /** `<出どころ>.<名前>`（例 `service.crashed`） */
  name: string;
  title: string;
  description: string;
  fields: Record<string, EventFieldDeclaration>;
  /** 回数の歯止めの鍵にする属性（`service.crashed` は `service`）。名乗らなければ出来事名だけで数える */
  subject?: string;
}

/** 知らせる1件（`relayEmitEvent` の引数） */
export interface EmittedEvent {
  name: string;
  /** 出す側が付ける重複落としの印（出口の箱から出し直しても同じ） */
  eventId: string;
  /** 起きた時刻（ISO 8601） */
  occurredAt: string;
  fields: Record<string, EventFieldValue>;
  text?: string;
  /** その仕事を始めた呼び出しの印（host が呼び出しに刻んだ `dev.banto/callId`）。輪を止めるのに使う */
  causedBy?: { callId: string };
}

const NAME_PART = /^[a-z0-9][a-z0-9-]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const ENUM_MAX = 100;
const FIELDS_MAX = 32;
const EVENTS_MAX = 64;
const STRING_VALUE_MAX = 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * **出来事の名前が、その出どころのものか**（呼べないなら理由）。`<出どころ>.<名前>` の形で、出どころは名乗った Module 自身の
 * 名前（宣言の名前。Project ごとの Module も `<名前>-<projectId>` ではなく宣言の名前）。`banto.*` は core だけ
 */
export function eventNameProblem(name: unknown, source: string): string | undefined {
  if (typeof name !== "string") return "出来事の name が要ります";
  const dot = name.indexOf(".");
  if (dot <= 0) return `出来事の名前は <出どころ>.<名前> の形です（${JSON.stringify(name)}）`;
  const prefix = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  if (prefix === CORE_EVENT_SOURCE && source !== CORE_EVENT_SOURCE) return `${CORE_EVENT_SOURCE}.* の出来事は banto 本体だけが出せます`;
  if (prefix !== source) return `出来事の名前の頭は、名乗った Module の名前（${source}）でなければなりません（${name}）`;
  if (!NAME_PART.test(rest) || rest.length > 64) return `出来事の名前（${name}）は英小文字・数字・ハイフンで 64 文字までです`;
  return undefined;
}

function parseField(name: string, raw: unknown, where: string): EventFieldDeclaration {
  if (!FIELD_NAME.test(name)) throw new ModuleMetaError(`${where}: 属性の名前（${name}）は英字で始まる英数字と _ で 64 文字までです`);
  if (!isRecord(raw)) throw new ModuleMetaError(`${where}.${name}: 属性は { type, title, enum? } です`);
  const type = raw.type;
  if (type !== "string" && type !== "number" && type !== "boolean") {
    throw new ModuleMetaError(`${where}.${name}: type は string・number・boolean のどれかです（${JSON.stringify(type)} が来ました）`);
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "" || raw.title.length > TITLE_MAX) {
    throw new ModuleMetaError(`${where}.${name}: title が要ります（${TITLE_MAX} 字まで）`);
  }
  let values: EventFieldValue[] | undefined;
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > ENUM_MAX || raw.enum.some((v) => typeof v !== type)) {
      throw new ModuleMetaError(`${where}.${name}: enum は ${type} の値を 1〜${ENUM_MAX} 個並べたものです`);
    }
    values = [...(raw.enum as EventFieldValue[])];
  }
  return { type, title: raw.title, ...(values ? { enum: values } : {}) };
}

/**
 * **出来事の名乗りを読む**（宣言の `events`）。`source` は名乗った Module の宣言の名前。読めないものは投げる——黙って
 * 名乗っていないことにしない（規則2）
 */
export function parseEventDeclarations(raw: unknown, source: string, where = `${source}: events`): EventDeclaration[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ModuleMetaError(`${where} は出来事の名乗りの配列です`);
  if (raw.length > EVENTS_MAX) throw new ModuleMetaError(`${where}: 名乗れる出来事は ${EVENTS_MAX} 個までです`);
  const names = new Set<string>();
  return raw.map((e, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(e)) throw new ModuleMetaError(`${at}: 出来事の名乗りはオブジェクトです`);
    const problem = eventNameProblem(e.name, source);
    if (problem) throw new ModuleMetaError(`${at}: ${problem}`);
    const name = e.name as string;
    if (names.has(name)) throw new ModuleMetaError(`${at}: 出来事 ${name} を2回名乗っています`);
    names.add(name);
    if (typeof e.title !== "string" || e.title.trim() === "" || e.title.length > TITLE_MAX) {
      throw new ModuleMetaError(`${at}: title が要ります（${TITLE_MAX} 字まで）`);
    }
    if (typeof e.description !== "string" || e.description.length > DESCRIPTION_MAX) {
      throw new ModuleMetaError(`${at}: description が要ります（${DESCRIPTION_MAX} 字まで）`);
    }
    const rawFields = e.fields ?? {};
    if (!isRecord(rawFields)) throw new ModuleMetaError(`${at}: fields は属性の名前ごとのオブジェクトです`);
    if (Object.keys(rawFields).length > FIELDS_MAX) throw new ModuleMetaError(`${at}: 属性は ${FIELDS_MAX} 個までです`);
    const fields: Record<string, EventFieldDeclaration> = {};
    for (const [k, v] of Object.entries(rawFields)) fields[k] = parseField(k, v, `${at}.fields`);
    if (e.subject !== undefined && (typeof e.subject !== "string" || !(e.subject in fields))) {
      throw new ModuleMetaError(`${at}: subject は fields にある属性の名前です（${JSON.stringify(e.subject)} が来ました）`);
    }
    return {
      name,
      title: e.title,
      description: e.description,
      fields,
      ...(typeof e.subject === "string" ? { subject: e.subject } : {}),
    };
  });
}

function valueProblem(name: string, decl: EventFieldDeclaration, value: unknown): string | undefined {
  if (typeof value !== decl.type) return `属性 ${name} は ${decl.type} です（${JSON.stringify(value)} が来ました）`;
  if (typeof value === "number" && !Number.isFinite(value)) return `属性 ${name} は有限の数です`;
  if (typeof value === "string" && value.length > STRING_VALUE_MAX) return `属性 ${name} は ${STRING_VALUE_MAX} 字までです`;
  if (decl.enum && !decl.enum.includes(value as EventFieldValue)) {
    return `属性 ${name} は ${decl.enum.map((v) => JSON.stringify(v)).join("・")} のどれかです（${JSON.stringify(value)} が来ました）`;
  }
  return undefined;
}

/** **知らせた属性が名乗りに合うか**（合わなければ理由）。名乗っていない属性・型の違う値は受けない。無い属性はよい */
export function eventFieldsProblem(decl: EventDeclaration, fields: unknown): string | undefined {
  if (fields === undefined) return undefined;
  if (!isRecord(fields)) return "fields は属性の名前ごとのオブジェクトです";
  for (const [k, v] of Object.entries(fields)) {
    const d = decl.fields[k];
    if (!d) return `出来事 ${decl.name} は属性 ${k} を名乗っていません`;
    const problem = valueProblem(k, d, v);
    if (problem) return problem;
  }
  return undefined;
}

/** 自動化の条件（属性の「等しい／どれか」） */
export type EventWhere = Record<string, EventFieldValue | EventFieldValue[]>;

/** **自動化の条件が名乗りに合うか**（合わなければ理由）。属性は名乗ったもの、値は型と `enum` に合うもの */
export function eventWhereProblem(decl: EventDeclaration, where: unknown): string | undefined {
  if (where === undefined) return undefined;
  if (!isRecord(where)) return "where は属性の名前ごとの値（か値の配列）です";
  for (const [k, v] of Object.entries(where)) {
    const d = decl.fields[k];
    if (!d) return `出来事 ${decl.name} は属性 ${k} を名乗っていません（名乗っている属性：${Object.keys(decl.fields).join("・") || "なし"}）`;
    const values = Array.isArray(v) ? v : [v];
    if (values.length === 0) return `where.${k} が空です`;
    for (const one of values) {
      const problem = valueProblem(k, d, one);
      if (problem) return `where の${problem}`;
    }
  }
  return undefined;
}

/** 知らせた属性が条件に合うか（条件の属性がすべて、等しいか並べた値のどれか） */
export function eventMatchesWhere(where: EventWhere | undefined, fields: Record<string, EventFieldValue>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v : [v]).includes(fields[k] as EventFieldValue));
}
