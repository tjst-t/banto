/**
 * banto-executor: pi Extension adapter for banto executor tools.
 *
 * Thin wrapper (~60 lines) that registers banto-core executor tools with pi.
 * All logic lives in banto-core (D5). This file only handles:
 *   1. Reading env vars for DaemonClient configuration
 *   2. Mapping banto-core BantoTool definitions to pi's registerTool format
 *   3. Injecting the system prompt via pi.on("session_start", ...)
 *
 * Usage: pi -e ./packages/banto-daemon/src/pi-extension/banto-executor.ts
 *
 * Environment variables:
 *   BANTO_DAEMON_URL  - daemon base URL (default: http://localhost:3000)
 *   BANTO_PROJECT     - project tag to report events against (required)
 *   BANTO_TASK_ID     - task ID being executed (required)
 *
 * D6: no dependencies beyond banto-core and node built-ins.
 *     pi itself is the runtime; we do not import its modules here so that
 *     banto-core can remain pi-free. The pi parameter is typed `any` because
 *     importing @mariozechner/pi-coding-agent would violate D6 (adds a build dep)
 *     and the adapter is always loaded by pi at runtime, which provides the API. (I4)
 */

import { DaemonClient, bantoExecutorTools, loadPromptAsset } from "@banto/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API is runtime-provided; see module doc (I4)
export default function (pi: any): void {
  // Read configuration from environment
  const daemonUrl = process.env["BANTO_DAEMON_URL"];
  const projectTag = process.env["BANTO_PROJECT"];
  const taskId = process.env["BANTO_TASK_ID"];

  if (!projectTag || !taskId) {
    // I2: missing required config → surface error, do not silently proceed
    throw new Error(
      "[banto-executor] BANTO_PROJECT and BANTO_TASK_ID must be set"
    );
  }

  const client = new DaemonClient(daemonUrl);

  // Register all banto executor tools
  for (const tool of bantoExecutorTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // Inline JSON Schema as-is; pi accepts plain schema objects at runtime
      parameters: tool.parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
        // Inject projectTag and taskId from environment into args (D5: no logic — env binding only)
        const args = { ...params, projectTag, taskId };
        const result = await tool.execute(client, args);
        return { ...result, details: {} };
      },
    });
  }

  // Inject executor system prompt via session_start hook
  pi.on(
    "session_start",
    async (
      _event: unknown,
      ctx: { systemPromptAppend: (text: string) => void }
    ) => {
      const prompt = loadPromptAsset("executor-system");
      ctx.systemPromptAppend(prompt);
    }
  );
}
