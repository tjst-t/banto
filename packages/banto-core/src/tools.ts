/**
 * Banto executor tool definitions — runtime-neutral.
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
 */

import type { DaemonClient } from "./daemon-client.js";
import { DaemonApiError } from "./daemon-client.js";

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
  phase: "planning" | "implementing" | "review-ready";
  projectTag: string;
  taskId: string;
  note?: string;
}

/**
 * report_phase: executor reports a work-phase transition to daemon.
 * Calls POST /api/v1/projects/:proj/tasks/:id/transition with { to: phase }.
 * D3: state truth is the daemon event log, not the agent's self-report.
 */
export const reportPhaseTool: BantoTool<ReportPhaseArgs> = {
  name: "report_phase",
  description:
    "Report the current work phase to banto daemon. " +
    "Call this whenever the execution phase changes: " +
    "planning (analysing task), implementing (writing code), " +
    "or review-ready (implementation done, awaiting review). " +
    "The daemon records a state_transitioned event (D3).",
  parameters: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        enum: ["planning", "implementing", "review-ready"],
        description: "New execution phase.",
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
    // The executor's 3 phases map to the daemon state machine as follows:
    //   planning      → daemon "planning"      (direct)
    //   implementing  → daemon "implementing"  (direct)
    //   review-ready  → daemon "auditing" then "review-ready"
    //     (the executor self-audits; auditing→review-ready means PO review requested)
    if (args.phase === "review-ready") {
      // PROVISIONAL GOVERNANCE DEBT (S254276): 監査エージェントが未実装のため、実行者が
      // implementing→auditing→review-ready を自己遷移する。これは vision優先順位2
      // (ゲート・監査の構造的保証)に対する既知の暫定であり、Sprint S75f66b(監査・マージ機構)で
      // auditing 遷移は監査エージェント/daemonゲートの専有操作に変更される。
      // 記録: DEC-S254276-012

      // Two-hop: implementing → auditing → review-ready
      // First hop may fail with 400 if already in auditing (idempotent); second hop is the target.
      // I2: only swallow DaemonApiError status 400 (transition conflict) — connection errors,
      //     404s, and other failures must propagate so callers know the daemon is unreachable.
      try {
        await client.transition(args.projectTag, args.taskId, "auditing", args.note);
      } catch (err) {
        if (err instanceof DaemonApiError && err.status === 400) {
          // Already past implementing (e.g. already in auditing); proceed to review-ready.
        } else {
          throw err;
        }
      }
      await client.transition(args.projectTag, args.taskId, "review-ready", args.note);
    } else {
      await client.transition(args.projectTag, args.taskId, args.phase, args.note);
    }
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
 * report_done: executor signals completion with a summary.
 * Calls POST /api/v1/projects/:proj/tasks/:id/transition with { to: "review-ready" }
 * if the task is not already in review-ready, then records the summary as a note.
 *
 * Design note: "done" in executor terms means ready-for-review. The final
 * approved→merging→merged progression is PO/daemon territory (D5).
 */
export const reportDoneTool: BantoTool<ReportDoneArgs> = {
  name: "report_done",
  description:
    "Report task completion to banto daemon with a summary of what was done. " +
    "Use this after all implementation work is finished and the task is ready " +
    "for PO review. Transitions the task to review-ready and records the summary.",
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
    // "done" means the executor has self-audited; the path is implementing→auditing→review-ready.
    // PROVISIONAL GOVERNANCE DEBT (S254276): 監査エージェントが未実装のため、実行者が
    // implementing→auditing→review-ready を自己遷移する。これは vision優先順位2
    // (ゲート・監査の構造的保証)に対する既知の暫定であり、Sprint S75f66b(監査・マージ機構)で
    // auditing 遷移は監査エージェント/daemonゲートの専有操作に変更される。
    // 記録: DEC-S254276-012

    // I2: only swallow DaemonApiError status 400 (transition conflict — already in auditing).
    //     Connection errors, 404s, and other failures must propagate.
    try {
      await client.transition(args.projectTag, args.taskId, "auditing", args.summary);
    } catch (err) {
      if (err instanceof DaemonApiError && err.status === 400) {
        // May already be in auditing; proceed to review-ready.
      } else {
        throw err;
      }
    }
    await client.transition(
      args.projectTag,
      args.taskId,
      "review-ready",
      args.summary
    );
    return {
      content: [
        {
          type: "text",
          text: `Task ${args.taskId} marked as review-ready. Summary: ${args.summary}`,
        },
      ],
    };
  },
};

// ── Export all tools as a collection ─────────────────────────────────────────

/** All banto executor tools. Pass this array to a runtime adapter's registration step. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous array; each element is BantoTool<specific args>
export const bantoExecutorTools: BantoTool<any>[] = [reportPhaseTool, reportDoneTool];
