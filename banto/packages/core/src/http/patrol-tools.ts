// **見回りで使ってよい tool**（決定・2026-10-20、アーキ仕様 §4.4「土台：読むだけの印」、v4-frontend.md §6.47「Project の設定」）。
//
// 読むだけの回で使える Module の tool は2通り：同梱の Module が `dev.banto/effect: "read"` と名乗ったもの（banto が確かめた。人は
// 外せない）と、人が Project の設定で1つずつ許した第三者の tool（`patrol.allowedTools`）。ここはその一覧を Module の今の tool から
// 毎回導く（写しを持たない、規則3）。MCP の `readOnlyHint`・`openWorldHint` は判断の材料として見せるだけで、根拠にしない。

import { declaresReadEffect, patrolAllowedEntry, PATROL_RESOURCES_ENTRY, visibilityOf } from "@banto/module-contract";
import { mayCallInReadOnly } from "../relay/read-only.js";
import type { ModuleClientLike } from "./app.js";

/** Module の一覧を引く口（`resolveModuleClientsForProject` の形のうち、ここで使うところ） */
export type PatrolModuleClients = Array<{ name: string; client: Pick<ModuleClientLike, "listTools">; bundled?: boolean }>;

const LIST_TIMEOUT_MS = 10_000;

interface ListedTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: unknown; openWorldHint?: unknown };
  _meta?: Record<string, unknown>;
}

/** AI に見せる（`agent`）tool だけ。答えない Module は理由つきで返す（黙って空にしない、規則2） */
async function agentToolsOf(client: Pick<ModuleClientLike, "listTools">): Promise<{ tools: ListedTool[] } | { error: string }> {
  try {
    const { tools } = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
    return { tools: (tools as ListedTool[]).filter((t) => visibilityOf(t) === "agent") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * **読むだけの回で使ってよい Module の tool**（`mcp__<Module>__<tool>`）。PreToolUse の最後の網に使う。一覧を返さない Module の
 * tool は載せない（通さない側に倒す）が、書き残す
 */
export async function readOnlyModuleToolNames(modules: PatrolModuleClients, allowed: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  await Promise.all(
    modules.map(async (m) => {
      const listed = await agentToolsOf(m.client);
      if ("error" in listed) {
        console.warn(`[host] 読むだけの回で使える tool を ${m.name} から引けませんでした（その Module の tool は通しません）: ${listed.error}`);
        return;
      }
      for (const tool of listed.tools) {
        if (mayCallInReadOnly({ moduleName: m.name, bundled: m.bundled === true, tool, allowed })) names.push(`mcp__${m.name}__${tool.name}`);
      }
    }),
  );
  return names.sort();
}

/** 画面に出す1つの tool */
export interface PatrolToolEntry {
  name: string;
  description?: string;
  /** Module の名乗り（判断の材料。根拠にはしない） */
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
  /** 人が許しているか（第三者の tool だけ） */
  allowed: boolean;
}

/** 画面に出す1つの Module */
export type PatrolToolsModule =
  | {
      name: string;
      bundled: true;
      /** banto が確かめた読むだけの tool（外せない） */
      verified: string[];
    }
  | {
      name: string;
      bundled: false;
      tools: PatrolToolEntry[];
      /** 「資源を読む」を許しているか */
      resourcesAllowed: boolean;
    }
  | { name: string; bundled: boolean; error: string };

/** **設定の画面に出す一覧**。同梱は読むだけの tool の名前だけ、第三者は AI に見せる tool を全部（許すかは人が決める） */
export async function listPatrolTools(modules: PatrolModuleClients, allowed: readonly string[]): Promise<PatrolToolsModule[]> {
  const listed = await Promise.all(
    modules.map(async (m): Promise<PatrolToolsModule> => {
      const bundled = m.bundled === true;
      const result = await agentToolsOf(m.client);
      if ("error" in result) return { name: m.name, bundled, error: result.error };
      if (bundled) return { name: m.name, bundled: true, verified: result.tools.filter((t) => declaresReadEffect(t)).map((t) => t.name).sort() };
      return {
        name: m.name,
        bundled: false,
        tools: result.tools
          .map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(typeof t.annotations?.readOnlyHint === "boolean" ? { readOnlyHint: t.annotations.readOnlyHint } : {}),
            ...(typeof t.annotations?.openWorldHint === "boolean" ? { openWorldHint: t.annotations.openWorldHint } : {}),
            allowed: allowed.includes(patrolAllowedEntry(m.name, t.name)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        resourcesAllowed: allowed.includes(patrolAllowedEntry(m.name, PATROL_RESOURCES_ENTRY)),
      };
    }),
  );
  return listed.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * **人が保存した一覧を確かめる**。形が `<Module>/<tool>` か `<Module>/resources` でないものは断る（黙って落とさない、規則2）。
 * 今その Module に無い tool も残してよい（Module が止まっている間に保存しても、許したものを消さない）
 */
export function validatePatrolAllowed(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value) || !value.every((x): x is string => typeof x === "string")) {
    return { error: "allowed は「<Module>/<tool>」の文字列の配列で渡してください" };
  }
  for (const entry of value) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(entry)) return { error: `「${entry}」は「<Module>/<tool>」の形ではありません` };
  }
  return value;
}
