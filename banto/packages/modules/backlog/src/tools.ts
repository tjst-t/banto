// Backlog の tool（§4.4「つけ方と AI の tool」）。
//
// - **AI の6本**（agent）：listItems・getItem・createItem・updateItem・splitStory・moveItem。**消す tool は作らない**
//   （要らなくなったものは dropped で閉じれば記録が残る）。説明文は短く——全部のターンの文脈に載る
// - **人の画面の口**（admin）：getBoard と board*（書いた後の一覧ごと返す）・設定。AI には見せない
//
// 返り値は AI が読みやすい短い文（content）と、同じものの構造（structuredContent）。
// 失敗は `isError` と理由の文で返す——AI にも画面にも、なぜ断ったかが届く（規則2）。

import { homedir } from "node:os";
import { basename, sep } from "node:path";
import { realpathSync } from "node:fs";
import { VISIBILITY_META_KEY, threadOf } from "@banto/module-contract";
import {
  BacklogError,
  KINDS,
  PRIORITIES,
  STATUSES,
  childrenOf,
  createItem,
  dependents,
  isActionable,
  isClosed,
  moveItem,
  splitStory,
  updateItem,
  waitingOn,
  type BacklogDocument,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
  type ItemPatch,
  type NewItemInput,
  type SplitTaskInput,
} from "./model.js";
import { conversionCommand, conversionHint, type BacklogStore, type Snapshot } from "./store.js";
import { readSettings, writeSettings } from "./settings.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ---- 定義 --------------------------------------------------------------------

const KIND = { type: "string", enum: [...KINDS] };
const STATUS = { type: "string", enum: [...STATUSES] };
const PRIORITY = { type: "string", enum: [...PRIORITIES] };
const IDS = { type: "array", items: { type: "string" } };
const STRS = { type: "array", items: { type: "string" } };

/** 欄を書ける tool（作る・変える）で共通の欄 */
const ITEM_FIELDS_SCHEMA = {
  title: { type: "string" },
  status: STATUS,
  parent: { type: ["string", "null"], description: "親のストーリーの id（タスクだけ）" },
  dependsOn: { ...IDS, description: "終わるまで始められない項目の id" },
  milestone: { type: ["string", "null"] },
  priority: PRIORITY,
  labels: STRS,
  body: { type: "string", description: "Markdown。なぜ・経緯・確かめ方" },
  doneWhen: { type: "string", description: "完了条件（計測で書く）" },
  refs: STRS,
};

const SPLIT_TASK = {
  type: "object",
  properties: {
    title: { type: "string" },
    id: { type: "string" },
    doneWhen: { type: "string" },
    body: { type: "string" },
    dependsOn: IDS,
    waitsFor: { type: "array", items: { type: "integer" }, description: "同じ回のタスクのうち待つものの番号（0から）" },
  },
  required: ["title"],
};

function agentTool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema: { type: "object", ...inputSchema }, _meta: { [VISIBILITY_META_KEY]: "agent" } };
}

function adminTool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema: { type: "object", ...inputSchema }, _meta: { [VISIBILITY_META_KEY]: "admin" } };
}

const CREATE_SCHEMA = {
  properties: { kind: KIND, id: { type: "string", description: "省けば題から作る" }, ...ITEM_FIELDS_SCHEMA },
  required: ["kind", "title"],
};
const UPDATE_SCHEMA = {
  properties: {
    id: { type: "string" },
    kind: KIND,
    ...ITEM_FIELDS_SCHEMA,
    resolution: { type: ["string", "null"], description: "閉じた理由（dropped には必須）" },
  },
  required: ["id"],
};
const SPLIT_SCHEMA = {
  properties: { storyId: { type: "string" }, tasks: { type: "array", items: SPLIT_TASK } },
  required: ["storyId", "tasks"],
};
const MOVE_SCHEMA = {
  properties: {
    id: { type: "string" },
    before: { type: "string", description: "この項目の前へ（上ほど先にやる）" },
    after: { type: "string", description: "この項目の後ろへ" },
  },
  required: ["id"],
};

