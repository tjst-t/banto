/**
 * Tool レジストリと pi アダプタ（ADR-0010 決定9・決定11・決定22、task-0025）。
 *
 * **契約は `@banto/core` にある。** ここにあるのは登録の帳簿と、pi へ写す薄い皮だけ。
 * 以前はこのファイルが pi の `ToolDefinition` を契約そのものに使っており、モジュールが
 * Tool を定義するのに pi への型依存が要る状態だった（imp-0003）。決定1「アダプタは
 * 薄い皮に留める」に反していたため、契約を core へ移した。
 *
 * D5: 判断は無い。登録の帳簿と型変換のみ。
 * D6: 依存は @banto/core と pi の型のみ（pi 依存はこの層に閉じる）。
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  assertNamespacedToolName,
  toWireToolName,
  toolDomain,
  type AnyBantoTool,
  type NamespacedToolDefinition,
} from "@banto/core";

export type { NamespacedToolDefinition };
// 契約と定義関数は banto-core の持ち物。ここは pi への写しだけを持つ（決定1「薄い皮」）
export { defineNamespacedTool } from "@banto/core";

/** Registry of namespaced tools available to the Banto host session. */
export interface ToolRegistry {
  /** Registers a tool. Throws if the name is not namespaced, already registered, or collides on its wire name (I2). */
  register(tool: NamespacedToolDefinition): void;
  /** All registered tools, in registration order. */
  list(): NamespacedToolDefinition[];
  /** Looks up a tool by its full namespaced (logical) name. */
  get(name: string): NamespacedToolDefinition | undefined;
  /**
   * Looks up a tool by the wire name the LLM actually calls (e.g. "kobo__query__ready").
   * Use this to map provider events (`tool_execution_*`) back to the logical contract (決定22).
   */
  getByWireName(wireName: string): NamespacedToolDefinition | undefined;
  /** All registered tools whose domain segment matches (e.g. "kobo", "canvas"). */
  byDomain(domain: string): NamespacedToolDefinition[];
}

/**
 * 中立な契約を pi の `ToolDefinition` へ写す（決定22 の wire 名変換もここ）。
 *
 * **これが「薄い皮」の実体。** 写すのは name / label / description / parameters / execute の
 * 5つだけで、残りは pi 側の既定に任せる。契約の側は pi の描画・実行モードの語彙を知らない。
 */
export function toPiTool(tool: NamespacedToolDefinition): ToolDefinition {
  const neutral = tool as AnyBantoTool;
  return {
    name: toWireToolName(tool.name),
    label: neutral.label,
    description: neutral.description,
    parameters: neutral.parameters,
    async execute(toolCallId: string, params: unknown) {
      const result = await neutral.execute(params, { toolCallId });
      // pi の AgentToolResult は details が必須。中立側では省略可なので既定で埋める
      return { content: result.content, details: result.details ?? {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の ToolDefinition は
    // TParams/TState について反変な描画フックを持ち、パラメータ消去した形へ代入するには
    // これが要る（pi 自身の AnyToolDefinition と同じ逃げ道）。(I4)
  } as any;
}

/** Creates an empty tool registry. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, NamespacedToolDefinition>();
  const byWireName = new Map<string, NamespacedToolDefinition>();

  return {
    register(tool) {
      assertNamespacedToolName(tool.name);
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered.`);
      }
      // 決定22: the wire name is what the provider actually sees. Two distinct logical names
      // must never collide there — the mapping is injective by construction, so a collision
      // means the invariant broke; fail loudly rather than silently shadowing a tool (I2).
      const wireName = toWireToolName(tool.name);
      const collision = byWireName.get(wireName);
      if (collision) {
        throw new Error(
          `Tool "${tool.name}" collides with "${collision.name}" on wire name "${wireName}".`
        );
      }
      tools.set(tool.name, tool);
      byWireName.set(wireName, tool);
    },
    list() {
      return Array.from(tools.values());
    },
    get(name) {
      return tools.get(name);
    },
    getByWireName(wireName) {
      return byWireName.get(wireName);
    },
    byDomain(domain) {
      return Array.from(tools.values()).filter((tool) => toolDomain(tool.name) === domain);
    },
  };
}
