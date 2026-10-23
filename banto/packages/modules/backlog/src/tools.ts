// Backlog の tool（§4.4「つけ方と AI の tool」）。
//
// - **AI の6本**（agent）：listItems・getItem・createItem・updateItem・splitStory・moveItem。**消す tool は作らない**
//   （要らなくなったものは dropped で閉じれば記録が残る）。説明文は短く——全部のターンの文脈に載る
// - **人の画面の口**（admin）：getBoard と board*（書いた後の一覧ごと返す）・設定。AI には見せない
// - 書く操作は1件ごとに一覧のブランチへ1コミット（メッセージは操作の要約）。送れなかったことは返り値で言う——書き込みは
//   済んでいる。まだ送っていないこと（と理由）は、読む tool も毎回添える
//
// 返り値は AI が読みやすい短い文（content）と、同じものの構造（structuredContent）。
// 失敗は `isError` と理由の文で返す——AI にも画面にも、なぜ断ったかが届く（規則2）。

import { homedir } from "node:os";
import { basename, sep } from "node:path";
import { realpathSync } from "node:fs";
import { EFFECT_META_KEY, VISIBILITY_META_KEY, callIdOf, threadOf, type EmittedEvent } from "@banto/module-contract";
import {
  BacklogError,
  KINDS,
  PRIORITIES,
  STATUSES,
  childrenOf,
  createItem,
  dependents,
  findItem,
  isActionable,
  isClosed,
  moveItem,
  numberLabel,
  splitStory,
  updateItem,
  waitingOn,
  type BacklogDocument,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
  type ItemPatch,
  type Change,
  type ItemRef,
  type NewItemInput,
  type SplitTaskInput,
} from "./model.js";
import { conversionCommand, conversionHint, type BacklogBackend, type GistPlace, type MutateResult, type Snapshot, type SyncState } from "./store.js";
import { BACKENDS, checkGistToken, checkSshIdentity, readSettings, writeSettings, type BacklogBackendKind, type BacklogSettings } from "./settings.js";

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
/** 項目の指し方——id か番号 */
const REF = { type: ["string", "integer"], description: "id か番号（42・\"#42\"）" };
const IDS = { type: "array", items: { type: ["string", "integer"] } };
const STRS = { type: "array", items: { type: "string" } };

/** 欄を書ける tool（作る・変える）で共通の欄 */
const ITEM_FIELDS_SCHEMA = {
  title: { type: "string" },
  status: STATUS,
  parent: { type: ["string", "integer", "null"], description: "親のストーリー（タスクだけ）。id か番号" },
  dependsOn: { ...IDS, description: "終わるまで始められない項目（id か番号）" },
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

/**
 * **読むだけの tool**（追加・2026-10-20、アーキ仕様 §4.4「土台：読むだけの印」）。一覧を読むだけ——読むときに自分の置き場の写し
 * （一覧のブランチの ref）を追いつかせることはあるが、それは読むだけの定義に含めない（§4.4 の 1.）
 */
function readAgentTool(name: string, description: string, inputSchema: Record<string, unknown>) {
  const t = agentTool(name, description, inputSchema);
  return { ...t, _meta: { ...t._meta, [EFFECT_META_KEY]: "read" } };
}

function adminTool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema: { type: "object", ...inputSchema }, _meta: { [VISIBILITY_META_KEY]: "admin" } };
}

const CREATE_SCHEMA = {
  properties: { kind: KIND, id: { type: "string", description: "省けば題から作る（番号は自動）" }, ...ITEM_FIELDS_SCHEMA },
  required: ["kind", "title"],
};
const UPDATE_SCHEMA = {
  properties: {
    id: REF,
    kind: KIND,
    ...ITEM_FIELDS_SCHEMA,
    resolution: { type: ["string", "null"], description: "閉じた理由（dropped には必須）" },
  },
  required: ["id"],
};
const SPLIT_SCHEMA = {
  properties: { storyId: REF, tasks: { type: "array", items: SPLIT_TASK } },
  required: ["storyId", "tasks"],
};
const MOVE_SCHEMA = {
  properties: {
    id: REF,
    before: { ...REF, description: "この項目の前へ（上ほど先にやる）" },
    after: { ...REF, description: "この項目の後ろへ" },
  },
  required: ["id"],
};