export const TOOLS = [
  agentTool("listItems", "仕事の一覧（ファイルの順＝優先順）。既定は閉じていないもの。actionable: true で今すぐ着手できるもの（ready で依存が全部 done）だけ", {
    properties: {
      kind: KIND,
      status: { type: "array", items: STATUS, description: "指定すると閉じたものも絞れる" },
      milestone: { type: "string" },
      label: { type: "string" },
      parent: { type: "string", description: "このストーリーの子だけ" },
      actionable: { type: "boolean" },
    },
  }),
  agentTool("getItem", "1件の中身を全部（本文・完了条件・依存・子）", { properties: { id: { type: "string" } }, required: ["id"] }),
  agentTool("createItem", "1件足す（story・task・bug）。親・依存も付けられる", CREATE_SCHEMA),
  agentTool("updateItem", "欄を変える。状態を進める・閉じる（dropped は resolution 必須）・依存を張り替える（dependsOn は全体を渡す）", UPDATE_SCHEMA),
  agentTool("splitStory", "ストーリーの下に複数のタスクを1回で作る。waitsFor で同じ回のタスク間の依存", SPLIT_SCHEMA),
  agentTool("moveItem", "並び順（＝優先順）を、指定した項目の前（before）か後ろ（after）へ動かす", MOVE_SCHEMA),
  // ---- 人の画面の口（admin）——AI には見せない ----
  adminTool("getBoard", "画面が描く一覧の全部。since が今の版と同じなら unchanged だけ返す", {
    properties: { since: { type: "string" } },
  }),
  adminTool("boardCreateItem", "画面から1件足す（結果は一覧ごと）", CREATE_SCHEMA),
  adminTool("boardUpdateItem", "画面から欄を変える（結果は一覧ごと）", UPDATE_SCHEMA),
  adminTool("boardSplitStory", "画面からタスクに分ける（結果は一覧ごと）", SPLIT_SCHEMA),
  adminTool("boardMoveItem", "画面から並べ替える（結果は一覧ごと）", MOVE_SCHEMA),
  adminTool("getSettings", "この Module のいまの設定（tasks.json の場所）", { properties: {} }),
  adminTool("setSettings", "tasks.json の場所を変える（Project の根からの相対）", {
    properties: { path: { type: "string" } },
    required: ["path"],
  }),
];

// ---- 引数を読む（型が違えば理由を言って断る）------------------------------------------------

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new BacklogError(`${key} は文字列です`);
  return v;
}

function requiredStr(args: Args, key: string): string {
  const v = str(args, key);
  if (v === undefined || v === "") throw new BacklogError(`${key} が要ります`);
  return v;
}

function nullableStr(args: Args, key: string): string | null | undefined {
  const v = args[key];
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== "string") throw new BacklogError(`${key} は文字列か null です`);
  // 空文字は「外す」と同じ（画面の小窓・AI のどちらでも、空で外したいことがある）
  return v === "" ? null : v;
}

function strList(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new BacklogError(`${key} は文字列の配列です`);
  return v as string[];
}

function enumOf<T extends string>(values: readonly T[], args: Args, key: string): T | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new BacklogError(`${key} は ${values.join("・")} のどれかです（${JSON.stringify(v)}）`);
  }
  return v as T;
}

function patchFrom(args: Args): ItemPatch {
  const patch: ItemPatch = {};
  const title = str(args, "title");
  if (title !== undefined) patch.title = title;
  const kind = enumOf<BacklogKind>(KINDS, args, "kind");
  if (kind !== undefined) patch.kind = kind;
  const status = enumOf<BacklogStatus>(STATUSES, args, "status");
  if (status !== undefined) patch.status = status;
  const parent = nullableStr(args, "parent");
  if (parent !== undefined) patch.parent = parent;
  const dependsOn = strList(args, "dependsOn");
  if (dependsOn !== undefined) patch.dependsOn = dependsOn;
  const milestone = nullableStr(args, "milestone");
  if (milestone !== undefined) patch.milestone = milestone;
  const priority = enumOf<BacklogPriority>(PRIORITIES, args, "priority");
  if (priority !== undefined) patch.priority = priority;
  const labels = strList(args, "labels");
  if (labels !== undefined) patch.labels = labels;
  const body = str(args, "body");
  if (body !== undefined) patch.body = body;
  const doneWhen = str(args, "doneWhen");
  if (doneWhen !== undefined) patch.doneWhen = doneWhen;
  const resolution = nullableStr(args, "resolution");
  if (resolution !== undefined) patch.resolution = resolution;
  const refs = strList(args, "refs");
  if (refs !== undefined) patch.refs = refs;
  return patch;
}

