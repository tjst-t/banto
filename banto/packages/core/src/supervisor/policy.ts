// **番頭の方針**（決定・2026-10-21、ユーザー。アーキ仕様 §4.5「方針」「問いの種類」）。
//
// 任せてよいことは「行い（action）」の表で持つ。まとめの決めることの種類（`decisions[].kind`）と、止まった会話に頼める手順
// （`instruct_thread` の `action`）は同じ表を引く（規則3——写しを持たない）。仕様の向き・公開・お金・消す操作は、どの方針でも任せられない。
//
// 置き場は Configuration（§2.6、平らな鍵）。instance の層が banto 全体の方針、Project の層は差分（足す・外す）と追記。
// **方針を書けるのは画面の人だけ**——AI の tool には出さない。

import type { RuntimeConfigStore, RuntimeConfigValue } from "../config/runtime.js";

/** 任せてよい行い（表の順）。`release` だけ既定は人 */
export const SUPERVISOR_ACTIONS = [
  "continue",
  "retry-turn",
  "rerun-tests",
  "fix-tests",
  "merge",
  "push",
  "release",
  "backlog",
  "minor-design",
] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];

/** どの方針でも任せられない種類 */
export const HUMAN_ONLY_KINDS = ["spec", "publish", "money", "destructive"] as const;
export type HumanOnlyKind = (typeof HUMAN_ONLY_KINDS)[number];

/** まとめの決めることの種類（`decisions[].kind`） */
export const DECISION_KINDS = [...SUPERVISOR_ACTIONS, ...HUMAN_ONLY_KINDS] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** 行いの題（画面・送る文・AI への説明で使う） */
export const ACTION_TITLES: Readonly<Record<DecisionKind, string>> = {
  continue: "続ける（前のまとめの残りを進める）",
  "retry-turn": "失敗した・途中で切れたターンをやり直す",
  "rerun-tests": "試験を流し直す",
  "fix-tests": "落ちた試験を直す（試験を消す・弱める・仕様を変える直しは除く）",
  merge: "作業ブランチを Project の決まりどおり main に取り込む",
  push: "自分の Project のリポジトリへ push する",
  release: "release に反映する（載せ方と試験は Project の決まりどおり）",
  backlog: "Backlog の状態を実際に合わせて更新する",
  "minor-design": "今の仕様に収まる小さな設計の判断（画面の文言・tool の引数の形など）",
  spec: "仕様・アーキテクチャの向き",
  publish: "外への公開（Publish・公開のリポジトリ・公開サイトへの push を含む）",
  money: "お金",
  destructive: "消す・取り消せない操作",
};

/** 既定で任せる行い（全体の方針に値が無いとき） */
export const DEFAULT_DELEGATE: readonly SupervisorAction[] = SUPERVISOR_ACTIONS.filter((a) => a !== "release");

export const SUPERVISOR_KEYS = {
  delegate: "supervisor.delegate",
  note: "supervisor.note",
  patrolHours: "supervisor.patrolHours",
  idleHours: "supervisor.idleHours",
  runsPerHour: "supervisor.limits.runsPerHour",
  instructionsPerHour: "supervisor.limits.instructionsPerHour",
  factoryConcurrent: "supervisor.limits.factoryConcurrent",
  timeZone: "supervisor.timeZone",
} as const;

export const SUPERVISOR_DEFAULTS = {
  patrolHours: 3,
  idleHours: 12,
  runsPerHour: 12,
  instructionsPerHour: 10,
  factoryConcurrent: 2,
} as const;

/** その Project で効いている方針（全体＋Project の差分を重ねたもの） */
export interface SupervisorPolicy {
  /** 任せる行い（表の順） */
  delegate: SupervisorAction[];
  /** 方針の文（全体の文に Project の追記を続けたもの）。無ければ空 */
  note: string;
  patrolHours: number;
  idleHours: number;
  limits: { runsPerHour: number; instructionsPerHour: number; factoryConcurrent: number };
  /** 1日の数え・まとめの時刻のタイムゾーン。無ければ banto が動いている場所のもの */
  timeZone?: string;
  /** 読めなかった値（黙らずに画面と記録に出す——規則2）。読めないものは任せない側に倒す */
  problems: string[];
}

export function isSupervisorAction(v: unknown): v is SupervisorAction {
  return typeof v === "string" && (SUPERVISOR_ACTIONS as readonly string[]).includes(v);
}

export function isDecisionKind(v: unknown): v is DecisionKind {
  return typeof v === "string" && (DECISION_KINDS as readonly string[]).includes(v);
}

function parseJson(value: RuntimeConfigValue | undefined): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** 全体の `supervisor.delegate`（行いの配列）。人に回す種類・知らない名前は落として problems に書く */
function parseInstanceDelegate(value: RuntimeConfigValue | undefined, problems: string[]): SupervisorAction[] {
  if (value === undefined) return [...DEFAULT_DELEGATE];
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    problems.push(`${SUPERVISOR_KEYS.delegate}（全体）が読めません。何も任せない扱いにします`);
    return [];
  }
  return pickActions(parsed, `${SUPERVISOR_KEYS.delegate}（全体）`, problems);
}

function pickActions(list: readonly unknown[], where: string, problems: string[]): SupervisorAction[] {
  const out: SupervisorAction[] = [];
  for (const v of list) {
    if (isSupervisorAction(v)) out.push(v);
    else if ((HUMAN_ONLY_KINDS as readonly unknown[]).includes(v)) problems.push(`${where} の「${String(v)}」は任せられません（人に回す種類）`);
    else problems.push(`${where} の「${String(v)}」は知らない行いです`);
  }
  return out;
}