export const TOOLS = [
  readAgentTool("listItems", "仕事の一覧（並び順＝優先順）。既定は閉じていないもの。actionable: true で今すぐ着手できるもの（ready で依存が全部 done）だけ", {
    properties: {
      kind: KIND,
      status: { type: "array", items: STATUS, description: "指定すると閉じたものも絞れる" },
      milestone: { type: "string" },
      label: { type: "string" },
      parent: { ...REF, description: "このストーリーの子だけ" },
      actionable: { type: "boolean" },
    },
  }),
  readAgentTool("getItem", "1件の中身を全部（本文・完了条件・依存・子）", { properties: { id: REF }, required: ["id"] }),
  agentTool("createItem", "1件足す（story・task・bug）。親・依存も付けられる", CREATE_SCHEMA),
  agentTool("updateItem", "欄を変える。状態を進める・閉じる（dropped は resolution 必須）・依存を張り替える（dependsOn は全体を渡す）", UPDATE_SCHEMA),
  agentTool("splitStory", "ストーリーの下に複数のタスクを1回で作る。waitsFor で同じ回のタスク間の依存", SPLIT_SCHEMA),
  agentTool("moveItem", "並び順（＝優先順）を、指定した項目の前（before）か後ろ（after）へ動かす", MOVE_SCHEMA),
  // ---- 人の画面の口（admin）——AI には見せない ----
  adminTool("getBoard", "画面が描く一覧の全部。since が今の版と同じなら unchanged だけ返す。fetch で先に origin から取ってくる（画面を開いたとき）", {
    properties: { since: { type: "string" }, fetch: { type: "boolean" } },
  }),
  adminTool("boardCreateItem", "画面から1件足す（結果は一覧ごと）", CREATE_SCHEMA),
  adminTool("boardUpdateItem", "画面から欄を変える（結果は一覧ごと）", UPDATE_SCHEMA),
  adminTool("boardSplitStory", "画面からタスクに分ける（結果は一覧ごと）", SPLIT_SCHEMA),
  adminTool("boardMoveItem", "画面から並べ替える（結果は一覧ごと）", MOVE_SCHEMA),
  adminTool("getSettings", "この Module のいまの設定（一覧の置き場・一覧を置くブランチ・送るときに使う SSH 鍵・Gist）", { properties: {} }),
  adminTool(
    "setSettings",
    "一覧の置き場（tasks-json＝リポジトリの一覧のブランチ・gist＝GitHub Gist）、一覧を置くブランチ（中は tasks.json 1つ）、送るときに使う SSH 鍵、" +
      "Gist の id と Gist に書くトークン（Vault の名前）を変える。sshIdentity は空で使わない。backend・sshIdentity・gistId・gistToken は省けばそのまま",
    {
      properties: {
        backend: { type: "string", enum: [...BACKENDS] },
        branch: { type: "string" },
        sshIdentity: { type: "string" },
        gistId: { type: "string" },
        gistToken: { type: "string" },
      },
      required: ["branch"],
    },
  ),
  adminTool("listSshIdentities", "送るときに選べる SSH 鍵（Vault の ssh-identity の alias。この Project から引けるもの）", { properties: {} }),
  adminTool("listGistTokens", "Gist に書くトークンに選べるもの（Vault の secret・oauth-token の alias。この Project から引けるもの）", { properties: {} }),
  adminTool("createGist", "非公開の Gist を新しく作り（中は空の一覧）、一覧の置き場をそこに変える。gistToken は Vault の名前", {
    properties: { gistToken: { type: "string" }, description: { type: "string" } },
    required: ["gistToken"],
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

/** 項目の指し方（id の文字列か番号）。番号は 42 でも "#42" でもよい——引くのは読んだ一覧に対して（findItem） */
function ref(args: Args, key: string): ItemRef | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && v !== "") return v;
  throw new BacklogError(`${key} は項目の id か番号です`);
}

function requiredRef(args: Args, key: string): ItemRef {
  const v = ref(args, key);
  if (v === undefined) throw new BacklogError(`${key} が要ります`);
  return v;
}

function refList(args: Args, key: string): ItemRef[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => (typeof x === "string" && x !== "") || (typeof x === "number" && Number.isInteger(x)))) {
    throw new BacklogError(`${key} は項目の id か番号の配列です`);
  }
  return v as ItemRef[];
}

