/**
 * banto-executor: pi Extension adapter for banto executor tools.
 *
 * Thin wrapper that registers banto-core executor tools with pi.
 * All logic lives in banto-core (D5). This file only handles:
 *   1. Reading env vars for DaemonClient configuration
 *   2. Mapping banto-core BantoTool definitions to pi's registerTool format
 *   3. Injecting the system prompt via pi.on("before_agent_start", ...)
 *
 * Usage: pi -e ./packages/banto-daemon/src/pi-extension/banto-executor.ts
 *
 * Environment variables:
 *   BANTO_DAEMON_URL  - daemon base URL (default: http://localhost:3000)
 *   BANTO_PROJECT     - project tag to report events against (required)
 *   BANTO_TASK_ID     - task ID（rework は `task-0001:rework`。ADR-0013 決定60 で職人の
 *                       台帳の鍵を役目ごとに分けたため。報告は接尾辞を外して返す）
 *
 * D6: no dependencies beyond banto-core and node built-ins.
 *     pi itself is the runtime; we do not import its modules here so that
 *     banto-core can remain pi-free. The pi parameter is typed `any` because
 *     importing @mariozechner/pi-coding-agent would violate D6 (adds a build dep)
 *     and the adapter is always loaded by pi at runtime, which provides the API. (I4)
 */

import { DaemonClient, createExecutorTools, loadPromptAsset } from "@banto/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API is runtime-provided; see module doc (I4)
export default function (pi: any): void {
  // Read configuration from environment
  const daemonUrl = process.env["BANTO_DAEMON_URL"];
  const projectTag = process.env["BANTO_PROJECT"];
  const taskId = process.env["BANTO_TASK_ID"]?.split(":")[0]; // 役目の接尾辞を外す

  if (!projectTag || !taskId) {
    // I2: missing required config → surface error, do not silently proceed
    throw new Error(
      "[banto-executor] BANTO_PROJECT and BANTO_TASK_ID must be set"
    );
  }

  const client = new DaemonClient(daemonUrl);

  // Register all banto executor tools
  for (const tool of createExecutorTools(client)) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      // Inline JSON Schema as-is; pi accepts plain schema objects at runtime
      parameters: tool.parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
        // Inject projectTag and taskId from environment into args (D5: no logic — env binding only).
        // Note: schema descriptions for projectTag/taskId state that in pi adapter context
        // these are always overridden by BANTO_PROJECT/BANTO_TASK_ID env vars.
        const args = { ...params, projectTag, taskId };
        const result = await tool.execute(args, { toolCallId: _toolCallId });
        return { content: result.content, details: result.details ?? {} };
      },
    });
  }

  // Inject executor system prompt via before_agent_start hook.
  // This fires before each LLM call and injects banto-specific instructions.
  // We use before_agent_start (not session_start) because it provides a
  // systemPrompt field that can be appended to. (extensions.md §before_agent_start)
  pi.on(
    "before_agent_start",
    (
      event: { systemPrompt: string },
      _ctx: unknown
    ): { systemPrompt: string } => {
      const prompt = loadPromptAsset("executor-system");
      return { systemPrompt: event.systemPrompt + "\n\n" + prompt };
    }
  );
}
