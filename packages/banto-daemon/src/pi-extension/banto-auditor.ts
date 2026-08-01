/**
 * banto-auditor: pi Extension adapter for banto audit tools.
 *
 * Thin wrapper that registers banto-core audit tools with pi.
 * All logic lives in banto-core (D5). This file only handles:
 *   1. Reading env vars for DaemonClient configuration
 *   2. Mapping banto-core BantoTool definitions to pi's registerTool format
 *   3. Injecting the audit system prompt + checklist via pi.on("before_agent_start", ...)
 *
 * Usage: pi -e ./packages/banto-daemon/src/pi-extension/banto-auditor.ts
 *
 * Environment variables:
 *   BANTO_DAEMON_URL  - daemon base URL (default: http://localhost:3000)
 *   BANTO_PROJECT     - project tag to report events against (required)
 *   BANTO_TASK_ID     - task ID being audited (required)
 *
 * D6: no dependencies beyond banto-core and node built-ins.
 *     pi itself is the runtime; we do not import its modules here so that
 *     banto-core can remain pi-free. The pi parameter is typed `any` because
 *     importing @mariozechner/pi-coding-agent would violate D6 (adds a build dep)
 *     and the adapter is always loaded by pi at runtime, which provides the API. (I4)
 */

import { DaemonClient, createAuditTools, loadPromptAsset } from "@banto/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API is runtime-provided; see module doc (I4)
export default function (pi: any): void {
  // Read configuration from environment
  const daemonUrl = process.env["BANTO_DAEMON_URL"];
  const projectTag = process.env["BANTO_PROJECT"];
  const taskId = process.env["BANTO_TASK_ID"];

  if (!projectTag || !taskId) {
    // I2: missing required config → surface error, do not silently proceed
    throw new Error(
      "[banto-auditor] BANTO_PROJECT and BANTO_TASK_ID must be set"
    );
  }

  const client = new DaemonClient(daemonUrl);

  // Register all banto audit tools
  for (const tool of createAuditTools(client)) {
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
        // Type widened to Record for findings normalization below (I4: see comment).
        const args: Record<string, unknown> = { ...params, projectTag, taskId };
        // Ensure findings is always an array (LLM may pass a string or null for empty)
        if (!Array.isArray(args["findings"])) {
          args["findings"] = args["findings"] ? [String(args["findings"])] : [];
        }
        const result = await tool.execute(args, { toolCallId: _toolCallId });
        return { content: result.content, details: result.details ?? {} };
      },
    });
  }

  // Inject audit system prompt + checklist via before_agent_start hook.
  pi.on(
    "before_agent_start",
    (
      event: { systemPrompt: string },
      _ctx: unknown
    ): { systemPrompt: string } => {
      const systemPrompt = loadPromptAsset("audit-system");
      const checklist = loadPromptAsset("audit-checklist");
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n" +
          systemPrompt +
          "\n\n## 監査チェックリスト\n\n" +
          checklist,
      };
    }
  );
}
