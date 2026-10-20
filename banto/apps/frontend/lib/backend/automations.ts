"use client";

// **自動化の写し**（決定・2026-10-15、v4-frontend.md §6.42）。台帳は host（アーキ仕様 §4.3）にあり、画面は Project ごとに
// 写しを持つだけ（規則3）。取るのは、その Project の自動化を見る面（Canvas・サイドバーの目次・専用の Fork の帯・
// Command Palette）が初めて描かれたとき。そのあとは出来事の流れで取り直す：
//   automations.changed（作った・直した・止めた・消した・回を書いた）→ その Project を取り直す
//   hello（繋ぎ直した）→ 写しを持っている Project を全部取り直す（切れていた間の変化を取りこぼさない）
// ポーリングはしない（app-events.ts と同じ理由）。
//
// 専用の Fork は host が立てる——立てた直後はまだこの画面の一覧に無い（最初のターンが始まった知らせで入る）。
// 写しに知らない専用の Fork があれば、その Project の一覧を取り直して足す（「会話を開く」をすぐ押せるように）。

import { useEffect, useState, useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import {
  createRealAutomation,
  listRealAutomationEvents,
  listRealAutomations,
  removeRealAutomation,
  runRealAutomation,
  updateRealAutomation,
  unmuteRealPatrolNote,
  type RealAutomation,
  type RealAutomationEventSource,
  type RealAutomationInput,
  type RealAutomationRepeat,
  type RealAutomationRun,
  type RealAutomationTarget,
  type RealEventDeclaration,
} from "./client";
import { registerNewRealForks } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";
import { reportFailure } from "@/lib/report-failure";

/** 自動化の画面の印（core の画面。Module に `banto` の名は使わせない——アーキ仕様 §5.2） */
export const AUTOMATIONS_CANVAS = "banto:triggers";

/** 自動化の画面を開く URL。いま開いている Fork は閉じずに、その隣へ開く */
export function automationsCanvasHref(projectId: string, forkId?: string | null): string {
  const q = new URLSearchParams();
  if (forkId) q.set("fork", forkId);
  q.set("canvas", AUTOMATIONS_CANVAS);
  return `/p/${projectId}?${q.toString()}`;
}

let byProject: ReadonlyMap<string, readonly RealAutomation[]> = new Map();
const loading = new Map<string, Promise<void>>();
/** 一覧を取り直しに行った専用の Fork（同じものを何度も取りに行かない） */
const forkLookups = new Set<string>();
const listeners = new Set<() => void>();
let wired = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "automations.changed") {
      if (byProject.has(event.projectId)) void refreshAutomations(event.projectId).catch(() => undefined);
    } else if (event.type === "hello") {
      for (const projectId of byProject.keys()) void refreshAutomations(projectId).catch(() => undefined);
      for (const projectId of eventSourcesByProject.keys()) void refreshAutomationEventSources(projectId).catch(() => undefined);
    }
  });
  startRealAppEvents();
}

