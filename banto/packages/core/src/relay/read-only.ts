// **読むだけの回**（決定・2026-10-20、アーキ仕様 §4.4「土台：読むだけの印」「読むだけの回」）。
//
// どの回が読むだけかは host が決める——会話（Thread）に刻んだ `restriction: "read-only"` だけが根拠で、届けものの文や AI の
// 引数では決めない。守りは4か所（SDK の組み込み・core の in-process のサーバ・AI の代理・PreToolUse）で、どれか1つに頼らない。
// ここは「何を通すか」の判定を1か所に置く（規則3——4か所がそれぞれ写しを持たない）。

import {
  PATROL_ALLOWED_TOOLS_KEY,
  PATROL_RESOURCES_ENTRY,
  declaresReadEffect,
  patrolAllowedEntry,
  type ThreadRestriction,
} from "@banto/module-contract";
import type { RuntimeConfigStore, RuntimeConfigValue } from "../config/runtime.js";

/** AI に返す断りの文（tool を断ったとき） */
export const READ_ONLY_REFUSAL = "見回りの回では使えません（読むだけの tool だけ使えます）";

/**
 * 人に聞くもの（承認・中継の初回・Elicitation）を、聞かずに断ったときの文。人が見ていない回で判断待ちを積まない
 * ——「承認をすべて自動で許可する」がオンでも同じ（制限は承認より前に効く）
 */
export const READ_ONLY_NO_ASK_REFUSAL = "見回りの回では人に聞けないため、断りました（読むだけの tool だけ使えます）";

/**
 * **SDK に元から付いている tool のうち、読むだけの回に残すもの**。資源の読み出しは AI の代理の `resources/read` を通るので、
 * 代理で同梱の Module と人が許した Module の資源に絞る。WebFetch・WebSearch を含むほかのものは使えない
 */
export const READ_ONLY_BUILTIN_TOOLS: readonly string[] = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"];

/**
 * **core の tool で読むだけの回に残すもの**（サーバの名前 → tool の名前）。見回りの `notify` は見回りの段で足す。
 * `banto-memory` は書く tool しか無いので、読むだけの回にはサーバごと渡さない
 */
export const READ_ONLY_CORE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "banto-thread": ["list_threads", "list_automations", "claude_usage"],
};

/** その会話の制限を引く口（`autoApproveFor` と同じ形）。制限が無ければ undefined */
export type RestrictionFor = (projectId: string | undefined, threadId: string | undefined) => ThreadRestriction | undefined;

/**
 * **人が「見回りで使ってよい」と許したもの**（Configuration の Project の鍵 `patrol.allowedTools`）。**Project の層だけ**を
 * 読む——instance に誰かが書いても、全 Project で一度に許す口にはしない。値は JSON の文字列の配列（Configuration の値は
 * 文字列・数・真偽値だけなので）。壊れていれば何も許さない（fail closed）が、黙らずに書き残す（規則2）
 */
export function patrolAllowedTools(config: Pick<RuntimeConfigStore, "layerValue"> | undefined, projectId: string): string[] {
  return parsePatrolAllowedTools(config?.layerValue(PATROL_ALLOWED_TOOLS_KEY, projectId), projectId);
}

export function parsePatrolAllowedTools(value: RuntimeConfigValue | undefined, projectId = "?"): string[] {
  if (value === undefined) return [];
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : undefined;
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string")) return parsed;
  } catch {
    // 下で書き残す
  }
  console.warn(`[host] Project ${projectId} の ${PATROL_ALLOWED_TOOLS_KEY} が読めません（何も許さない扱いにします）: ${String(value).slice(0, 200)}`);
  return [];
}

/** 保存する形（重複を落として並べる——同じ中身なら同じ文字列にする） */
export function serializePatrolAllowedTools(entries: readonly string[]): string {
  return JSON.stringify([...new Set(entries)].sort());
}

/**
 * **読むだけの回でその Module の tool を使ってよいか**。同梱の Module（目録と同じコード）が `dev.banto/effect: "read"` と
 * 名乗ったものと、人が1つずつ許したものだけ。第三者の名乗りと `readOnlyHint` は見ない
 */
export function mayCallInReadOnly(input: {
  /** Runner から見える Module の名前（宣言の名前） */
  moduleName: string;
  bundled: boolean;
  tool: { name: string; _meta?: Record<string, unknown> };
  allowed: readonly string[];
}): boolean {
  if (input.bundled && declaresReadEffect(input.tool)) return true;
  return input.allowed.includes(patrolAllowedEntry(input.moduleName, input.tool.name));
}

/** **読むだけの回でその Module の資源を読んでよいか**。同梱の Module と、人が「資源を読む」を許した Module だけ */
export function mayReadResourcesInReadOnly(input: { moduleName: string; bundled: boolean; allowed: readonly string[] }): boolean {
  return input.bundled || input.allowed.includes(patrolAllowedEntry(input.moduleName, PATROL_RESOURCES_ENTRY));
}

/** core の tool（`mcp__<server>__<tool>` の形）のうち、読むだけの回に残すもの */
export function readOnlyCoreToolNames(): string[] {
  return Object.entries(READ_ONLY_CORE_TOOLS).flatMap(([server, tools]) => tools.map((t) => `mcp__${server}__${t}`));
}

/**
 * **PreToolUse の最後の網**：その名前の tool を読むだけの回で通してよいか。`allowedModuleTools` は、ターンを始めるときに
 * Module の一覧から引いた「読むだけの回で使ってよい Module の tool」（`mcp__<Module>__<tool>`）。引けなかったものは通さない
 */
export function readOnlyHookAllows(toolName: string, allowedModuleTools: ReadonlySet<string>): boolean {
  if (READ_ONLY_BUILTIN_TOOLS.includes(toolName)) return true;
  if (readOnlyCoreToolNames().includes(toolName)) return true;
  return allowedModuleTools.has(toolName);
}
