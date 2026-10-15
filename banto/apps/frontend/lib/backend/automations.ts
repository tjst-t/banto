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

import { useEffect, useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import {
  createRealAutomation,
  listRealAutomations,
  removeRealAutomation,
  runRealAutomation,
  updateRealAutomation,
  type RealAutomation,
  type RealAutomationFields,
  type RealAutomationRepeat,
  type RealAutomationRun,
  type RealAutomationTarget,
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

// ---- 操作。どれも host に頼み、写しは返ってきたもので置き換える（流れてくる知らせでも取り直される） ----

function replace(projectId: string, next: RealAutomation): void {
  const list = byProject.get(projectId) ?? [];
  const at = list.findIndex((a) => a.id === next.id);
  byProject = new Map(byProject).set(projectId, at >= 0 ? list.map((a, i) => (i === at ? next : a)) : [...list, next]);
  notify();
}

export async function createAutomation(projectId: string, fields: RealAutomationFields): Promise<RealAutomation> {
  const created = await createRealAutomation(projectId, fields);
  replace(projectId, created);
  await refreshAutomations(projectId);
  return created;
}

export async function updateAutomation(
  projectId: string,
  id: string,
  changes: Partial<RealAutomationFields> & { paused?: boolean },
): Promise<void> {
  replace(projectId, await updateRealAutomation(projectId, id, changes));
  // 届け先を変えた・再開したら host が専用の Fork を立てることがある——一覧へ足すのは取り直しに任せる
  await refreshAutomations(projectId);
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

/** 「平日 9:00（日本標準時）」 */
export function describeSource(a: Pick<RealAutomation, "source">): string {
  return `${describeRepeat(a.source.repeat)}（${timeZoneName(a.source.timeZone)}）`;
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