function newItemFrom(args: Args): NewItemInput {
  const kind = enumOf<BacklogKind>(KINDS, args, "kind");
  if (kind === undefined) throw new BacklogError("kind が要ります（story・task・bug）");
  const { kind: _k, title: _t, resolution: _r, ...rest } = patchFrom(args);
  void _k;
  void _t;
  if (_r !== undefined) throw new BacklogError("resolution は閉じるときに updateItem で書きます");
  const id = str(args, "id");
  return { kind, title: requiredStr(args, "title"), ...(id !== undefined ? { id } : {}), ...rest };
}

function splitFrom(args: Args): { storyId: string; tasks: SplitTaskInput[] } {
  const storyId = requiredStr(args, "storyId");
  const raw = args.tasks;
  if (!Array.isArray(raw)) throw new BacklogError("tasks は配列です");
  const tasks = raw.map((t, i): SplitTaskInput => {
    if (typeof t !== "object" || t === null) throw new BacklogError(`tasks[${i}] はオブジェクトです`);
    const a = t as Args;
    const waitsFor = a.waitsFor;
    if (waitsFor !== undefined && (!Array.isArray(waitsFor) || !waitsFor.every((n) => Number.isInteger(n)))) {
      throw new BacklogError(`tasks[${i}].waitsFor は番号の配列です`);
    }
    const out: SplitTaskInput = { title: requiredStr(a, "title") };
    const id = str(a, "id");
    if (id !== undefined) out.id = id;
    const doneWhen = str(a, "doneWhen");
    if (doneWhen !== undefined) out.doneWhen = doneWhen;
    const body = str(a, "body");
    if (body !== undefined) out.body = body;
    const dependsOn = strList(a, "dependsOn");
    if (dependsOn !== undefined) out.dependsOn = dependsOn;
    if (waitsFor !== undefined) out.waitsFor = waitsFor as number[];
    return out;
  });
  return { storyId, tasks };
}

function moveFrom(args: Args): { id: string; target: string; where: "before" | "after" } {
  const id = requiredStr(args, "id");
  const before = str(args, "before");
  const after = str(args, "after");
  if ((before === undefined) === (after === undefined)) throw new BacklogError("before か after のどちらか1つを渡します");
  return before !== undefined ? { id, target: before, where: "before" } : { id, target: after!, where: "after" };
}

// ---- 返す形 --------------------------------------------------------------------

function summary(item: BacklogItem, items: readonly BacklogItem[]) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    parent: item.parent,
    dependsOn: item.dependsOn,
    milestone: item.milestone,
    priority: item.priority,
    labels: item.labels,
    actionable: isActionable(item, items),
  };
}

/** AI に見せる1行。`id [状態] 題` に、要るものだけ足す */
function line(item: BacklogItem, items: readonly BacklogItem[]): string {
  const parts = [`${item.id} [${item.status}${isActionable(item, items) ? "・着手できる" : ""}] ${item.title}`];
  if (item.kind !== "task") parts.push(`(${item.kind})`);
  if (item.priority !== "normal") parts.push(`優先:${item.priority}`);
  if (item.parent) parts.push(`親:${item.parent}`);
  const waiting = waitingOn(item, items).map((i) => i.id);
  if (!isClosed(item) && waiting.length > 0) parts.push(`待ち:${waiting.join(",")}`);
  if (item.milestone) parts.push(`M:${item.milestone}`);
  return parts.join(" ");
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 読めないファイルのときに言うこと（古い形なら変換の手段も） */
function refusal(snapshot: Extract<Snapshot, { state: "refused" }>): string {
  return `${snapshot.path} を読めません：${snapshot.reason}。` + (snapshot.legacy ? conversionHint(snapshot.path) : "");
}

function problemsNote(problems: readonly string[]): string {
  return problems.length > 0 ? `\n（ファイルに問題があります：${problems.join("／")}）` : "";
}

// ---- 処理 ----------------------------------------------------------------------

export interface ToolContext {
  store: BacklogStore;
  root: string;
  now?: () => string;
}

/** 人に見せる根の場所（ホームの下なら ~ で縮める） */
function displayRoot(root: string): { path: string; name: string } {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // 根がまだ無い——渡されたまま見せる
  }
  const home = homedir();
  const path = real === home ? "~" : real.startsWith(home + sep) ? `~${real.slice(home.length)}` : real;
  return { path, name: basename(real) };
}

