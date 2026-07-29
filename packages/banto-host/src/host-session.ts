/**
 * Banto host session — embeds pi's Agent SDK loop directly in this process (ADR-0010 決定11).
 *
 * SDK mode, not Extension API and not RPC mode: banto-host owns AgentSession construction
 * in-process, in TypeScript, so it gets direct access to message history and turn-boundary
 * events (needed for the memory injection / turn control that is 番頭's core job, D11).
 *
 * D5: no judgment logic here — this only assembles a session from the given
 * system prompt and namespaced tools. Turn control / memory injection are later tasks.
 * D6: uses only what createAgentSession() already exposes.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import type { MemoryStore } from "@banto/core";
import { createMemoryTools, renderMemoryForPrompt } from "./memory-tools.js";
import { createSkillTools } from "./skill-tools.js";
import { loadBantoSkills, renderSkillsForPrompt } from "./skills.js";
import { toWireTool, type NamespacedToolDefinition } from "./tool-registry.js";

export interface CreateBantoHostSessionOptions {
  /** System prompt for this turn loop. Plain string here — real prompt content is a later task. */
  systemPrompt: string;
  /** Namespaced tools (kobo.*, canvas.*, ...) available to the session. */
  tools: NamespacedToolDefinition[];
  /**
   * 番頭の記憶（D11）。渡すと `memory.save` / `memory.recall` が自動で登録され、
   * 保存済みの好み・習慣がシステムプロンプトへ注入される。
   * 省略すると記憶なしのセッションになる（テスト・使い捨て用途）。
   */
  memory?: MemoryStore;
  /**
   * 番頭のSKILL（手続き記憶）を読み込むか。既定 true。
   * false にすると `packages/banto-host/skills/` を読まない（テスト用）。
   */
  loadBantoSkills?: boolean;
  /** Working directory for resource discovery. Default: process.cwd() */
  cwd?: string;
  /** Global pi config directory. Default: ~/.pi/agent */
  agentDir?: string;
  model?: CreateAgentSessionOptions["model"];
  authStorage?: CreateAgentSessionOptions["authStorage"];
  modelRegistry?: CreateAgentSessionOptions["modelRegistry"];
  sessionManager?: CreateAgentSessionOptions["sessionManager"];
}

/**
 * Creates a minimal Banto host agent session: the given system prompt, the given
 * namespaced tools, and none of pi's built-in coding tools (read/bash/edit/write) —
 * 番頭 delegates file-level work to 職人 (D10), it does not edit files itself here.
 *
 * Tools are handed to the SDK under their **wire names** (決定22): the logical dotted
 * contract (`kobo.query.ready`) is preserved on the Banto side, while the provider sees
 * `kobo__query__ready`, which openai-completions-compatible providers accept.
 *
 * `memory` を渡すと、番頭は記憶を持つ（D11）——保存済みの好み・習慣がシステムプロンプトへ
 * 注入され、`memory.save` / `memory.recall` で読み書きできる。
 */
export async function createBantoHostSession(
  options: CreateBantoHostSessionOptions
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();

  // SKILLは一覧だけをプロンプトに載せ、本体は skill.read で読ませる（progressive disclosure）。
  // pi 側の SKILL 機構は read ツールを前提とするため使わない（理由は skills.ts 冒頭）。
  const skills = options.loadBantoSkills === false ? [] : loadBantoSkills();

  // 記憶とSKILL一覧をシステムプロンプトの末尾に足す。
  // 記憶はセッション開始時点の内容を焼き込むので、以後の保存分は memory.recall で読み直す。
  const sections = [
    options.systemPrompt,
    options.memory ? renderMemoryForPrompt(options.memory) : "",
    renderSkillsForPrompt(skills),
  ].filter((s) => s.length > 0);
  const systemPrompt = sections.join("\n\n");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();

  const tools = [
    ...options.tools,
    ...(options.memory ? createMemoryTools(options.memory) : []),
    ...(skills.length > 0 ? createSkillTools(skills) : []),
  ];

  return createAgentSession({
    cwd,
    agentDir,
    model: options.model,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader,
    noTools: "builtin",
    customTools: tools.map(toWireTool),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
  });
}
