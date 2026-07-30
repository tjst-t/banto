/**
 * 職人セッション・監査セッション向けの Tool（`report_phase` / `report_done` / `audit_report`）。
 *
 * **契約の型は `banto-tool.ts` の1つだけ**（task-0025・imp-0003）。以前ここには
 * `BantoTool` という別の型があり、`execute(client: DaemonClient, args)` で Kobo の
 * クライアントに結合していた——「中立な型」ではなく「Kobo を呼ぶ型」だったため、
 * `canvas.*` / `worker.*` のような Kobo を呼ばない Tool を表せなかった。
 *
 * 依存（`DaemonClient`）は**Tool を作る関数の引数**で受け、クロージャに閉じ込める。
 * 型には現れない。
 *
 * D5: 判断は Kobo にある。ここは受け渡しだけ。
 * I2: `DaemonClient` のエラーはそのまま伝播させる。握りつぶさない。
 *
 * Tool の組：
 *   createExecutorTools(client) — 職人セッション向け（report_phase / report_done）
 *   createAuditTools(client)    — 監査セッション向け（audit_report）
 */

import { Type } from "typebox";
import type { DaemonClient } from "./daemon-client.js";
import { defineBantoTool, type AnyBantoTool } from "./banto-tool.js";

/**
 * 職人セッション向けの Tool を作る。
 *
 * `projectTag` / `taskId` はパラメータに残す（pi アダプタ文脈では環境変数で上書きされる）。
 */
export function createExecutorTools(client: DaemonClient): AnyBantoTool[] {
  // ── report_phase ──────────────────────────────────────────────────────────
  //
  // D3: 状態の真実は Kobo のイベントログで、エージェントの自己申告ではない。
  //
  // DEC-S254276-012 RESOLVED (S75f66b-3): 職人は自分で auditing へ遷移しない。
  // 監査は implementing→auditing を Kobo が検知して起こす。
  const reportPhase = defineBantoTool({
    name: "report_phase",
    label: "Report phase",
    description:
      "Report the current work phase to banto daemon. " +
      "Call this when the execution phase changes: " +
      "planning (analysing task) or implementing (writing code). " +
      "When implementation is complete, call report_done instead. " +
      "The daemon records a state_transitioned event (D3).",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("planning"), Type.Literal("implementing")], {
        description: "New execution phase (planning or implementing).",
      }),
      projectTag: Type.String({
        description:
          "Project tag as registered in banto daemon (e.g. 'my-project'). pi adapter文脈ではBANTO_PROJECT envで上書きされる。",
      }),
      taskId: Type.String({
        description:
          "Task ID to update (e.g. 'T-0001'). pi adapter文脈ではBANTO_TASK_ID envで上書きされる。",
      }),
      note: Type.Optional(
        Type.String({ description: "Optional short note to include with the phase transition." })
      ),
    }),
    async execute(args) {
      // D5: 状態変更は Kobo の API 経由のみ。職人が review-ready へ進めることはできない
      await client.transition(args.projectTag, args.taskId, args.phase, args.note);
      return { content: [{ type: "text", text: `phase updated to ${args.phase}` }] };
    },
  });

  // ── report_done ───────────────────────────────────────────────────────────
  //
  // 職人にとっての「done」は「実装が終わったので監査へ出す」。Kobo が監査セッションを
  // 起こし、review-ready へ進めるかは監査が決める（職人は決めない）。
  const reportDone = defineBantoTool({
    name: "report_done",
    label: "Report done",
    description:
      "Report task implementation completion to banto daemon with a summary of what was done. " +
      "Use this after all implementation work is finished. " +
      "Transitions the task to 'auditing'; the daemon will spawn an audit session " +
      "that verifies the work against the task definition and checklist. " +
      "Do NOT try to transition to review-ready yourself — that is the audit's decision.",
    parameters: Type.Object({
      summary: Type.String({ description: "Brief summary of what was implemented or changed." }),
      projectTag: Type.String({
        description:
          "Project tag as registered in banto daemon. pi adapter文脈ではBANTO_PROJECT envで上書きされる。",
      }),
      taskId: Type.String({
        description: "Task ID that is done. pi adapter文脈ではBANTO_TASK_ID envで上書きされる。",
      }),
    }),
    async execute(args) {
      await client.transition(args.projectTag, args.taskId, "auditing", args.summary);
      return {
        content: [
          {
            type: "text",
            text: `Task ${args.taskId} submitted for audit. Summary: ${args.summary}`,
          },
        ],
      };
    },
  });

  return [reportPhase, reportDone];
}

/**
 * 監査セッション向けの Tool を作る。
 *
 * D5: 判定の振り分け（pass→merging/review-ready、fail→rework/failed）は Kobo にある。
 * ここは素通しで、監査の言い分をそのまま届けるだけ。
 */
export function createAuditTools(client: DaemonClient): AnyBantoTool[] {
  const auditReport = defineBantoTool({
    name: "audit_report",
    label: "Audit report",
    description:
      "Submit the audit verdict to banto daemon after inspecting the task's implementation. " +
      "verdict: 'pass' if all acceptance criteria and checklist items are satisfied; " +
      "'fail' if any issue was found. " +
      "findings: list of specific issues found (empty for pass; required for fail). " +
      "The daemon will route the task accordingly: pass→review-ready or merging, " +
      "fail→rework (first fail) or failed (second consecutive fail).",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
        description: "Audit verdict: 'pass' (all criteria met) or 'fail' (issues found).",
      }),
      findings: Type.Array(Type.String(), {
        description: "List of specific issues found. Empty array for pass. Required for fail.",
      }),
      projectTag: Type.String({
        description:
          "Project tag as registered in banto daemon. pi adapter文脈ではBANTO_PROJECT envで上書きされる。",
      }),
      taskId: Type.String({
        description: "Task ID being audited. pi adapter文脈ではBANTO_TASK_ID envで上書きされる。",
      }),
    }),
    async execute(args) {
      // I2: DaemonClient のエラーはそのまま伝播させる
      const result = await client.auditReport(
        args.projectTag,
        args.taskId,
        args.verdict,
        args.findings
      );
      return {
        content: [
          {
            type: "text",
            text: `audit_report submitted: verdict=${args.verdict}, findings=${JSON.stringify(args.findings)}, daemon_ok=${result.ok}`,
          },
        ],
      };
    },
  });

  return [auditReport];
}