/** その Project の自動化を取り直す。失敗は呼んだ側に返し、ここでも知らせる（黙らない、規則2） */
export function refreshAutomations(projectId: string): Promise<void> {
  wire();
  const inFlight = loading.get(projectId);
  if (inFlight) return inFlight;
  const p = listRealAutomations(projectId)
    .then((list) => {
      byProject = new Map(byProject).set(projectId, list);
      notify();
      const unknown = list.some((a) => {
        const id = a.target.kind === "dedicated" ? a.target.threadId : undefined;
        return id !== undefined && !getThread(id) && !forkLookups.has(id);
      });
      if (unknown) {
        for (const a of list) if (a.target.threadId) forkLookups.add(a.target.threadId);
        registerNewRealForks(projectId).catch((err: unknown) => reportFailure("自動化の専用の Fork を一覧に出せませんでした", err));
      }
    })
    .catch((err: unknown) => {
      reportFailure("自動化の一覧を読み込めませんでした", err);
      throw err;
    })
    .finally(() => loading.delete(projectId));
  loading.set(projectId, p);
  return p;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * **その Project の自動化**（作った順）。まだ取っていなければ取りに行き、取れるまでは undefined。`projectId` が無ければ
 * 取らない
 */
export function useAutomations(projectId: string | null | undefined): readonly RealAutomation[] | undefined {
  const list = useSyncExternalStore(
    subscribe,
    () => (projectId ? byProject.get(projectId) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (projectId && !byProject.has(projectId)) void refreshAutomations(projectId).catch(() => undefined);
  }, [projectId]);
  return list;
}

/** その Thread を専用の Fork にしている自動化（写しにあれば） */
export function automationOfThread(threadId: string): RealAutomation | undefined {
  for (const list of byProject.values()) {
    const found = list.find((a) => a.target.kind === "dedicated" && a.target.threadId === threadId);
    if (found) return found;
  }
  return undefined;
}

/** `automationOfThread` を描画に使う形（写しが変われば描き直す） */
export function useAutomationOfThread(projectId: string, threadId: string | null): RealAutomation | undefined {
  const list = useAutomations(projectId);
  if (!threadId || !list) return undefined;
  return list.find((a) => a.target.kind === "dedicated" && a.target.threadId === threadId);
}

// ---- 待てる出来事（出どころごとの名乗り、アーキ仕様 §4.3「段2」）。作るフォームの選び先と、一覧の行の題に使う ----

let eventSourcesByProject: ReadonlyMap<string, readonly RealAutomationEventSource[]> = new Map();
const eventSourcesLoading = new Map<string, Promise<void>>();

/**
 * その Project で待てる出来事を取り直す。名乗りは Module の宣言から来るので、Module を入れ替えると変わる——画面が自動化の面を
 * 開くたびに取り直す。失敗は呼んだ側に返す
 */
export function refreshAutomationEventSources(projectId: string): Promise<void> {
  wire();
  const inFlight = eventSourcesLoading.get(projectId);
  if (inFlight) return inFlight;
  const p = listRealAutomationEvents(projectId)
    .then((sources) => {
      eventSourcesByProject = new Map(eventSourcesByProject).set(projectId, sources);
      notify();
    })
    .finally(() => eventSourcesLoading.delete(projectId));
  eventSourcesLoading.set(projectId, p);
  return p;
}

/**
 * **その Project で待てる出来事**（banto 自身が先頭）。取れるまでは undefined。`reload` なら描かれたときに一度取り直す
 * （作るフォーム——Module を入れ替えた後でも今の名乗りから選ぶ）。読めなければ `error`
 */
export function useAutomationEventSources(
  projectId: string | null | undefined,
  opts: { reload?: boolean } = {},
): { sources: readonly RealAutomationEventSource[] | undefined; error: string | null } {
  const sources = useSyncExternalStore(
    subscribe,
    () => (projectId ? eventSourcesByProject.get(projectId) : undefined),
    () => undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const reload = opts.reload === true;
  useEffect(() => {
    if (!projectId || (!reload && eventSourcesByProject.has(projectId))) return;
    refreshAutomationEventSources(projectId)
      .then(() => setError(null))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId, reload]);
  return { sources, error };
}

/** 出来事の名乗りを引く（無ければ undefined——Module を外した等） */
export function findEventDeclaration(
  sources: readonly RealAutomationEventSource[] | undefined,
  name: string,
): RealEventDeclaration | undefined {
  for (const s of sources ?? []) {
    const found = s.events.find((e) => e.name === name);
    if (found) return found;
  }
  return undefined;
}

// ---- 操作。どれも host に頼み、写しは返ってきたもので置き換える（流れてくる知らせでも取り直される） ----

function replace(projectId: string, next: RealAutomation): void {
  const list = byProject.get(projectId) ?? [];
  const at = list.findIndex((a) => a.id === next.id);
  byProject = new Map(byProject).set(projectId, at >= 0 ? list.map((a, i) => (i === at ? next : a)) : [...list, next]);
  notify();
}

/**
 * 作る。Webhook なら受け口の URL（`webhookUrl`）、判断役なら案内（`notices`）を返す——写しには入れない（この応答でだけ見せる）
 */
export async function createAutomation(
  projectId: string,
  fields: RealAutomationInput,
): Promise<RealAutomation & { webhookUrl?: string; notices?: string[] }> {
  const { webhookUrl, notices, ...created } = await createRealAutomation(projectId, fields);
  replace(projectId, created);
  await refreshAutomations(projectId);
  return { ...created, ...(webhookUrl ? { webhookUrl } : {}), ...(notices && notices.length > 0 ? { notices } : {}) };
}

export async function updateAutomation(
  projectId: string,
  id: string,
  changes: Partial<RealAutomationInput> & { paused?: boolean },
): Promise<void> {
  replace(projectId, await updateRealAutomation(projectId, id, changes));
  // 届け先を変えた・再開したら host が専用の Fork を立てることがある——一覧へ足すのは取り直しに任せる
  await refreshAutomations(projectId);
}

/** 見回りの手帳の「知らせない」を外す（§6.47） */
export async function unmutePatrolNote(projectId: string, id: string, key: string): Promise<void> {
  replace(projectId, await unmuteRealPatrolNote(projectId, id, key));
}

export async function removeAutomation(projectId: string, id: string): Promise<void> {
  await removeRealAutomation(projectId, id);
  byProject = new Map(byProject).set(projectId, (byProject.get(projectId) ?? []).filter((a) => a.id !== id));
  notify();
}

/** 今すぐ動かす。届けなかったときの理由（飛ばした）を返す——届けたなら undefined */
export async function runAutomationNow(projectId: string, id: string): Promise<string | undefined> {
  const started = await runRealAutomation(projectId, id);
  await refreshAutomations(projectId);
  return started.result === "skipped" ? (started.reason ?? "届けませんでした") : undefined;
}

// ---- 文にする（一覧・帯・カードで同じ言い方にする） ----

const DAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function describeRepeat(r: RealAutomationRepeat): string {
  switch (r.kind) {
    case "daily":
      return `毎日 ${r.time}`;
    case "weekdays":
      return `平日 ${r.time}`;
    case "weekly":
      return `毎週${DAYS[r.day] ?? "?"}曜 ${r.time}`;
    case "interval":
      return `${r.hours} 時間ごと`;
    case "cron":
      return `cron ${r.expr}`;
  }
}

/** タイムゾーンの呼び名。ブラウザが知っている名前（「日本標準時」等）を使い、引けなければ id のまま */
export function timeZoneName(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("ja-JP", { timeZone, timeZoneName: "long" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * 「平日 9:00（日本標準時）」「Webhook を受けたとき」「Service が落ちたとき（サービスの名前が「web」）」。出来事は名乗りの題と
 * 属性の題で言う——名乗りが引けない（まだ取っていない・Module を外した）ときは名前のまま
 */
export function describeSource(a: Pick<RealAutomation, "source">, sources?: readonly RealAutomationEventSource[]): string {
  if (a.source.kind === "webhook") return "Webhook を受けたとき";
  if (a.source.kind === "event") {
    const declared = findEventDeclaration(sources, a.source.event);
    const head = declared ? `${declared.title}とき` : `出来事 ${a.source.event} が起きたとき`;
    const where = describeWhere(a.source.where, declared);
    return where ? `${head}（${where}）` : head;
  }
  return `${describeRepeat(a.source.repeat)}（${timeZoneName(a.source.timeZone)}）`;
}

/** 条件を文に（「サービスの名前が「web」、終了コードが「1」・「2」のどれか」） */
export function describeWhere(
  where: Extract<RealAutomation["source"], { kind: "event" }>["where"],
  declared?: RealEventDeclaration,
): string {
  return Object.entries(where ?? {})
    .map(([field, v]) => {
      const values = (Array.isArray(v) ? v : [v]).map(describeFieldValue);
      const title = declared?.fields[field]?.title ?? field;
      return values.length > 1 ? `${title}が${values.join("・")}のどれか` : `${title}が${values[0] ?? ""}`;
    })
    .join("、");
}

export function describeFieldValue(v: string | number | boolean): string {
  return `「${typeof v === "boolean" ? (v ? "はい" : "いいえ") : String(v)}」`;
}

/** 時刻を出すときのタイムゾーン。時刻の自動化はその自動化のもの、Webhook はブラウザのもの */
export function automationTimeZone(a: Pick<RealAutomation, "source">): string {
  return a.source.kind === "time" ? a.source.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** 届け先の短い呼び名（一覧の1行・帯） */
export function describeTarget(t: RealAutomationTarget): string {
  if (t.kind === "thread") return `「${threadTitle(t.threadId)}」に届ける`;
  return t.mode === "fresh" ? "毎回まっさら" : "前の回を引き継ぐ";
}

export function threadTitle(threadId: string): string {
  const thread = getThread(threadId);
  if (!thread) return "見つからない会話";
  return thread.kind === "base" ? "Base Thread" : thread.title;
}

/** 時刻を、その自動化のタイムゾーンで短く（「10/16（金）9:00」）。今日・明日はそう書く */
export function formatWhen(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  if (day(at) === day(now)) return `今日 ${time}`;
  if (day(at) === day(new Date(now.getTime() + 86_400_000))) return `明日 ${time}`;
  if (day(at) === day(new Date(now.getTime() - 86_400_000))) return `昨日 ${time}`;
  const date = new Intl.DateTimeFormat("ja-JP", { timeZone, month: "numeric", day: "numeric", weekday: "short" }).format(at);
  return `${date} ${time}`;
}

export function runLabel(r: Pick<RealAutomationRun, "result">): string {
  switch (r.result) {
    case "done":
      return "終わりました";
    case "skipped":
      return "飛ばしました";
    case "rejected":
      return "受け取りませんでした";
    case "waiting":
      return "あなたの答えを待っています";
    case "failed":
      return "途中で止まりました";
    case "running":
      return "動いています";
  }
}

