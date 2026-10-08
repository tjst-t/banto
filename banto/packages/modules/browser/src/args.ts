// **道具の引数を確かめる**。頼み方の誤りは理由ごと AI に返す（黙って既定に倒さない、規則2）。

import { STATUS_FILTER_PATTERN, parseSince, type ConsoleLevel, type ConsoleQuery, type DetailPart, type NetworkQuery } from "./network-log.js";

/** 頼み方の誤り・断り。理由を AI（または人の画面）に返す */
export class BrowserError extends Error {}

type Args = Record<string, unknown>;

function str(args: Args, key: string, required: true): string;
function str(args: Args, key: string, required?: false): string | undefined;
function str(args: Args, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new BrowserError(`${key} が要ります`);
    return undefined;
  }
  if (typeof v !== "string") throw new BrowserError(`${key} は文字列です（${JSON.stringify(v)} が来ました）`);
  if (required && v.length === 0) throw new BrowserError(`${key} が空です`);
  return v;
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new BrowserError(`${key} は true か false です（${JSON.stringify(v)} が来ました）`);
  return v;
}

function int(args: Args, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BrowserError(`${key} は ${min}〜${max} の整数です（${JSON.stringify(v)} が来ました）`);
  }
  return v;
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BrowserError(`${key} は数です（${JSON.stringify(v)} が来ました）`);
  return v;
}

function oneOf<T extends string>(args: Args, key: string, values: readonly T[], required: true): T;
function oneOf<T extends string>(args: Args, key: string, values: readonly T[], required?: false): T | undefined;
function oneOf<T extends string>(args: Args, key: string, values: readonly T[], required = false): T | undefined {
  const v = str(args, key, required as true);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v)) throw new BrowserError(`${key} は ${values.join("・")} のどれかです（${JSON.stringify(v)} が来ました）`);
  return v as T;
}

const TAB_PATTERN = /^t\d+$/;

function tab(args: Args, required = false): string | undefined {
  const v = required ? str(args, "tab", true) : str(args, "tab");
  if (v !== undefined && !TAB_PATTERN.test(v)) throw new BrowserError(`tab はタブの id（t1 の形。browserTabs の list で見られます）です（${JSON.stringify(v)} が来ました）`);
  return v;
}

function since(args: Args, prefix: "r" | "c"): string | undefined {
  const v = str(args, "since");
  if (v === undefined) return undefined;
  try {
    parseSince(v, prefix);
  } catch (err) {
    throw new BrowserError((err as Error).message);
  }
  return v;
}

// ---- 道具ごと ----------------------------------------------------------------------------------

export interface OpenArgs {
  url: string;
  newTab: boolean;
}

export function parseOpen(args: Args): OpenArgs {
  const url = str(args, "url", true);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError(`url が URL として読めません（http://localhost:3000/ のように書きます）: ${JSON.stringify(url)}`);
  }
  if (!["http:", "https:", "about:", "data:", "file:"].includes(parsed.protocol)) {
    throw new BrowserError(`url は http・https・about・data・file のどれかで始めます: ${JSON.stringify(url)}`);
  }
  return { url, newTab: bool(args, "newTab") ?? false };
}

export function parseTabOnly(args: Args): { tab?: string } {
  const t = tab(args);
  return t !== undefined ? { tab: t } : {};
}

export const ACT_ACTIONS = ["click", "type", "press", "select", "hover", "scroll", "back", "forward", "reload", "waitFor", "resize"] as const;
export type ActAction = (typeof ACT_ACTIONS)[number];

export type ActArgs =
  | { action: "click"; ref: string; tab?: string; double: boolean; button: "left" | "right" | "middle" }
  | { action: "type"; ref: string; text: string; submit: boolean; tab?: string }
  | { action: "press"; key: string; ref?: string; tab?: string }
  | { action: "select"; ref: string; values: string[]; tab?: string }
  | { action: "hover"; ref: string; tab?: string }
  | { action: "scroll"; ref?: string; dx: number; dy: number; tab?: string }
  | { action: "back" | "forward" | "reload"; tab?: string }
  | { action: "waitFor"; text?: string; textGone?: string; timeMs?: number; tab?: string }
  | { action: "resize"; width: number; height: number; tab?: string };

const REF_PATTERN = /^[a-z]*\d+$/i;

function ref(args: Args, required: true): string;
function ref(args: Args, required?: false): string | undefined;
function ref(args: Args, required = false): string | undefined {
  const v = required ? str(args, "ref", true) : str(args, "ref");
  if (v !== undefined && !REF_PATTERN.test(v)) throw new BrowserError(`ref は browserSnapshot の [ref=…] の値（e12 の形）です（${JSON.stringify(v)} が来ました）`);
  return v;
}

