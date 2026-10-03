// Backlog の形（`banto-backlog/1`、docs/specs/v4-modules.md §4.4）と、それに対する操作。
//
// **ここは純関数だけ**——ファイルにも時計にも触らない（時刻は呼び出し側が渡す）。店（store.ts）と
// 人の画面（ui/）の両方がこれを使う。画面は tsc の CommonJS 出力を bundle するので、ここから
// node のモジュールを import しない。
//
// 操作は「変えた結果の文書」を返し、**変えてよいかは文書全体の検証で決める**（validateDocument）。
// 違反は理由を言って断る——黙って直さない（規則2）。

export const BACKLOG_FORMAT = "banto-backlog/1";

export const KINDS = ["story", "task", "bug"] as const;
export const STATUSES = ["backlog", "ready", "in-progress", "done", "dropped"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const MILESTONE_STATUSES = ["open", "closed"] as const;

export type BacklogKind = (typeof KINDS)[number];
export type BacklogStatus = (typeof STATUSES)[number];
export type BacklogPriority = (typeof PRIORITIES)[number];

export interface BacklogMilestone {
  id: string;
  title: string;
  status: (typeof MILESTONE_STATUSES)[number];
}

export interface BacklogThreadRef {
  projectId: string;
  threadId: string;
}

export interface BacklogItem {
  id: string;
  kind: BacklogKind;
  title: string;
  status: BacklogStatus;
  parent: string | null;
  dependsOn: string[];
  milestone: string | null;
  priority: BacklogPriority;
  labels: string[];
  body: string;
  doneWhen: string;
  resolution: string | null;
  refs: string[];
  threads: BacklogThreadRef[];
  /** 古い形から移したもので日時が分からないときだけ `null` */
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  extra: Record<string, unknown>;
}

export interface BacklogDocument {
  format: typeof BACKLOG_FORMAT;
  milestones: BacklogMilestone[];
  /** ファイルの中の順＝優先順（§4.4） */
  items: BacklogItem[];
  /** 上の3つに無い、運びたいもの（移したときの古い見出しなど）。中身は読まずにそのまま残す */
  extra?: Record<string, unknown>;
}

/** 書くときの欄の順（git の差分が読めるように固定する） */
export const ITEM_FIELDS = [
  "id",
  "kind",
  "title",
  "status",
  "parent",
  "dependsOn",
  "milestone",
  "priority",
  "labels",
  "body",
  "doneWhen",
  "resolution",
  "refs",
  "threads",
  "createdAt",
  "updatedAt",
  "closedAt",
  "extra",
] as const satisfies readonly (keyof BacklogItem)[];

export class BacklogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacklogError";
  }
}

// ---- 読む（JSON → 形）-------------------------------------------------------

/** 読めなかった理由。`legacy` は「古い tasks.json の形」——変換の手段を案内する */
export type ParseOutcome =
  | { ok: true; doc: BacklogDocument }
  | { ok: false; legacy: boolean; reason: string };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ID_MAX = 80;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id) && id.length <= ID_MAX;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function oneOf<T extends string>(values: readonly T[], x: unknown): x is T {
  return typeof x === "string" && (values as readonly string[]).includes(x);
}

/**
 * JSON の値を `banto-backlog/1` として読む。**欄が無いものは既定で埋める**（手で書いた項目が
 * `labels` を省いても読める）が、**型が違うもの・知らない欄は断る**（どこが違うかを言う）。
 */
