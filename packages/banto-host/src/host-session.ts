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
import type { NamespacedToolDefinition } from "./tool-registry.js";

export interface CreateBantoHostSessionOptions {
  /** System prompt for this turn loop. Plain string here — real prompt content is a later task. */
  systemPrompt: string;
  /** Namespaced tools (kobo.*, canvas.*, ...) available to the session. */
  tools: NamespacedToolDefinition[];
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
 */
export async function createBantoHostSession(
  options: CreateBantoHostSessionOptions
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => options.systemPrompt,
  });
  await resourceLoader.reload();

  return createAgentSession({
    cwd,
    agentDir,
    model: options.model,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader,
    noTools: "builtin",
    customTools: options.tools,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
  });
}