export function parseAct(args: Args): ActArgs {
  const action = oneOf(args, "action", ACT_ACTIONS, true);
  const t = tab(args);
  const withTab = t !== undefined ? { tab: t } : {};
  switch (action) {
    case "click":
      return { action, ref: ref(args, true), double: bool(args, "double") ?? false, button: oneOf(args, "button", ["left", "right", "middle"] as const) ?? "left", ...withTab };
    case "type": {
      const text = str(args, "text");
      if (text === undefined) throw new BrowserError("type には text が要ります");
      return { action, ref: ref(args, true), text, submit: bool(args, "submit") ?? false, ...withTab };
    }
    case "press": {
      const r = ref(args);
      return { action, key: str(args, "key", true), ...(r !== undefined ? { ref: r } : {}), ...withTab };
    }
    case "select": {
      const values = args.values;
      if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === "string")) {
        throw new BrowserError("select には values（選ぶ値か表示の文字の配列）が要ります");
      }
      return { action, ref: ref(args, true), values: values as string[], ...withTab };
    }
    case "hover":
      return { action, ref: ref(args, true), ...withTab };
    case "scroll": {
      const r = ref(args);
      const dx = num(args, "dx") ?? 0;
      const dy = num(args, "dy") ?? (r === undefined ? 600 : 0);
      return { action, ...(r !== undefined ? { ref: r } : {}), dx, dy, ...withTab };
    }
    case "back":
    case "forward":
    case "reload":
      return { action, ...withTab };
    case "waitFor": {
      const text = str(args, "text");
      const textGone = str(args, "textGone");
      const timeMs = int(args, "timeMs", 0, 60_000);
      if (text === undefined && textGone === undefined && timeMs === undefined) {
        throw new BrowserError("waitFor には text（出るまで）・textGone（消えるまで）・timeMs（待つ時間）のどれかが要ります");
      }
      return {
        action,
        ...(text !== undefined ? { text } : {}),
        ...(textGone !== undefined ? { textGone } : {}),
        ...(timeMs !== undefined ? { timeMs } : {}),
        ...withTab,
      };
    }
    case "resize": {
      const width = int(args, "width", 100, 7680);
      const height = int(args, "height", 100, 4320);
      if (width === undefined || height === undefined) throw new BrowserError("resize には width と height（CSS ピクセル）が要ります");
      return { action, width, height, ...withTab };
    }
  }
}

export interface ScreenshotArgs {
  tab?: string;
  fullPage: boolean;
  ref?: string;
}

export function parseScreenshot(args: Args): ScreenshotArgs {
  const r = ref(args);
  const fullPage = bool(args, "fullPage") ?? false;
  if (r !== undefined && fullPage) throw new BrowserError("ref と fullPage は一緒に使えません（要素だけか、ページ全体か）");
  return { ...parseTabOnly(args), fullPage, ...(r !== undefined ? { ref: r } : {}) };
}

export function parseEval(args: Args): { expression: string; tab?: string } {
  return { expression: str(args, "expression", true), ...parseTabOnly(args) };
}

export type TabsArgs = { action: "list" } | { action: "select" | "close"; tab: string };

export function parseTabs(args: Args): TabsArgs {
  const action = oneOf(args, "action", ["list", "select", "close"] as const, true);
  if (action === "list") return { action };
  return { action, tab: tab(args, true)! };
}

export function parseNetworkQuery(args: Args, defaultLimit = 50): NetworkQuery {
  const status = str(args, "status");
  if (status !== undefined && !STATUS_FILTER_PATTERN.test(status)) {
    throw new BrowserError(`status は failed・error（失敗と 4xx・5xx）・pending・2xx〜5xx・数字（404 等）のどれかです（${JSON.stringify(status)} が来ました）`);
  }
  const q: NetworkQuery = { limit: int(args, "limit", 1, 500) ?? defaultLimit };
  const t = tab(args);
  if (t !== undefined) q.tab = t;
  const urlContains = str(args, "urlContains");
  if (urlContains !== undefined) q.urlContains = urlContains;
  const method = str(args, "method");
  if (method !== undefined) q.method = method;
  if (status !== undefined) q.status = status;
  const type = str(args, "type");
  if (type !== undefined) q.type = type;
  const s = since(args, "r");
  if (s !== undefined) q.since = s;
  return q;
}

export const DETAIL_PARTS = ["all", "headers", "request", "response", "frames"] as const;

export function parseNetworkRequest(args: Args): { id: string; part: DetailPart; maxBytes: number } {
  const id = str(args, "id", true);
  if (!/^r\d+$/.test(id)) throw new BrowserError(`id は listNetwork の行の頭の値（r12 の形）です（${JSON.stringify(id)} が来ました）`);
  return {
    id,
    part: oneOf(args, "part", DETAIL_PARTS) ?? "all",
    maxBytes: int(args, "maxBytes", 1, 1_000_000) ?? 10_000,
  };
}

export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["error", "warning", "info", "log", "debug"];

export function parseConsoleQuery(args: Args, defaultLimit = 50): ConsoleQuery {
  const q: ConsoleQuery = { limit: int(args, "limit", 1, 500) ?? defaultLimit };
  const level = oneOf(args, "level", CONSOLE_LEVELS);
  if (level !== undefined) q.level = level;
  const t = tab(args);
  if (t !== undefined) q.tab = t;
  const s = since(args, "c");
  if (s !== undefined) q.since = s;
  return q;
}

export function parseBlocked(args: Args): boolean {
  const v = bool(args, "blocked");
  if (v === undefined) throw new BrowserError("blocked（true で AI に触らせない）が要ります");
  return v;
}

export function parseSettings(args: Args): { idleMinutes?: number } {
  const idleMinutes = int(args, "idleMinutes", 1, 24 * 60);
  return idleMinutes !== undefined ? { idleMinutes } : {};
}
