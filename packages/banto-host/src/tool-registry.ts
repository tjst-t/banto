/**
 * Tool registration scaffold for the Banto host (ADR-0010 決定9・決定11).
 *
 * Wraps pi's ToolDefinition/defineTool so every tool registered here is required
 * to follow the namespace convention (kobo.*, canvas.*, ...). This module only
 * provides the type + registration mechanism; concrete Kobo/canvas Tool
 * implementations (kobo.query.ready, canvas.open, ...) are out of scope for this
 * task and plug in via later tasks.
 *
 * D5: no judgment logic here — pure registration bookkeeping.
 * D6: no dependency beyond pi's own tool types and typebox (already a pi-coding-agent dependency).
 */

import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  assertNamespacedToolName,
  toWireToolName,
  toolDomain,
  type NamespacedToolName,
} from "./tool-namespace.js";

/** A pi ToolDefinition whose `name` is required to be namespaced (`<domain>.<verb...>`). */
export type NamespacedToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  // pi's own ToolDefinition defaults TState to `any`; this scaffold has no use for
  // TState-dependent custom rendering, so the default here is narrowed to `unknown` (I4).
  TState = unknown,
> = ToolDefinition<TParams, TDetails, TState> & { name: NamespacedToolName };

// `any` mirrors pi's own `AnyToolDefinition` escape hatch (extensions/types.ts): a concrete
// tool's `renderCall`/`renderResult` are contravariant in TParams/TState, so widening a
// concrete NamespacedToolDefinition<TObject<...>, ...> into the bare, param-erased
// NamespacedToolDefinition used by ToolRegistry needs this intersection to type-check (I4).
type AnyNamespacedToolDefinition = NamespacedToolDefinition<any, any, any>;

/**
 * Define a namespaced Banto host tool. Thin wrapper around pi's `defineTool()` that
 * additionally asserts the name follows the `<domain>.<verb...>` convention (I2: fails
 * loudly on a naming violation rather than registering a malformed contract).
 */
export function defineNamespacedTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: NamespacedToolDefinition<TParams, TDetails, TState>
): NamespacedToolDefinition<TParams, TDetails, TState> & AnyNamespacedToolDefinition {
  assertNamespacedToolName(tool.name);
  return defineTool(tool) as NamespacedToolDefinition<TParams, TDetails, TState> & AnyNamespacedToolDefinition;
}

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
 * Rewrites a tool's name to its wire form for handing to the agent SDK / LLM (決定22).
 * Only the `name` changes — parameters, description and `execute` are untouched, so the
 * logical contract stays the single source of truth on the Banto side.
 */
export function toWireTool(tool: NamespacedToolDefinition): ToolDefinition {
  return { ...tool, name: toWireToolName(tool.name) } as ToolDefinition;
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
