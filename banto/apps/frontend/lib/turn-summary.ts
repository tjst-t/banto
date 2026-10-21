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
  /** その選択肢の中身（モック・公開した画面）を選ぶ前に見られる場所（追加・2026-10-15。host が http/https だけ通す） */
  url?: string;
}

/** できたもの。`url` があれば開いて見られる（追加・2026-10-15） */
export interface TurnSummaryArtifact {
  label: string;
  detail: string;
  url?: string;
}

export interface TurnSummaryDecision {
  question: string;
  context?: string;
  /** 問いの種類（追加・2026-10-21、アーキ仕様 §4.5「問いの種類」）。行い（continue 等）か spec・publish・money・destructive */
  kind?: string;
  options: readonly TurnSummaryOption[];
}

export interface TurnSummary {
  request: string;
  outcome: {
    status: TurnOutcomeStatus;
    headline: string;
    points: readonly string[];
    notVerified?: readonly string[];
    artifacts?: readonly TurnSummaryArtifact[];
  };
  decisions: readonly TurnSummaryDecision[];
  nextSuggestions?: readonly TurnSummaryOption[];
}

/** 記録に残ったまとめ（host が受け付けた時刻つき） */
export interface RealTurnSummary {
  summary: TurnSummary;
  at: string;
}

/**
 * **押せるリンクにしてよい URL か**（追加・2026-10-15）。host も http/https だけ通すが、走っている間は AI が書いた引数が
 * そのまま届く——`javascript:` 等を `href` に入れない
 */
export function safeLinkUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** banto が知っている場所（`knownPlaceUrl`） */
export interface KnownPlaces {
  /** banto の画面のオリジン（会話・Project の中の場所はこの下の `/p/<projectId>`） */
  bantoOrigin: string;
  projectId: string;
  /** その Project のリポジトリの GitHub の場所（`owner/repo`）。分からなければ空 */
  githubRepos?: readonly string[];
}

/**
 * **読むだけの回が書いた URL を、押せるリンクにしてよいか**（追加・2026-10-20、アーキ仕様 §4.4「読むだけの回が書いた URL は
 * リンクにしない」）。外の文を読んだ見回りが操られて、読んだ中身を URL に載せて人に押させるのを防ぐ。banto が知っている場所
 * （この Project の banto の画面の中・その Project のリポジトリの GitHub の場所）だけを返し、**クエリと `#` 以降は落とす**。
 * それ以外は undefined（文字のまま出す）
 */
export function knownPlaceUrl(url: unknown, places: KnownPlaces): string | undefined {
  if (typeof url !== "string") return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  const bare = `${u.origin}${u.pathname}`;
  let banto: URL | undefined;
  try {
    banto = new URL(places.bantoOrigin);
  } catch {
    banto = undefined;
  }
  const projectPath = `/p/${encodeURIComponent(places.projectId)}`;
  if (banto && u.origin === banto.origin && (u.pathname === projectPath || u.pathname.startsWith(`${projectPath}/`))) return bare;
  if (u.origin === "https://github.com") {
    const [owner, repo] = u.pathname.split("/").filter((p) => p !== "");
    const named = owner && repo ? `${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase() : undefined;
    if (named && (places.githubRepos ?? []).some((r) => r.toLowerCase() === named)) return bare;
  }
  return undefined;
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
