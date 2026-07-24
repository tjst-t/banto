/**
 * Banto tool definitions — runtime-neutral.
 *
 * Each tool is a plain object: { name, description, parameters (JSON Schema), execute }.
 * No imports from @mariozechner/pi-coding-agent or any agent SDK.
 * execute() calls daemon APIs via DaemonClient exclusively (D5: no logic here).
 *
 * Runtime adapters (pi Extension, agent-sdk) register these tools by mapping
 * the parameters schema and wrapping execute() to fit their own tool type.
 *
 * D5: judgment stays in daemon; tools are pass-through wrappers.
 * D6: no dependencies beyond the DaemonClient already in this package.
 * I2: errors from DaemonClient propagate — not swallowed here.
 *
 * Tool sets:
 *   bantoExecutorTools  — for executor sessions (report_phase, report_done)
 *   bantoAuditTools     — for audit sessions (audit_report)
 */

import type { DaemonClient } from "./daemon-client.js";

// ── Tool result type (plain, not tied to any runtime) ────────────────────────

/** Runtime-neutral tool content block. Structurally compatible with pi and agent-sdk. */
export interface ToolTextContent {
  type: "text";
  text: string;
}

/** Runtime-neutral tool result returned by execute(). */
export interface ToolResult {
  content: ToolTextContent[];
}

// ── JSON Schema parameter type (plain object, not typebox) ───────────────────

/** Minimal JSON Schema object sufficient for tool parameter declarations. */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description: string;
    enum?: string[];
    nullable?: boolean;
    items?: { type: string };
  }>;
  required: string[];
}

// ── BantoTool definition ─────────────────────────────────────────────────────

export interface BantoTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** Tool name as the LLM will call it. */
  name: string;
  /** Human-readable description (shown to the LLM). */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  parameters: ToolParameterSchema;
  /**
   * Execute the tool. Calls DaemonClient only (D5).
   * @param client - DaemonClient configured for the current daemon URL
   * @param args   - Validated tool arguments
   * @returns runtime-neutral ToolResult
   */
  execute(client: DaemonClient, args: TArgs): Promise<ToolResult>;
}

// ── report_phase ─────────────────────────────────────────────────────────────

interface ReportPhaseArgs extends Record<string, unknown> {
  phase: "planning" | "implementing";
  projectTag: string;
  taskId: string;
  note?: string;
}

/**
 * report_phase: executor reports a work-phase transition to daemon.
 * Calls POST /api/v1/projects/:proj/tasks/:id/transition with { to: phase }.
 * D3: state truth is the daemon event log, not the agent's self-report.
 *
 * DEC-S254276-012 RESOLVED (S75f66b-3): executor no longer self-transitions to auditing.
 * Auditing is exclusively triggered by the daemon on implementing→auditing.
 * report_phase only reports planning/implementing phases.
 * The "review-ready" enum value has been removed — use report_done instead.
 */
export const reportPhaseTool: BantoTool<ReportPhaseArgs> = {
  name: "report_phase",
  description:
    "Report the current work phase to banto daemon. " +
    "Call this when the execution phase changes: " +
    "planning (analysing task) or implementing (writing code). " +
    "When implementation is complete, call report_done instead. " +
    "The daemon records a state_transitioned event (D3).",
  parameters: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        enum: ["planning", "implementing"],
        description: "New execution phase (planning or implementing).",
      },
      projectTag: {
        type: "string",
        description: "Project tag as registered in banto daemon (e.g. 'my-project'). pi adapter文脈ではBANTO_PROJECT envで上書きされる。",
      },
      taskId: {
        type: "string",
        description: "Task ID to update (e.g. 'T-0001'). pi adapter文脈ではBANTO_TASK_ID envで上書きされる。",
      },
      note: {
        type: "string",
        description: "Optional short note to include with the phase transition.",
        nullable: true,
      },
    },
    required: ["phase", "projectTag", "taskId"],
  },
  async execute(client, args): Promise<ToolResult> {
    // D5: all state changes via daemon API transitions only.
    // Executor phases: planning → daemon "planning", implementing → daemon "implementing".
    // The executor must NOT self-transition to auditing or review-ready.
    // Auditing is triggered exclusively by the daemon (S75f66b-3).
    await client.transition(args.projectTag, args.taskId, args.phase, args.note);
    return {
      content: [
        { type: "text", text: `phase updated to ${args.phase}` },
      ],
    };
  },
};

// ── report_done ──────────────────────────────────────────────────────────────

interface ReportDoneArgs extends Record<string, unknown> {
  summary: string;
  projectTag: string;
  taskId: string;
}

