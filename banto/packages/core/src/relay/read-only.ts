// **読むだけの回**（決定・2026-10-20、アーキ仕様 §4.4「土台：読むだけの印」「読むだけの回」）。
//
// どの回が読むだけかは host が決める——会話（Thread）に刻んだ `restriction: "read-only"` だけが根拠で、届けものの文や AI の
// 引数では決めない。守りは4か所（SDK の組み込み・core の in-process のサーバ・AI の代理・PreToolUse）で、どれか1つに頼らない。
// ここは「何を通すか」の判定を1か所に置く（規則3——4か所がそれぞれ写しを持たない）。
//
// **番頭の回**（`restriction: "supervisor"`、追加・2026-10-21、アーキ仕様 §4.5「番頭の会話の tool は host が強いる」）も同じ4か所で
// 絞る。違うのは残す tool（番頭の tool）と、承認——番頭の回は人に聞かずに断るのではなく、判断役と同じく「必ず聞く」に固定する

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
 * **core の tool で読むだけの回に残すもの**（サーバの名前 → tool の名前）。見回りの `notify` は見回りの Fork のターンにだけ在る。
 * `banto-memory` は書く tool しか無いので、読むだけの回にはサーバごと渡さない
 */
export const READ_ONLY_CORE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "banto-thread": ["list_threads", "list_automations", "claude_usage", "notify"],
};

/**
 * **見回りが消えたあとの見回りの Fork にだけ足す core の tool**（決定・2026-10-21、ユーザー。アーキ仕様 §4.4「見回りが消えたあとの
 * Fork」）。自分の会話を閉じるだけ——環境は変わらず、外へも運べず、会話と Memory は残る。ほかの書く tool は読むだけのまま
 */
export const ORPHANED_PATROL_CORE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "banto-thread": ["close_fork"],
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

/** Vault の役割の、値を引く口（窓口を通さず金庫に直接——Repositories の `RelayVault.resolve` と同じ） */
const VAULT_RESOLVE_TOOL = "resolveAlias";

/**
 * **読むだけの回の中で、同梱の banto 全体の Module が自分の資格情報を使う中継**（追加・2026-10-20、Backlog #424）。
 *
 * Repositories の読むだけの GitHub の tool は、台帳のアカウントのトークンで GitHub を読む。トークンは Vault にあり、引く
 * `resolveAlias` は値を返すので読むだけの印を持たない——このままでは読むだけの回で非公開のリポジトリを読めない。
 * 読むだけの3つの条件のうち (3)「秘密の値を返さない」が守るのは **AI に返らないこと**で、呼び元の Module のコードの中で
 * 見出しに使うだけなら、AI には返らない（呼び元の tool の返事が読むだけの印の下にある）。ログインの取り直しで回った組を
 * 書き戻すのは、Module が自分の資格情報を使える形に保つ仕事で、環境を変えるものに数えない（`callerOwned` の口だけ）。
 *
 * 緩めるのは次を全部満たすときだけ：
 * - **呼び元は同梱で、banto 本体で動く banto 全体の Module**——コンテナの中の Module は AI が合言葉を読めて、その Module の名で
 *   値を引ける（`callerOwned` と同じ線）
 * - **宛先は同梱の Vault**（役割 `vault`）で、口は値を引く `resolveAlias` か、呼び元が持ち主のものだけを書き換える口
 *
 * 承認は今までどおり効く——まだ許していない値は、読むだけの回では人に聞かずに断る（初回はふつうの会話で許す）
 */
export function mayRelayOwnCredentialInReadOnly(input: {
  caller: { bundled: boolean; inContainer: boolean; projectScoped: boolean };
  target: { bundled: boolean; roles: readonly string[] };
  tool: { name: string; callerOwned: boolean };
}): boolean {
  if (!input.caller.bundled || input.caller.inContainer || input.caller.projectScoped) return false;
  if (!input.target.bundled || !input.target.roles.includes("vault")) return false;
  return input.tool.name === VAULT_RESOLVE_TOOL || input.tool.callerOwned;
}