export function parseDocument(raw: unknown): ParseOutcome {
  if (!isRecord(raw)) {
    return { ok: false, legacy: false, reason: "JSON のいちばん外側がオブジェクトではありません" };
  }
  if (raw.format !== BACKLOG_FORMAT) {
    // 今の docs/tasks.json（tasks 配列・phase）の形
    if (raw.format === undefined && Array.isArray(raw.tasks)) {
      return {
        ok: false,
        legacy: true,
        reason: `古い tasks.json の形です（"tasks" の配列で、"format": "${BACKLOG_FORMAT}" がありません）`,
      };
    }
    return {
      ok: false,
      legacy: false,
      reason:
        raw.format === undefined
          ? `"format": "${BACKLOG_FORMAT}" がありません`
          : `format が ${JSON.stringify(raw.format)} です（読めるのは ${BACKLOG_FORMAT} だけ）`,
    };
  }
  for (const key of Object.keys(raw)) {
    if (!["format", "milestones", "items", "extra"].includes(key)) {
      return { ok: false, legacy: false, reason: `いちばん外側に知らない欄 "${key}" があります（運びたいものは "extra" に入れます）` };
    }
  }
  const milestonesRaw = raw.milestones ?? [];
  if (!Array.isArray(milestonesRaw)) return { ok: false, legacy: false, reason: '"milestones" が配列ではありません' };
  const itemsRaw = raw.items ?? [];
  if (!Array.isArray(itemsRaw)) return { ok: false, legacy: false, reason: '"items" が配列ではありません' };
  if (raw.extra !== undefined && !isRecord(raw.extra)) {
    return { ok: false, legacy: false, reason: '"extra" がオブジェクトではありません' };
  }

  const milestones: BacklogMilestone[] = [];
  for (const [i, m] of milestonesRaw.entries()) {
    const where = `milestones[${i}]`;
    if (!isRecord(m)) return { ok: false, legacy: false, reason: `${where} がオブジェクトではありません` };
    if (typeof m.id !== "string" || m.id === "") return { ok: false, legacy: false, reason: `${where}.id がありません` };
    if (typeof m.title !== "string") return { ok: false, legacy: false, reason: `${where}.title が文字列ではありません` };
    const status = m.status ?? "open";
    if (!oneOf(MILESTONE_STATUSES, status)) {
      return { ok: false, legacy: false, reason: `${where}.status は open か closed です（${JSON.stringify(m.status)}）` };
    }
    for (const key of Object.keys(m)) {
      if (!["id", "title", "status"].includes(key)) {
        return { ok: false, legacy: false, reason: `${where} に知らない欄 "${key}" があります` };
      }
    }
    milestones.push({ id: m.id, title: m.title, status });
  }

  const items: BacklogItem[] = [];
  for (const [i, it] of itemsRaw.entries()) {
    const outcome = parseItem(it, `items[${i}]`);
    if (typeof outcome === "string") return { ok: false, legacy: false, reason: outcome };
    items.push(outcome);
  }
  return {
    ok: true,
    doc: {
      format: BACKLOG_FORMAT,
      milestones,
      items,
      ...(raw.extra !== undefined ? { extra: raw.extra as Record<string, unknown> } : {}),
    },
  };
}

