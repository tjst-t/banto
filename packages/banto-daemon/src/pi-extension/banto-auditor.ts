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
 *   BANTO_DAEMON_URL  - daemon base URL (default: http://localhost:4500)
 *   BANTO_PROJECT     - project tag to report events against (required)
 *   BANTO_TASK_ID     - task ID being audited (required)
 *
 * BANTO_TASK_ID は Worker Pool 側の識別子なので、監査人には `task-0001:audit` のように
 * **役目の接尾辞**が付く（同じタスクに実装者と監査人が同時に居るため、職人の台帳の鍵を
 * 分ける必要がある。ADR-0013 決定60）。Kobo へ判定を返すのは接尾辞を外した素のタスクID。
 *
 * D6: no dependencies beyond banto-core and node built-ins.
 *     pi itself is the runtime; we do not import its modules here so that
 *     banto-core can remain pi-free. The pi parameter is typed `any` because
 *     importing @earendil-works/pi-coding-agent would violate D6 (adds a build dep)
 *     and the adapter is always loaded by pi at runtime, which provides the API. (I4)
 */

import { DaemonClient, createAuditTools, loadPromptAsset } from "@banto/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API is runtime-provided; see module doc (I4)
export default function (pi: any): void {
  // Read configuration from environment
  const daemonUrl = process.env["BANTO_DAEMON_URL"];
  const projectTag = process.env["BANTO_PROJECT"];
  // 役目の接尾辞（`:audit`）を外す。Kobo のタスクは `:` を含まない
  const taskId = process.env["BANTO_TASK_ID"]?.split(":")[0];

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

  /**
   * 監査人の役の説明を system prompt に足す（pi 経路だけ）。
   *
   * **チェックリストはここでは渡さない**（realign 第2便・段1）。この hook は
   * `driverOptions.extensionPaths`＝**pi の言葉**に載っており、Claude Agent SDK の
   * 職人はこの拡張を読まない——実運用の監査人はほぼ全て SDK 経路なので、ここだけで
   * 渡していたころ**基準は監査人に一度も届いていなかった**。
   *
   * いまは Kobo が指示文に載せて渡す（`buildAuditInstruction`）。経路に依らず届き、
   * `audit_verdict.checklistVersion` に刻む指紋が「実際に渡した中身」と一致する。
   * 二重に渡さないよう、ここからは外してある。
   */
  pi.on(
    "before_agent_start",
    (
      event: { systemPrompt: string },
      _ctx: unknown
    ): { systemPrompt: string } => {
      const systemPrompt = loadPromptAsset("audit-system");
      return {
        systemPrompt: event.systemPrompt + "\n\n" + systemPrompt,
      };
    }
  );
}