async function board(ctx: ToolContext, since?: string): Promise<ToolResult> {
  const snapshot = await ctx.store.read();
  if (since !== undefined && since === snapshot.version) {
    return ok("変わっていません", { unchanged: true, version: snapshot.version });
  }
  const root = displayRoot(ctx.root);
  const base = { root, path: snapshot.path, version: snapshot.version, state: snapshot.state };
  if (snapshot.state === "missing") return ok(`まだ ${snapshot.path} がありません`, base);
  if (snapshot.state === "refused") {
    return ok(refusal(snapshot), {
      ...base,
      reason: snapshot.reason,
      legacy: snapshot.legacy,
      ...(snapshot.legacy ? { convertCommand: conversionCommand(snapshot.path) } : {}),
    });
  }
  return ok(`${snapshot.doc.items.length} 件`, { ...base, doc: snapshot.doc, problems: snapshot.problems });
}

export async function callTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
  meta: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  const args = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Args;
  const now = ctx.now ?? (() => new Date().toISOString());
  // **AI のターンからの呼び出しにだけ** host が刻む（人の画面・中継では来ない——そのときは足さない）
  const thread = threadOf(meta);
  try {
    switch (name) {
      case "listItems":
        return await listItems(ctx, args);
      case "getItem":
        return await getItem(ctx, requiredStr(args, "id"));
      case "createItem": {
        const input = newItemFrom(args);
        const { result, doc, path, created } = await ctx.store.mutate((d) => createItem(d, input, now(), thread));
        return ok(
          `${created ? `${path} を作り、` : ""}足しました：${line(result, doc.items)}`,
          { item: result, path },
        );
      }
      case "updateItem": {
        const id = requiredStr(args, "id");
        const patch = patchFrom(args);
        const { result, doc } = await ctx.store.mutate((d) => updateItem(d, id, patch, now(), thread));
        return ok(`変えました：${line(result, doc.items)}`, { item: result });
      }
      case "splitStory": {
        const { storyId, tasks } = splitFrom(args);
        const { result, doc } = await ctx.store.mutate((d) => splitStory(d, storyId, tasks, now()));
        return ok(
          `「${storyId}」を ${result.length} 件のタスクに分けました：\n${result.map((i) => line(i, doc.items)).join("\n")}`,
          { items: result },
        );
      }
      case "moveItem": {
        const { id, target, where } = moveFrom(args);
        const { doc } = await ctx.store.mutate((d) => moveItem(d, id, target, where));
        const index = doc.items.findIndex((i) => i.id === id);
        return ok(`「${id}」を「${target}」の${where === "before" ? "前" : "後ろ"}へ動かしました（上から ${index + 1} 番目）`, {
          id,
          index,
        });
      }
      case "getBoard":
        return await board(ctx, str(args, "since"));
      case "boardCreateItem": {
        const input = newItemFrom(args);
        await ctx.store.mutate((d) => createItem(d, input, now()));
        return await board(ctx);
      }
      case "boardUpdateItem": {
        const id = requiredStr(args, "id");
        const patch = patchFrom(args);
        await ctx.store.mutate((d) => updateItem(d, id, patch, now()));
        return await board(ctx);
      }
      case "boardSplitStory": {
        const { storyId, tasks } = splitFrom(args);
        await ctx.store.mutate((d) => splitStory(d, storyId, tasks, now()));
        return await board(ctx);
      }
      case "boardMoveItem": {
        const { id, target, where } = moveFrom(args);
        await ctx.store.mutate((d) => moveItem(d, id, target, where));
        return await board(ctx);
      }
      case "getSettings": {
        const s = readSettings();
        return ok(JSON.stringify(s), { ...s });
      }
      case "setSettings": {
        const saved = writeSettings({ path: requiredStr(args, "path") });
        return ok(JSON.stringify(saved), { ...saved });
      }
      default:
        return fail(`知らない tool です：${name}`);
    }
  } catch (err) {
    if (err instanceof BacklogError) return fail(err.message);
    throw err;
  }
}