/**
 * report_done: executor signals implementation completion with a summary.
 * Calls POST /api/v1/projects/:proj/tasks/:id/transition with { to: "auditing" }.
 *
 * Design note: "done" in executor terms means "implementation finished, submit for audit".
 * The executor transitions to "auditing"; the daemon then auto-spawns an audit session.
 * The audit session (not the executor) decides whether the task moves to review-ready/merging.
 *
 * DEC-S254276-012 RESOLVED (S75f66b-3): executor only transitions to "auditing" here.
 * The previous provisional two-hop (implementing→auditing→review-ready) is removed.
 * Verdict routing from auditing onwards belongs exclusively to the daemon/audit path.
 */
export const reportDoneTool: BantoTool<ReportDoneArgs> = {
  name: "report_done",
  description:
    "Report task implementation completion to banto daemon with a summary of what was done. " +
    "Use this after all implementation work is finished. " +
    "Transitions the task to 'auditing'; the daemon will spawn an audit session " +
    "that verifies the work against the task definition and checklist. " +
    "Do NOT try to transition to review-ready yourself — that is the audit's decision.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of what was implemented or changed.",
      },
      projectTag: {
        type: "string",
        description: "Project tag as registered in banto daemon. pi adapter文脈ではBANTO_PROJECT envで上書きされる。",
      },
      taskId: {
        type: "string",
        description: "Task ID that is done. pi adapter文脈ではBANTO_TASK_ID envで上書きされる。",
      },
    },
    required: ["summary", "projectTag", "taskId"],
  },
  async execute(client, args): Promise<ToolResult> {
    // D5: daemon API transitions only.
    // "done" means implementation finished → transition to "auditing".
    // The daemon will auto-spawn an audit session which posts the final verdict.
    // DEC-S254276-012 RESOLVED: no more two-hop self-transition.
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
};

// ── audit_report ─────────────────────────────────────────────────────────────

interface AuditReportArgs extends Record<string, unknown> {
  verdict: "pass" | "fail";
  findings: string[];
  projectTag: string;
  taskId: string;
}

/**
 * audit_report: audit session submits its verdict to daemon.
 * Calls POST /api/v1/projects/:proj/tasks/:id/audit-report with { verdict, findings }.
 *
 * D5: all routing logic (pass→merging/review-ready, fail→rework/failed) lives in daemon.
 * This tool is purely a pass-through to the daemon API.
 *
 * Called by the audit agent registered via banto-auditor pi extension.
 * S75f66b-3: implements AC-S75f66b-3-3 and AC-S75f66b-3-4.
 */
export const auditReportTool: BantoTool<AuditReportArgs> = {
  name: "audit_report",
  description:
    "Submit the audit verdict to banto daemon after inspecting the task's implementation. " +
    "verdict: 'pass' if all acceptance criteria and checklist items are satisfied; " +
    "'fail' if any issue was found. " +
    "findings: list of specific issues found (empty for pass; required for fail). " +
    "The daemon will route the task accordingly: pass→review-ready or merging, " +
    "fail→rework (first fail) or failed (second consecutive fail).",
  parameters: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail"],
        description: "Audit verdict: 'pass' (all criteria met) or 'fail' (issues found).",
      },
      findings: {
        type: "array",
        description: "List of specific issues found. Empty array for pass. Required for fail.",
        items: { type: "string" },
      },
      projectTag: {
        type: "string",
        description: "Project tag as registered in banto daemon. pi adapter文脈ではBANTO_PROJECT envで上書きされる。",
      },
      taskId: {
        type: "string",
        description: "Task ID being audited. pi adapter文脈ではBANTO_TASK_ID envで上書きされる。",
      },
    },
    required: ["verdict", "findings", "projectTag", "taskId"],
  },
  async execute(client, args): Promise<ToolResult> {
    // D5: all routing logic lives in daemon. This is a pure pass-through.
    // I2: errors from DaemonClient propagate — not swallowed here.
    const result = await client.auditReport(
      args.projectTag,
      args.taskId,
      args.verdict,
      args.findings as string[]
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
};

// ── Export all tools as collections ──────────────────────────────────────────

/** All banto executor tools. Pass this array to a runtime adapter's registration step. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous array; each element is BantoTool<specific args>
export const bantoExecutorTools: BantoTool<any>[] = [reportPhaseTool, reportDoneTool];

/** All banto audit tools. Pass this array to the audit session adapter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous array; each element is BantoTool<specific args>
export const bantoAuditTools: BantoTool<any>[] = [auditReportTool];