/** 欄のうち項目を指すもの（親・依存）。番号で来るので、書く直前に読んだ一覧で id に引き直す */
interface RefFields {
  parent?: ItemRef | null;
  dependsOn?: ItemRef[];
}

function refFieldsFrom(args: Args): RefFields {
  const out: RefFields = {};
  const parentRaw = args.parent;
  if (parentRaw === null || parentRaw === "") out.parent = null;
  else {
    const parent = ref(args, "parent");
    if (parent !== undefined) out.parent = parent;
  }
  const dependsOn = refList(args, "dependsOn");
  if (dependsOn !== undefined) out.dependsOn = dependsOn;
  return out;
}

const idOf = (items: readonly BacklogItem[], r: ItemRef): string => findItem(items, r).id;

function resolveRefFields(items: readonly BacklogItem[], r: RefFields): { parent?: string | null; dependsOn?: string[] } {
  return {
    ...(r.parent !== undefined ? { parent: r.parent === null ? null : idOf(items, r.parent) } : {}),
    ...(r.dependsOn !== undefined ? { dependsOn: r.dependsOn.map((d) => idOf(items, d)) } : {}),
  };
}

/** 番号は振られるもの——人も AI も書けない */
function refuseNumber(args: Args): void {
  if (args.number !== undefined) throw new BacklogError("number は作るときに振られるもので、書けません");
}

function enumOf<T extends string>(values: readonly T[], args: Args, key: string): T | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new BacklogError(`${key} は ${values.join("・")} のどれかです（${JSON.stringify(v)}）`);
  }
  return v as T;
}