function parseItem(it: unknown, at: string): BacklogItem | string {
  if (!isRecord(it)) return `${at} がオブジェクトではありません`;
  const where = typeof it.id === "string" ? `${at}（${it.id}）` : at;
  for (const key of Object.keys(it)) {
    if (!(ITEM_FIELDS as readonly string[]).includes(key)) {
      return `${where} に知らない欄 "${key}" があります（運びたいものは "extra" に入れます）`;
    }
  }
  if (typeof it.id !== "string") return `${at}.id がありません`;
  if (!oneOf(KINDS, it.kind)) return `${where}.kind は story・task・bug のどれかです（${JSON.stringify(it.kind)}）`;
  if (typeof it.title !== "string") return `${where}.title が文字列ではありません`;
  if (!oneOf(STATUSES, it.status)) {
    return `${where}.status は backlog・ready・in-progress・done・dropped のどれかです（${JSON.stringify(it.status)}）`;
  }
  const str = (key: string, fallback: string): string | Error => {
    const v = it[key] ?? fallback;
    return typeof v === "string" ? v : new Error(`${where}.${key} が文字列ではありません`);
  };
  const nullableStr = (key: string): string | null | Error => {
    const v = it[key] ?? null;
    return v === null || typeof v === "string" ? v : new Error(`${where}.${key} が文字列か null ではありません`);
  };
  const strList = (key: string): string[] | Error => {
    const v = it[key] ?? [];
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? [...(v as string[])]
      : new Error(`${where}.${key} が文字列の配列ではありません`);
  };
  const priority = it.priority ?? "normal";
  if (!oneOf(PRIORITIES, priority)) return `${where}.priority は high・normal・low のどれかです（${JSON.stringify(it.priority)}）`;
  const threadsRaw = it.threads ?? [];
  if (!Array.isArray(threadsRaw)) return `${where}.threads が配列ではありません`;
  const threads: BacklogThreadRef[] = [];
  for (const t of threadsRaw) {
    if (!isRecord(t) || typeof t.projectId !== "string" || typeof t.threadId !== "string") {
      return `${where}.threads の中身は { projectId, threadId } です`;
    }
    threads.push({ projectId: t.projectId, threadId: t.threadId });
  }
  const extra = it.extra ?? {};
  if (!isRecord(extra)) return `${where}.extra がオブジェクトではありません`;

  const fields = {
    parent: nullableStr("parent"),
    dependsOn: strList("dependsOn"),
    milestone: nullableStr("milestone"),
    labels: strList("labels"),
    body: str("body", ""),
    doneWhen: str("doneWhen", ""),
    resolution: nullableStr("resolution"),
    refs: strList("refs"),
    createdAt: nullableStr("createdAt"),
    updatedAt: nullableStr("updatedAt"),
    closedAt: nullableStr("closedAt"),
  };
  for (const v of Object.values(fields)) if (v instanceof Error) return v.message;
  const f = fields as { [K in keyof typeof fields]: Exclude<(typeof fields)[K], Error> };
  return {
    id: it.id,
    kind: it.kind,
    title: it.title,
    status: it.status,
    parent: f.parent,
    dependsOn: f.dependsOn,
    milestone: f.milestone,
    priority,
    labels: f.labels,
    body: f.body,
    doneWhen: f.doneWhen,
    resolution: f.resolution,
    refs: f.refs,
    threads,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    closedAt: f.closedAt,
    extra: { ...extra },
  };
}

// ---- 書く（形 → JSON の文字列）-------------------------------------------------