/** Project の `supervisor.delegate`（`{"add":[…],"remove":[…]}` の差分） */
function applyProjectDelegate(base: SupervisorAction[], value: RuntimeConfigValue | undefined, problems: string[]): SupervisorAction[] {
  if (value === undefined) return base;
  const parsed = parseJson(value);
  const where = `${SUPERVISOR_KEYS.delegate}（Project）`;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // 読めない差分は「足す」を捨て、全体の方針から何も外せない——任せすぎない側に倒すため、全部外す
    problems.push(`${where} が読めません。この Project では何も任せない扱いにします`);
    return [];
  }
  const rec = parsed as Record<string, unknown>;
  const add = Array.isArray(rec.add) ? pickActions(rec.add, `${where}.add`, problems) : [];
  const remove = Array.isArray(rec.remove) ? pickActions(rec.remove, `${where}.remove`, problems) : [];
  const set = new Set<SupervisorAction>([...base, ...add]);
  for (const r of remove) set.delete(r);
  return SUPERVISOR_ACTIONS.filter((a) => set.has(a));
}

function positiveNumber(value: RuntimeConfigValue | undefined, fallback: number, key: string, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  problems.push(`${key} が正の数ではありません（既定の ${fallback} を使います）`);
  return fallback;
}

/**
 * **その Project の方針**。数の設定（間隔・上限）とタイムゾーンは全体の層だけを読む（上限は全部の番頭の合計なので、Project で
 * 変えると数えが割れる）。任せる行いは全体に Project の差分を重ね、文は全体に Project の追記を続ける
 */
export function supervisorPolicy(config: Pick<RuntimeConfigStore, "layerValue"> | undefined, projectId: string): SupervisorPolicy {
  const problems: string[] = [];
  const instance = (key: string) => config?.layerValue(key);
  const project = (key: string) => config?.layerValue(key, projectId);
  const delegate = applyProjectDelegate(parseInstanceDelegate(instance(SUPERVISOR_KEYS.delegate), problems), project(SUPERVISOR_KEYS.delegate), problems);
  const notes = [instance(SUPERVISOR_KEYS.note), project(SUPERVISOR_KEYS.note)].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const timeZone = instance(SUPERVISOR_KEYS.timeZone);
  return {
    delegate,
    note: notes.join("\n\n"),
    patrolHours: positiveNumber(instance(SUPERVISOR_KEYS.patrolHours), SUPERVISOR_DEFAULTS.patrolHours, SUPERVISOR_KEYS.patrolHours, problems),
    idleHours: positiveNumber(instance(SUPERVISOR_KEYS.idleHours), SUPERVISOR_DEFAULTS.idleHours, SUPERVISOR_KEYS.idleHours, problems),
    limits: {
      runsPerHour: positiveNumber(instance(SUPERVISOR_KEYS.runsPerHour), SUPERVISOR_DEFAULTS.runsPerHour, SUPERVISOR_KEYS.runsPerHour, problems),
      instructionsPerHour: positiveNumber(
        instance(SUPERVISOR_KEYS.instructionsPerHour),
        SUPERVISOR_DEFAULTS.instructionsPerHour,
        SUPERVISOR_KEYS.instructionsPerHour,
        problems,
      ),
      factoryConcurrent: positiveNumber(
        instance(SUPERVISOR_KEYS.factoryConcurrent),
        SUPERVISOR_DEFAULTS.factoryConcurrent,
        SUPERVISOR_KEYS.factoryConcurrent,
        problems,
      ),
    },
    ...(typeof timeZone === "string" && timeZone !== "" ? { timeZone } : {}),
    problems,
  };
}

/**
 * **番頭がその種類の問いに答えてよいか**。種類が無い・人に回す種類・その Project で任せていない行いは、答えられない（`defer` だけ）。
 * 答えられないときは理由の文を返す
 */
export function supervisorMayAnswer(kind: unknown, policy: Pick<SupervisorPolicy, "delegate">): { ok: true } | { ok: false; reason: string } {
  if (kind === undefined) return { ok: false, reason: "種類（kind）が書かれていない問いです" };
  if (!isDecisionKind(kind)) return { ok: false, reason: `知らない種類「${String(kind)}」の問いです` };
  if ((HUMAN_ONLY_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `${ACTION_TITLES[kind]}に当たる問いは人が決めます` };
  if (!policy.delegate.includes(kind as SupervisorAction)) return { ok: false, reason: `この Project では「${ACTION_TITLES[kind]}」を任されていません` };
  return { ok: true };
}

/** 保存する形（画面が書く）。全体は行いの配列 */
export function serializeInstanceDelegate(actions: readonly SupervisorAction[]): string {
  return JSON.stringify(SUPERVISOR_ACTIONS.filter((a) => actions.includes(a)));
}

/** 保存する形（画面が書く）。Project は差分 */
export function serializeProjectDelegate(diff: { add?: readonly SupervisorAction[]; remove?: readonly SupervisorAction[] }): string {
  const order = (xs: readonly SupervisorAction[] | undefined) => SUPERVISOR_ACTIONS.filter((a) => xs?.includes(a));
  return JSON.stringify({ add: order(diff.add), remove: order(diff.remove) });
}
