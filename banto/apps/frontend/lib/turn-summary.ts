// **ターンの終わりのまとめ**（決定・2026-10-06、ユーザー。v4-frontend.md §6.35・アーキ仕様 §2.2）の、画面が知っている形。
// 真実は host（`packages/core/src/http/turn-summary.ts` の `report_turn`）。ここは描くのに要る形だけを写す
export const TURN_SUMMARY_TOOL_NAME = "mcp__banto-thread__report_turn";

export type TurnOutcomeStatus = "done" | "partial" | "failed";

export const OUTCOME_LABEL: Record<TurnOutcomeStatus, string> = {
  done: "終わりました",
  partial: "途中まで",
  failed: "できませんでした",
};

export interface TurnSummaryOption {
  label: string;
  reply: string;
  recommended?: boolean;
}

export interface TurnSummaryDecision {
  question: string;
  context?: string;
  options: readonly TurnSummaryOption[];
}

export interface TurnSummary {
  request: string;
  outcome: {
    status: TurnOutcomeStatus;
    headline: string;
    points: readonly string[];
    notVerified?: readonly string[];
    artifacts?: readonly { label: string; detail: string }[];
  };
  decisions: readonly TurnSummaryDecision[];
  nextSuggestions?: readonly TurnSummaryOption[];
}

/** 記録に残ったまとめ（host が受け付けた時刻つき） */
export interface RealTurnSummary {
  summary: TurnSummary;
  at: string;
}

/** 引数として届いたものが描ける形か（AI が書きかけ・壊れた引数でも画面を落とさない） */
export function asTurnSummary(value: unknown): TurnSummary | undefined {
  const v = value as Partial<TurnSummary> | undefined;
  if (!v || typeof v.request !== "string" || !v.outcome || typeof v.outcome.headline !== "string") return undefined;
  return {
    request: v.request,
    outcome: {
      status: v.outcome.status === "partial" || v.outcome.status === "failed" ? v.outcome.status : "done",
      headline: v.outcome.headline,
      points: Array.isArray(v.outcome.points) ? v.outcome.points.filter((p) => typeof p === "string") : [],
      ...(Array.isArray(v.outcome.notVerified) ? { notVerified: v.outcome.notVerified } : {}),
      ...(Array.isArray(v.outcome.artifacts) ? { artifacts: v.outcome.artifacts } : {}),
    },
    decisions: Array.isArray(v.decisions) ? v.decisions.filter((d) => d && Array.isArray(d.options)) : [],
    ...(Array.isArray(v.nextSuggestions) ? { nextSuggestions: v.nextSuggestions } : {}),
  };
}