/** 2字下げ・末尾改行・欄の順を固定（`ITEM_FIELDS`） */
export function serializeDocument(doc: BacklogDocument): string {
  const ordered = {
    format: doc.format,
    milestones: doc.milestones.map((m) => ({ id: m.id, title: m.title, status: m.status })),
    items: doc.items.map((item) => Object.fromEntries(ITEM_FIELDS.map((k) => [k, item[k]]))),
    ...(doc.extra !== undefined ? { extra: doc.extra } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function emptyDocument(): BacklogDocument {
  return { format: BACKLOG_FORMAT, milestones: [], items: [] };
}

// ---- 検証 -------------------------------------------------------------------

/**
 * 文書全体の決まりごと。破っているものを**全部**、人が読める文で返す（空なら問題なし）。
 * 店は「変える前に無かった問題が、変えた後に増えるなら断る」に使う——手で直した
 * ファイルに前からある問題で、関係のない操作まで止めないため
 */
export function validateDocument(doc: BacklogDocument): string[] {
  const problems: string[] = [];
  const byId = new Map<string, BacklogItem>();
  for (const item of doc.items) {
    if (!isValidId(item.id)) {
      problems.push(`id「${item.id}」は使えません（英小文字・数字と - . _ だけ、${ID_MAX} 字まで）`);
    }
    if (byId.has(item.id)) problems.push(`id「${item.id}」が2つあります`);
    else byId.set(item.id, item);
  }
  const milestoneIds = new Set(doc.milestones.map((m) => m.id));
  const seenMilestones = new Set<string>();
  for (const m of doc.milestones) {
    if (seenMilestones.has(m.id)) problems.push(`マイルストーン「${m.id}」が2つあります`);
    seenMilestones.add(m.id);
  }
  for (const item of doc.items) {
    const name = `「${item.id}」`;
    if (item.title.trim() === "") problems.push(`${name}の題が空です`);
    if (item.parent !== null) {
      const parent = byId.get(item.parent);
      if (item.kind !== "task") problems.push(`${name}は${KIND_NAME[item.kind]}なので親を持てません（親を持てるのはタスクだけ）`);
      if (!parent) problems.push(`${name}の親「${item.parent}」がありません`);
      else if (parent.kind !== "story") problems.push(`${name}の親「${item.parent}」はストーリーではありません（親にできるのはストーリーだけ）`);
    }
    const seenDeps = new Set<string>();
    for (const dep of item.dependsOn) {
      if (dep === item.id) problems.push(`${name}が自分自身を待っています`);
      else if (!byId.has(dep)) problems.push(`${name}が待つ「${dep}」がありません`);
      if (seenDeps.has(dep)) problems.push(`${name}が「${dep}」を2回待っています`);
      seenDeps.add(dep);
    }
    if (item.milestone !== null && !milestoneIds.has(item.milestone)) {
      problems.push(`${name}のマイルストーン「${item.milestone}」がありません`);
    }
    if (item.status === "dropped" && (item.resolution ?? "").trim() === "") {
      problems.push(`${name}をやめるには理由（resolution）が要ります`);
    }
    if (!isClosed(item) && item.closedAt !== null) {
      problems.push(`${name}は閉じていないのに closedAt があります`);
    }
  }
  for (const cycle of findCycles(doc.items)) {
    problems.push(`依存が輪になっています：${cycle.join(" → ")}`);
  }
  return problems;
}

const KIND_NAME: Record<BacklogKind, string> = { story: "ストーリー", task: "タスク", bug: "バグ" };

/** 依存の輪（自分自身を待つものは別に言うので除く）。輪ごとに1つ、最初の項目に戻る形で返す */
export function findCycles(items: readonly BacklogItem[]): string[][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      const s = state.get(dep);
      if (s === "visiting") cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      else if (s === undefined) visit(dep);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const item of items) if (!state.has(item.id)) visit(item.id);
  return cycles;
}

// ---- 読み取りの道具（画面と tool が共有）---------------------------------------

export function isClosed(item: Pick<BacklogItem, "status">): boolean {
  return item.status === "done" || item.status === "dropped";
}

/** まだ終わっていない依存。やめたものも「終わっていない」扱い（§4.4「依存が全部 done」の裏返し） */
export function waitingOn(item: BacklogItem, items: readonly BacklogItem[]): BacklogItem[] {
  return item.dependsOn
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is BacklogItem => i !== undefined && i.status !== "done");
}

/** いま着手できる——状態が ready で、依存が全部 done（listItems の `actionable`） */
export function isActionable(item: BacklogItem, items: readonly BacklogItem[]): boolean {
  return item.status === "ready" && item.dependsOn.every((id) => items.find((i) => i.id === id)?.status === "done");
}

/** これを待っているもの（依存の逆向き） */
export function dependents(item: BacklogItem, items: readonly BacklogItem[]): BacklogItem[] {
  return items.filter((i) => i.dependsOn.includes(item.id));
}

export function childrenOf(story: BacklogItem, items: readonly BacklogItem[]): BacklogItem[] {
  return items.filter((i) => i.parent === story.id);
}

/** 一覧で見せる状態。status に「待っているか」を重ねたもの */
export type RankState = "actionable" | "in-progress" | "waiting" | "backlog" | "done" | "dropped";

export function rankState(item: BacklogItem, items: readonly BacklogItem[]): RankState {
  if (item.status === "done") return "done";
  if (item.status === "dropped") return "dropped";
  if (item.status === "in-progress") return "in-progress";
  if (waitingOn(item, items).length > 0) return "waiting";
  if (isActionable(item, items)) return "actionable";
  return "backlog";
}

// ---- 変える ------------------------------------------------------------------

/** 題から読める id を作る。英数字が拾えなければ `item-n`。ぶつかれば番号を足す */
export function makeId(title: string, taken: ReadonlySet<string>): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (base === "") {
    for (let n = 1; ; n++) if (!taken.has(`item-${n}`)) return `item-${n}`;
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export interface NewItemInput {
  kind: BacklogKind;
  title: string;
  /** 指定しなければ題から作る */
  id?: string;
  status?: BacklogStatus;
  parent?: string | null;
  dependsOn?: string[];
  milestone?: string | null;
  priority?: BacklogPriority;
  labels?: string[];
  body?: string;
  doneWhen?: string;
  refs?: string[];
}

export interface Change<T> {
  doc: BacklogDocument;
  result: T;
}

function addThread(threads: BacklogThreadRef[], thread: BacklogThreadRef | undefined): BacklogThreadRef[] {
  if (!thread) return threads;
  if (threads.some((t) => t.projectId === thread.projectId && t.threadId === thread.threadId)) return threads;
  return [...threads, thread];
}

function requireItem(doc: BacklogDocument, id: string): BacklogItem {
  const item = doc.items.find((i) => i.id === id);
  if (!item) throw new BacklogError(`項目「${id}」がありません`);
  return item;
}

/** 置き場所：親があれば親の最後の子の後ろ（ストーリーの下にまとまる）、無ければ末尾＝いちばん低い優先 */
function insertIndex(items: readonly BacklogItem[], parent: string | null): number {
  if (parent === null) return items.length;
  let last = -1;
  items.forEach((i, index) => {
    if (i.id === parent || i.parent === parent) last = index;
  });
  return last < 0 ? items.length : last + 1;
}

function buildItem(
  doc: BacklogDocument,
  input: NewItemInput,
  now: string,
  taken: Set<string>,
  thread?: BacklogThreadRef,
): BacklogItem {
  const title = input.title.trim();
  if (title === "") throw new BacklogError("題が空です");
  let id: string;
  if (input.id !== undefined) {
    if (!isValidId(input.id)) throw new BacklogError(`id「${input.id}」は使えません（英小文字・数字と - . _ だけ）`);
    if (taken.has(input.id)) throw new BacklogError(`id「${input.id}」はもう使われています`);
    id = input.id;
  } else {
    id = makeId(title, taken);
  }
  taken.add(id);
  const parent = input.parent ?? null;
  const parentItem = parent !== null ? doc.items.find((i) => i.id === parent) : undefined;
  const status = input.status ?? "backlog";
  return {
    id,
    kind: input.kind,
    title,
    status,
    parent,
    dependsOn: [...(input.dependsOn ?? [])],
    milestone: input.milestone !== undefined ? input.milestone : (parentItem?.milestone ?? null),
    priority: input.priority ?? "normal",
    labels: [...(input.labels ?? [])],
    body: input.body ?? "",
    doneWhen: input.doneWhen ?? "",
    resolution: null,
    refs: [...(input.refs ?? [])],
    // 進めている・閉じた状態で作ったなら、その Thread で取り組んだことになる（updateItem と同じ決まり）
    threads: status === "in-progress" || isClosed({ status }) ? addThread([], thread) : [],
    createdAt: now,
    updatedAt: now,
    closedAt: isClosed({ status }) ? now : null,
    extra: {},
  };
}

export function createItem(
  doc: BacklogDocument,
  input: NewItemInput,
  now: string,
  thread?: BacklogThreadRef,
): Change<BacklogItem> {
  const item = buildItem(doc, input, now, new Set(doc.items.map((i) => i.id)), thread);
  const at = insertIndex(doc.items, item.parent);
  return { doc: { ...doc, items: [...doc.items.slice(0, at), item, ...doc.items.slice(at)] }, result: item };
}

export interface ItemPatch {
  title?: string;
  kind?: BacklogKind;
  status?: BacklogStatus;
  parent?: string | null;
  dependsOn?: string[];
  milestone?: string | null;
  priority?: BacklogPriority;
  labels?: string[];
  body?: string;
  doneWhen?: string;
  resolution?: string | null;
  refs?: string[];
}

/**
 * 欄を変える。閉じれば `closedAt`、開き直せば `closedAt` と `resolution` を消す。
 * **呼び出し元の Thread**（`thread`）は、進めた（in-progress にした）・閉じたときにだけ足す
 */
export function updateItem(
  doc: BacklogDocument,
  id: string,
  patch: ItemPatch,
  now: string,
  thread?: BacklogThreadRef,
): Change<BacklogItem> {
  const before = requireItem(doc, id);
  const next: BacklogItem = { ...before, updatedAt: now };
  for (const key of Object.keys(patch) as (keyof ItemPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  if (patch.title !== undefined) {
    next.title = patch.title.trim();
    if (next.title === "") throw new BacklogError("題が空です");
  }
  if (patch.status !== undefined && patch.status !== before.status) {
    const closed = isClosed(next);
    if (closed && !isClosed(before)) next.closedAt = now;
    if (!closed) {
      next.closedAt = null;
      if (patch.resolution === undefined) next.resolution = null;
    }
    // やめた理由を「終わった」に持ち越さない（理由を書き直すなら patch で渡す）
    if (next.status === "done" && before.status === "dropped" && patch.resolution === undefined) next.resolution = null;
    if (next.status === "in-progress" || closed) next.threads = addThread(next.threads, thread);
  }
  return { doc: { ...doc, items: doc.items.map((i) => (i.id === id ? next : i)) }, result: next };
}

export interface SplitTaskInput {
  title: string;
  id?: string;
  doneWhen?: string;
  body?: string;
  status?: BacklogStatus;
  labels?: string[];
  priority?: BacklogPriority;
  /** すでにある項目のうち、終わるまで始められないもの */
  dependsOn?: string[];
  /** 同じ回に作るタスクのうち、待つもの（0 から数えた番号） */
  waitsFor?: number[];
}

/** ストーリーの下に複数のタスクを1回で作る。既定の状態は ready（分けた＝着手できる形になった） */
export function splitStory(
  doc: BacklogDocument,
  storyId: string,
  tasks: readonly SplitTaskInput[],
  now: string,
): Change<BacklogItem[]> {
  const story = requireItem(doc, storyId);
  if (story.kind !== "story") throw new BacklogError(`「${storyId}」はストーリーではありません（分けられるのはストーリーだけ）`);
  if (tasks.length === 0) throw new BacklogError("分けるタスクが1つもありません");
  const taken = new Set(doc.items.map((i) => i.id));
  const created: BacklogItem[] = tasks.map((t) =>
    buildItem(
      doc,
      {
        kind: "task",
        title: t.title,
        ...(t.id !== undefined ? { id: t.id } : {}),
        status: t.status ?? "ready",
        parent: storyId,
        ...(t.doneWhen !== undefined ? { doneWhen: t.doneWhen } : {}),
        ...(t.body !== undefined ? { body: t.body } : {}),
        ...(t.labels !== undefined ? { labels: t.labels } : {}),
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        dependsOn: t.dependsOn ?? [],
      },
      now,
      taken,
    ),
  );
  tasks.forEach((t, i) => {
    for (const n of t.waitsFor ?? []) {
      const target = created[n];
      if (!Number.isInteger(n) || !target) {
        throw new BacklogError(`${i} 番目のタスクの waitsFor に ${n} があります（0〜${created.length - 1} の番号です）`);
      }
      if (!created[i]!.dependsOn.includes(target.id)) created[i]!.dependsOn.push(target.id);
    }
  });
  const at = insertIndex(doc.items, storyId);
  return {
    doc: { ...doc, items: [...doc.items.slice(0, at), ...created, ...doc.items.slice(at)] },
    result: created,
  };
}

/** 並び順（＝優先順）を、指定した項目の前か後ろへ動かす */
export function moveItem(
  doc: BacklogDocument,
  id: string,
  targetId: string,
  where: "before" | "after",
): Change<BacklogItem> {
  if (id === targetId) throw new BacklogError("自分の前後には動かせません");
  const moving = requireItem(doc, id);
  requireItem(doc, targetId);
  const rest = doc.items.filter((i) => i.id !== id);
  const t = rest.findIndex((i) => i.id === targetId);
  const at = where === "before" ? t : t + 1;
  return { doc: { ...doc, items: [...rest.slice(0, at), moving, ...rest.slice(at)] }, result: moving };
}