/** 親・依存を除いた欄（それは refFieldsFrom で読み、書く直前に引き直す） */
function patchFrom(args: Args): ItemPatch {
  refuseNumber(args);
  const patch: ItemPatch = {};
  const title = str(args, "title");
  if (title !== undefined) patch.title = title;
  const kind = enumOf<BacklogKind>(KINDS, args, "kind");
  if (kind !== undefined) patch.kind = kind;
  const status = enumOf<BacklogStatus>(STATUSES, args, "status");
  if (status !== undefined) patch.status = status;
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

function newItemFrom(args: Args): Omit<NewItemInput, "parent" | "dependsOn"> {
  const kind = enumOf<BacklogKind>(KINDS, args, "kind");
  if (kind === undefined) throw new BacklogError("kind が要ります（story・task・bug）");
  const { kind: _k, title: _t, resolution: _r, ...rest } = patchFrom(args);
  void _k;
  void _t;
  if (_r !== undefined) throw new BacklogError("resolution は閉じるときに updateItem で書きます");
  const id = str(args, "id");
  return { kind, title: requiredStr(args, "title"), ...(id !== undefined ? { id } : {}), ...rest };
}

type SplitTaskArgs = Omit<SplitTaskInput, "dependsOn"> & { dependsOn?: ItemRef[] };

function splitFrom(args: Args): { storyId: ItemRef; tasks: SplitTaskArgs[] } {
  const storyId = requiredRef(args, "storyId");
  const raw = args.tasks;
  if (!Array.isArray(raw)) throw new BacklogError("tasks は配列です");
  const tasks = raw.map((t, i): SplitTaskArgs => {
    if (typeof t !== "object" || t === null) throw new BacklogError(`tasks[${i}] はオブジェクトです`);
    const a = t as Args;
    const waitsFor = a.waitsFor;
    if (waitsFor !== undefined && (!Array.isArray(waitsFor) || !waitsFor.every((n) => Number.isInteger(n)))) {
      throw new BacklogError(`tasks[${i}].waitsFor は番号の配列です`);
    }
    const out: SplitTaskArgs = { title: requiredStr(a, "title") };
    const id = str(a, "id");
    if (id !== undefined) out.id = id;
    const doneWhen = str(a, "doneWhen");
    if (doneWhen !== undefined) out.doneWhen = doneWhen;
    const body = str(a, "body");
    if (body !== undefined) out.body = body;
    const dependsOn = refList(a, "dependsOn");
    if (dependsOn !== undefined) out.dependsOn = dependsOn;
    if (waitsFor !== undefined) out.waitsFor = waitsFor as number[];
    return out;
  });
  return { storyId, tasks };
}

function moveFrom(args: Args): { id: ItemRef; target: ItemRef; where: "before" | "after" } {
  const id = requiredRef(args, "id");
  const before = ref(args, "before");
  const after = ref(args, "after");
  if ((before === undefined) === (after === undefined)) throw new BacklogError("before か after のどちらか1つを渡します");
  return before !== undefined ? { id, target: before, where: "before" } : { id, target: after!, where: "after" };
}

// ---- 返す形 --------------------------------------------------------------------

function summary(item: BacklogItem, items: readonly BacklogItem[]) {
  return {
    id: item.id,
    number: item.number,
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

/** 番号つきの名前（`#42 slug`。番号の無い古い項目は id だけ） */
function named(item: BacklogItem): string {
  return item.number === null ? item.id : `${numberLabel(item)} ${item.id}`;
}

/** AI に見せる1行。`#番号 id [状態] 題` に、要るものだけ足す */
function line(item: BacklogItem, items: readonly BacklogItem[]): string {
  const parts = [`${named(item)} [${item.status}${isActionable(item, items) ? "・着手できる" : ""}] ${item.title}`];
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

/** 送れなかったときだけ、構造にも理由を入れる */
function pushField(written: MutateResult<unknown>): Record<string, unknown> {
  return written.push && !written.push.ok ? { pushError: written.push.message } : {};
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 読めない中身のときに言うこと（古い形なら変換の手段も——ブランチの店だけ） */
function refusal(snapshot: Extract<Snapshot, { state: "refused" }>): string {
  if (snapshot.gist) return `Gist ${snapshot.gist.id} の tasks.json を読めません：${snapshot.reason}`;
  return `ブランチ ${snapshot.branch} の tasks.json を読めません：${snapshot.reason}。` + (snapshot.legacy ? conversionHint(snapshot.branch) : "");
}

/** 置き場をまったく使えない理由（根が git でない・Gist から一度も取ってこれていない）。無ければ undefined */
function unusable(snapshot: Snapshot): string | undefined {
  return snapshot.state === "missing" ? (snapshot.notRepository ?? snapshot.unavailable) : undefined;
}

/** 書いた置き場の呼び名（「一覧のブランチ backlog」・「Gist <id> の tasks.json」） */
function placeName(where: { branch: string; gist?: GistPlace }): string {
  return where.gist ? `Gist ${where.gist.id} の tasks.json` : `一覧のブランチ ${where.branch}`;
}

/** ブランチがまだ無い（Gist に tasks.json がまだ無い）ときに言うこと（作業ツリーに一覧が残っていれば、移す道も） */
function missingNote(snapshot: Extract<Snapshot, { state: "missing" }>): string {
  const why = unusable(snapshot);
  if (why) return why;
  if (snapshot.gist) return `まだ Gist ${snapshot.gist.id} に tasks.json がありません`;
  return (
    `まだ一覧のブランチ ${snapshot.branch} がありません` +
    (snapshot.leftover
      ? `。作業ツリーに ${snapshot.leftover.path} があります——ブランチへ移すには：${snapshot.leftover.command}（自動では移しません）`
      : "")
  );
}

function problemsNote(problems: readonly string[]): string {
  return problems.length > 0 ? `\n（一覧に問題があります：${problems.join("／")}）` : "";
}

/** Gist から取ってこれなかったときの1行（出しているのは最後に取ってきた写し） */
function gistNote(snapshot: Snapshot): string {
  return snapshot.gist && snapshot.sync.fetchError ? `\n（Gist から取ってこれませんでした——最後に取ってきた中身です：${snapshot.sync.fetchError}）` : "";
}

/** origin との様子で、知らせることがあれば1行（送っていない・食い違い・取ってこれなかった） */
export function syncNote(sync: SyncState, branch: string): string {
  if (!sync.origin) return "";
  if (sync.diverged) {
    return `\n（手元と origin の ${branch} が分かれています——手元だけに ${sync.ahead} 件・origin だけに ${sync.behind} 件。揃えるまで書けません）`;
  }
  const parts: string[] = [];
  if (sync.ahead > 0) parts.push(`origin に送っていない変更が ${sync.ahead} 件あります${sync.pushError ? `（送れなかった理由：${sync.pushError}）` : ""}`);
  if (sync.fetchError) parts.push(`origin から取ってこれませんでした（${sync.fetchError}）`);
  return parts.length > 0 ? `\n（${parts.join("。")}）` : "";
}

/** 書いたあとに送れなかったときの1行（書き込みは済んでいる） */
function pushNote(written: MutateResult<unknown>): string {
  return written.push && !written.push.ok ? `\n（書き込みは済みましたが、origin に送れませんでした：${written.push.message}）` : "";
}

/** 分ける——ストーリーと依存は、書く直前に読んだ一覧で引く（番号で指されても、やり直しのたびに引き直す） */
function splitChange(
  d: BacklogDocument,
  split: ReturnType<typeof splitFrom>,
  now: string,
): Change<{ story: string; created: BacklogItem[] }> {
  const story = findItem(d.items, split.storyId);
  const tasks: SplitTaskInput[] = split.tasks.map(({ dependsOn, ...t }) => ({
    ...t,
    ...(dependsOn !== undefined ? { dependsOn: dependsOn.map((r) => idOf(d.items, r)) } : {}),
  }));
  const changed = splitStory(d, story.id, tasks, now);
  return { doc: changed.doc, result: { story: named(story), created: changed.result } };
}

function moveChange(d: BacklogDocument, move: ReturnType<typeof moveFrom>): Change<{ id: string; moved: string; target: string }> {
  const moving = findItem(d.items, move.id);
  const target = findItem(d.items, move.target);
  const changed = moveItem(d, moving.id, target.id, move.where);
  return { doc: changed.doc, result: { id: moving.id, moved: named(moving), target: named(target) } };
}

/** updateItem のコミットメッセージに添える、変えた欄（状態は行き先も） */
function describePatch(patch: Record<string, unknown>): string {
  return Object.keys(patch)
    .map((k) => (k === "status" ? `status → ${String(patch.status)}` : k))
    .join("・");
}

// ---- 処理 ----------------------------------------------------------------------

export interface ToolContext {
  store: BacklogBackend;
  root: string;
  now?: () => string;
  /** 設定で選べる SSH 鍵の一覧（Vault の目録から）。無ければ選べない */
  sshIdentities?: (callId?: string) => Promise<{ names: string[]; warning?: string }>;
  /** Gist の置き場で使う口（§4.4「Gist の置き場」）。無ければ Gist を選べない */
  gist?: {
    /** 選べるトークン（Vault の目録の secret・oauth-token） */
    tokens: (callId?: string) => Promise<{ names: string[]; warning?: string }>;
    /** そのトークンで非公開の Gist を作る */
    create: (gistToken: string, description: string, callId?: string) => Promise<GistPlace>;
  };
  /**
   * **出来事を出す**（追加・2026-10-16、アーキ仕様 §4.3「最初に出す出来事」、Backlog #347）。出口の箱に書いてから host へ
   * 出す口（`EventPublisher.publish`）。無ければ出さない
   */
  emitEvent?: (event: EmittedEvent) => void;
}

/** 出来事の名前（宣言の `events` と揃える——core の目録 `modules/declaration.ts`） */
export const ITEM_CHANGED_EVENT = "backlog.item-changed";

/**
 * **できた・状態が変わった項目の出来事**（`backlog.item-changed`）。1回の書き込みの前後を比べ、項目ごとに1件。できたものは
 * `from` を持たない。印はコミットと項目から決める（同じ書き込みを二度出さない）。`callId` はこの書き込みを頼んだ呼び出しの印
 * ——AI のターンからなら、host がそのターンのホップ＋1を付ける
 */
export function itemChangedEvents(
  before: BacklogDocument,
  after: BacklogDocument,
  commit: string,
  occurredAt: string,
  callId?: string,
): EmittedEvent[] {
  const was = new Map(before.items.map((i) => [i.id, i]));
  return after.items.flatMap((item): EmittedEvent[] => {
    const prev = was.get(item.id);
    if (prev && prev.status === item.status) return [];
    return [
      {
        name: ITEM_CHANGED_EVENT,
        eventId: `${commit}/${item.id}`,
        occurredAt,
        fields: {
          item: item.id,
          ...(item.number !== null ? { number: item.number } : {}),
          title: item.title,
          kind: item.kind,
          ...(prev ? { from: prev.status } : {}),
          to: item.status,
          labels: item.labels.join(","),
        },
        text: prev
          ? `${named(item)}「${item.title}」が ${prev.status} から ${item.status} になりました`
          : `${named(item)}「${item.title}」（${item.kind}）ができました（${item.status}）`,
        ...(callId ? { causedBy: { callId } } : {}),
      },
    ];
  });
}

/** 書き込みのあと、できた・状態が変わった項目を出来事として出す */
function announce(ctx: ToolContext, written: { before: BacklogDocument; doc: BacklogDocument; commit: string }, at: string, callId?: string): void {
  if (!ctx.emitEvent) return;
  for (const e of itemChangedEvents(written.before, written.doc, written.commit, at, callId)) ctx.emitEvent(e);
}

const where = (w: "before" | "after") => (w === "before" ? "前" : "後ろ");

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
  const base = {
    root,
    branch: snapshot.branch,
    version: snapshot.version,
    state: snapshot.state,
    sync: snapshot.sync,
    ...(snapshot.gist ? { gist: snapshot.gist } : {}),
  };
  if (snapshot.state === "missing") {
    return ok(missingNote(snapshot), {
      ...base,
      ...(snapshot.unavailable ? { unavailable: snapshot.unavailable } : {}),
      ...(snapshot.leftover ? { leftover: snapshot.leftover } : {}),
      ...(snapshot.notRepository ? { notRepository: snapshot.notRepository } : {}),
    });
  }
  if (snapshot.state === "refused") {
    return ok(refusal(snapshot), {
      ...base,
      reason: snapshot.reason,
      legacy: snapshot.legacy,
      ...(snapshot.legacy ? { convertCommand: conversionCommand(snapshot.branch) } : {}),
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
  // **中継に添える呼び出しの印**（Repositories に送ってもらうとき、どの Project・どのターンの仕事かを host が引く）
  const callId = callIdOf(meta);
  try {
    switch (name) {
      case "listItems":
        return await listItems(ctx, args);
      case "getItem":
        return await getItem(ctx, requiredRef(args, "id"));
      case "createItem": {
        const input = newItemFrom(args);
        const refs = refFieldsFrom(args);
        const written = await ctx.store.mutate(
          (d) => createItem(d, { ...input, ...resolveRefFields(d.items, refs) }, now(), thread),
          (r) => `backlog: createItem ${named(r)}`,
          callId,
        );
        announce(ctx, written, now(), callId);
        const { result, doc, branch, created } = written;
        return ok(
          `${created ? `${placeName(written)} を作り、` : ""}足しました：${line(result, doc.items)}${pushNote(written)}`,
          { item: result, branch, ...(written.gist ? { gist: written.gist } : {}), ...pushField(written) },
        );
      }
      case "updateItem": {
        const target = requiredRef(args, "id");
        const patch = patchFrom(args);
        const refs = refFieldsFrom(args);
        const written = await ctx.store.mutate(
          (d) => updateItem(d, idOf(d.items, target), { ...patch, ...resolveRefFields(d.items, refs) }, now(), thread),
          (r) => `backlog: updateItem ${named(r)}（${describePatch({ ...patch, ...refs })}）`,
          callId,
        );
        announce(ctx, written, now(), callId);
        return ok(`変えました：${line(written.result, written.doc.items)}${pushNote(written)}`, { item: written.result, ...pushField(written) });
      }
      case "splitStory": {
        const split = splitFrom(args);
        const written = await ctx.store.mutate((d) => splitChange(d, split, now()), (r) => `backlog: splitStory ${r.story}（${r.created.length} 件）`, callId);
        announce(ctx, written, now(), callId);
        const { doc } = written;
        const result = written.result.created;
        return ok(
          `「${written.result.story}」を ${result.length} 件のタスクに分けました：\n${result.map((i) => line(i, doc.items)).join("\n")}${pushNote(written)}`,
          { items: result, ...pushField(written) },
        );
      }
      case "moveItem": {
        const move = moveFrom(args);
        const written = await ctx.store.mutate((d) => moveChange(d, move), (r) => `backlog: moveItem ${r.moved}（${r.target} の${where(move.where)}）`, callId);
        const { moved, target, id } = written.result;
        const index = written.doc.items.findIndex((i) => i.id === id);
        return ok(`「${moved}」を「${target}」の${where(move.where)}へ動かしました（上から ${index + 1} 番目）${pushNote(written)}`, {
          id,
          index,
          ...pushField(written),
        });
      }
      case "getBoard":
        // 画面を開いたときだけ取ってくる（3秒ごとの読み直しでは取ってこない）
        if (args.fetch === true) await ctx.store.refresh(callId);
        return await board(ctx, str(args, "since"));
      case "boardCreateItem": {
        const input = newItemFrom(args);
        const refs = refFieldsFrom(args);
        announce(ctx, await ctx.store.mutate((d) => createItem(d, { ...input, ...resolveRefFields(d.items, refs) }, now()), (r) => `backlog: createItem ${named(r)}`, callId), now(), callId);
        return await board(ctx);
      }
      case "boardUpdateItem": {
        const target = requiredRef(args, "id");
        const patch = patchFrom(args);
        const refs = refFieldsFrom(args);
        const written = await ctx.store.mutate(
          (d) => updateItem(d, idOf(d.items, target), { ...patch, ...resolveRefFields(d.items, refs) }, now()),
          (r) => `backlog: updateItem ${named(r)}（${describePatch({ ...patch, ...refs })}）`,
          callId,
        );
        announce(ctx, written, now(), callId);
        return await board(ctx);
      }
      case "boardSplitStory": {
        const split = splitFrom(args);
        announce(ctx, await ctx.store.mutate((d) => splitChange(d, split, now()), (r) => `backlog: splitStory ${r.story}（${r.created.length} 件）`, callId), now(), callId);
        return await board(ctx);
      }
      case "boardMoveItem": {
        const move = moveFrom(args);
        await ctx.store.mutate((d) => moveChange(d, move), (r) => `backlog: moveItem ${r.moved}（${r.target} の${where(move.where)}）`, callId);
        return await board(ctx);
      }
      case "getSettings":
        return settingsResult(readSettings());
      case "setSettings": {
        const current = readSettings();
        const asked = str(args, "sshIdentity");
        const sshIdentity = asked === undefined ? current.sshIdentity : checkSshIdentity(asked);
        // 選び直したものは、Vault の目録（この Project から引けるもの）に在ることを確かめる——無い名前を保存して、
        // 送るときに初めて失敗させない。そのままのもの（Vault が一時読めない等）は確かめ直さない
        if (sshIdentity && sshIdentity !== current.sshIdentity) {
          if (!ctx.sshIdentities) return fail("この Backlog は Vault を呼べないので、SSH 鍵を選べません");
          let names: string[];
          try {
            ({ names } = await ctx.sshIdentities(callId));
          } catch (err) {
            return fail(`Vault の SSH 鍵の一覧を読めません：${(err as Error).message}`);
          }
          if (!names.includes(sshIdentity)) return fail(`${sshIdentity} は、この Project から使える Vault の SSH 鍵（ssh-identity）にありません`);
        }
        const backend = enumOf<BacklogBackendKind>(BACKENDS, args, "backend") ?? current.backend;
        const gistId = str(args, "gistId") ?? current.gistId;
        const askedToken = str(args, "gistToken");
        const gistToken = askedToken === undefined ? current.gistToken : checkGistToken(askedToken);
        // トークンも同じ——選び直したものだけ、目録に在ることを確かめる
        if (gistToken && gistToken !== current.gistToken) {
          const why = await missingToken(ctx, gistToken, callId);
          if (why) return fail(why);
        }
        const saved = writeSettings({
          backend,
          branch: requiredStr(args, "branch"),
          ...(sshIdentity ? { sshIdentity } : {}),
          ...(gistId ? { gistId } : {}),
          ...(gistToken ? { gistToken } : {}),
        });
        return settingsResult(saved);
      }
      case "listGistTokens": {
        if (!ctx.gist) return fail("この Backlog は Vault を呼べないので、Gist のトークンを選べません");
        try {
          const listed = await ctx.gist.tokens(callId);
          return ok(JSON.stringify(listed), { ...listed });
        } catch (err) {
          return fail(`Vault のトークンの一覧を読めません：${(err as Error).message}`);
        }
      }
      case "createGist": {
        if (!ctx.gist) return fail("この Backlog は Vault を呼べないので、Gist を作れません");
        const gistToken = checkGistToken(requiredStr(args, "gistToken"));
        if (!gistToken) return fail("gistToken が要ります");
        const current = readSettings();
        if (gistToken !== current.gistToken) {
          const why = await missingToken(ctx, gistToken, callId);
          if (why) return fail(why);
        }
        const description = str(args, "description") ?? `banto Backlog（${basename(ctx.root)}）`;
        let place: GistPlace;
        try {
          place = await ctx.gist.create(gistToken, description, callId);
        } catch (err) {
          return fail(`Gist を作れませんでした：${(err as Error).message}`);
        }
        // 作れたのに設定を書けなかったら、そう言う（作った Gist の場所も——人がそれを選び直せるように）
        try {
          const saved = writeSettings({ ...current, backend: "gist", gistId: place.id, gistToken });
          return settingsResult(saved, `非公開の Gist を作り、一覧の置き場にしました（${place.url}）`);
        } catch (err) {
          return fail(`Gist は作りました（${place.url}）が、設定を書けませんでした：${(err as Error).message}`);
        }
      }
      case "listSshIdentities": {
        if (!ctx.sshIdentities) return fail("この Backlog は Vault を呼べないので、SSH 鍵を選べません");
        try {
          const listed = await ctx.sshIdentities(callId);
          return ok(JSON.stringify(listed), { ...listed });
        } catch (err) {
          return fail(`Vault の SSH 鍵の一覧を読めません：${(err as Error).message}`);
        }
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
  const parentRef = ref(args, "parent");
  const actionable = args.actionable === true;

  const snapshot = await ctx.store.read();
  if (snapshot.state === "missing") {
    const why = unusable(snapshot);
    if (why) return fail(why);
    return ok(`${missingNote(snapshot)}。createItem で最初の項目を足すと作ります${gistNote(snapshot)}`, {
      branch: snapshot.branch,
      ...(snapshot.gist ? { gist: snapshot.gist } : {}),
      exists: false,
      items: [],
      ...(snapshot.leftover ? { leftover: snapshot.leftover } : {}),
    });
  }
  if (snapshot.state === "refused") return fail(refusal(snapshot));
  const items = snapshot.doc.items;
  const parent = parentRef === undefined ? undefined : idOf(items, parentRef);
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
  return ok(text + problemsNote(snapshot.problems) + syncNote(snapshot.sync, snapshot.branch) + gistNote(snapshot), {
    branch: snapshot.branch,
    ...(snapshot.gist ? { gist: snapshot.gist } : {}),
    exists: true,
    items: picked.map((i) => summary(i, items)),
    sync: snapshot.sync,
    ...(snapshot.problems.length > 0 ? { problems: snapshot.problems } : {}),
  });
}

async function getItem(ctx: ToolContext, target: ItemRef): Promise<ToolResult> {
  const snapshot = await ctx.store.read();
  if (snapshot.state === "missing") return fail(missingNote(snapshot));
  if (snapshot.state === "refused") return fail(refusal(snapshot));
  const doc: BacklogDocument = snapshot.doc;
  const item = findItem(doc.items, target);
  const waiting = waitingOn(item, doc.items).map((i) => i.id);
  const after = dependents(item, doc.items).map((i) => i.id);
  const children = item.kind === "story" ? childrenOf(item, doc.items).map((i) => `${named(i)} [${i.status}]`) : [];
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

/** 設定の返し方（画面と同じ形。無いものは null） */
function settingsResult(s: BacklogSettings, text?: string): ToolResult {
  return ok(text ?? JSON.stringify(s), {
    backend: s.backend,
    branch: s.branch,
    sshIdentity: s.sshIdentity ?? null,
    gistId: s.gistId ?? null,
    gistUrl: s.gistId ? `https://gist.github.com/${s.gistId}` : null,
    gistToken: s.gistToken ?? null,
  });
}

/** そのトークンの名前が Vault の目録（この Project から引けるもの）に無ければ、その理由 */
async function missingToken(ctx: ToolContext, gistToken: string, callId: string | undefined): Promise<string | undefined> {
  if (!ctx.gist) return "この Backlog は Vault を呼べないので、Gist のトークンを選べません";
  let names: string[];
  try {
    ({ names } = await ctx.gist.tokens(callId));
  } catch (err) {
    return `Vault のトークンの一覧を読めません：${(err as Error).message}`;
  }
  return names.includes(gistToken) ? undefined : `${gistToken} は、この Project から使える Vault のトークン（secret・oauth-token）にありません`;
}