/** **読むだけの回でその Module の資源を読んでよいか**。同梱の Module と、人が「資源を読む」を許した Module だけ */
export function mayReadResourcesInReadOnly(input: { moduleName: string; bundled: boolean; allowed: readonly string[] }): boolean {
  return input.bundled || input.allowed.includes(patrolAllowedEntry(input.moduleName, PATROL_RESOURCES_ENTRY));
}

/** AI に返す断りの文（番頭の回で tool を断ったとき） */
export const SUPERVISOR_REFUSAL = "番頭の回では使えません（番頭の tool だけ使えます）";

/**
 * **core の tool で番頭の回に残すもの**（アーキ仕様 §4.5「番頭の tool」）。`instruct_thread`・`list_stalled_threads` は番頭の回にだけ在る
 * （ふつうの会話には出さない——`fork-tool.ts`）。`banto-memory` は渡さない
 */
export const SUPERVISOR_CORE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "banto-thread": ["answer_decision", "instruct_thread", "list_stalled_threads", "list_threads", "claude_usage"],
};

/**
 * **番頭の回で使ってよい Module の tool**（`<Module の識別子>/<tool 名>`）。同梱の Module のものだけが効く。いまは無い——Factory・
 * Backlog の tool は Backlog #509 で足す
 */
export const SUPERVISOR_MODULE_TOOLS: readonly string[] = [];

/** **番頭の回でその Module の tool を使ってよいか**。同梱で、上の一覧に載っているものだけ（人が許す口は無い） */
export function mayCallInSupervisor(input: { moduleName: string; bundled: boolean; tool: { name: string } }): boolean {
  return input.bundled && SUPERVISOR_MODULE_TOOLS.includes(patrolAllowedEntry(input.moduleName, input.tool.name));
}

/** **番頭の回でその Module の資源を読んでよいか**。同梱の Module だけ（資源の組み込みの3つは残す） */
export function mayReadResourcesInSupervisor(input: { bundled: boolean }): boolean {
  return input.bundled;
}

/**
 * 制限のある回の形。`orphanedPatrol` は「見回りの自動化が消えたあとの見回りの Fork」（一時停止は含まない）。`supervisor` は番頭の回
 * （残す core の tool が読むだけの回と違う）
 */
export interface ReadOnlyTurnShape {
  orphanedPatrol?: boolean;
  supervisor?: boolean;
}

/** その回で core のサーバに残す tool の名前（サーバごと） */
export function readOnlyCoreToolsOf(server: string, shape: ReadOnlyTurnShape = {}): string[] {
  if (shape.supervisor) return [...(SUPERVISOR_CORE_TOOLS[server] ?? [])];
  return [...(READ_ONLY_CORE_TOOLS[server] ?? []), ...(shape.orphanedPatrol ? (ORPHANED_PATROL_CORE_TOOLS[server] ?? []) : [])];
}

/** core の tool（`mcp__<server>__<tool>` の形）のうち、読むだけの回（番頭の回）に残すもの */
export function readOnlyCoreToolNames(shape: ReadOnlyTurnShape = {}): string[] {
  const servers = shape.supervisor
    ? new Set(Object.keys(SUPERVISOR_CORE_TOOLS))
    : new Set([...Object.keys(READ_ONLY_CORE_TOOLS), ...(shape.orphanedPatrol ? Object.keys(ORPHANED_PATROL_CORE_TOOLS) : [])]);
  return [...servers].flatMap((server) => readOnlyCoreToolsOf(server, shape).map((t) => `mcp__${server}__${t}`));
}

/**
 * **PreToolUse の最後の網**：その名前の tool を読むだけの回（番頭の回）で通してよいか。`allowedModuleTools` は、ターンを始めるときに
 * Module の一覧から引いた「読むだけの回で使ってよい Module の tool」（`mcp__<Module>__<tool>`）。引けなかったものは通さない
 */
export function readOnlyHookAllows(toolName: string, allowedModuleTools: ReadonlySet<string>, shape: ReadOnlyTurnShape = {}): boolean {
  if (READ_ONLY_BUILTIN_TOOLS.includes(toolName)) return true;
  if (readOnlyCoreToolNames(shape).includes(toolName)) return true;
  return allowedModuleTools.has(toolName);
}