async function listItems(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const kind = enumOf<BacklogKind>(KINDS, args, "kind");
  const statusRaw = args.status;
  if (statusRaw !== undefined && (!Array.isArray(statusRaw) || !statusRaw.every((s) => (STATUSES as readonly unknown[]).includes(s)))) {
    throw new BacklogError(`status は ${STATUSES.join("・")} の配列です`);
  }
  const statuses = statusRaw as BacklogStatus[] | undefined;
  const milestone = str(args, "milestone");
  const label = str(args, "label");
  const parent = str(args, "parent");
  const actionable = args.actionable === true;

  const snapshot = await ctx.store.read();
  if (snapshot.state === "missing") {
    return ok(`まだ tasks.json がありません（${snapshot.path}）。createItem で最初の項目を足すと作ります`, {
      path: snapshot.path,
      exists: false,
      items: [],
    });
  }
  if (snapshot.state === "refused") return fail(refusal(snapshot));
  const items = snapshot.doc.items;
  const picked = items.filter(
    (i) =>
      (statuses ? statuses.includes(i.status) : !isClosed(i)) &&
      (kind === undefined || i.kind === kind) &&
      (milestone === undefined || i.milestone === milestone) &&
      (label === undefined || i.labels.includes(label)) &&
      (parent === undefined || i.parent === parent) &&
      (!actionable || isActionable(i, items)),
  );
  const text =
    picked.length === 0
      ? "合う項目はありません"
      : `${picked.length} 件（上ほど優先）\n${picked.map((i) => line(i, items)).join("\n")}`;
  return ok(text + problemsNote(snapshot.problems), {
    path: snapshot.path,
    exists: true,
    items: picked.map((i) => summary(i, items)),
    ...(snapshot.problems.length > 0 ? { problems: snapshot.problems } : {}),
  });
}

async function getItem(ctx: ToolContext, id: string): Promise<ToolResult> {
  const snapshot = await ctx.store.read();
  if (snapshot.state === "missing") return fail(`まだ tasks.json がありません（${snapshot.path}）`);
  if (snapshot.state === "refused") return fail(refusal(snapshot));
  const doc: BacklogDocument = snapshot.doc;
  const item = doc.items.find((i) => i.id === id);
  if (!item) return fail(`項目「${id}」がありません`);
  const waiting = waitingOn(item, doc.items).map((i) => i.id);
  const after = dependents(item, doc.items).map((i) => i.id);
  const children = item.kind === "story" ? childrenOf(item, doc.items).map((i) => `${i.id} [${i.status}]`) : [];
  const text = [
    line(item, doc.items),
    item.doneWhen ? `完了条件：${item.doneWhen}` : "",
    item.body ? `本文：\n${item.body}` : "",
    item.resolution ? `理由：${item.resolution}` : "",
    item.labels.length > 0 ? `ラベル：${item.labels.join(", ")}` : "",
    item.dependsOn.length > 0 ? `待つもの：${item.dependsOn.join(", ")}（未完：${waiting.join(", ") || "なし"}）` : "",
    after.length > 0 ? `これを待っているもの：${after.join(", ")}` : "",
    children.length > 0 ? `タスク：${children.join(", ")}` : "",
    item.refs.length > 0 ? `参照：${item.refs.join(", ")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
  return ok(text, { item, waitingOn: waiting, dependents: after, children: childrenOf(item, doc.items).map((i) => i.id) });
}
