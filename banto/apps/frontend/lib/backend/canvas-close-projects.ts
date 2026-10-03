// **Canvas から「この Project を閉じる確かめを開いて」と頼む口**（banto の拡張、2026-10-03、`docs/specs/v4-frontend.md` §6.2、
// `docs/specs/v4-modules.md` §2.4「このマシンから削除」）。
//
// Repositories が「このマシンから削除」したフォルダを Project が使っていたとき、その Project を閉じる確かめを開く。
// - 画面 → banto：request `dev.banto/close-projects`（`params.projectIds`）
// - banto：core の「Project を閉じる」の確かめを開くだけ。**閉じるのは人がそこで押したとき**（core の
//   `POST /api/projects/:id/close`、閉じた Project の一覧から再開できる）。Module は Project に触らない
// - 受ける・断るの決まり（開く場所・開いている間・会話の中の画面）は `dev.banto/open-new-project` と同じ（`canvas-requests.ts`）

import { createCanvasRequestStore } from "./canvas-requests.ts";

export const CLOSE_PROJECTS_METHOD = "dev.banto/close-projects";

export interface CloseProjectsRequest {
  seq: number;
  projectIds: string[];
  /** どの Module の画面から頼まれたか（開いた確かめに出す） */
  from?: string;
}

export const closeProjectsRequests = createCanvasRequestStore<Omit<CloseProjectsRequest, "seq">>("Project を閉じる確かめ");

/** 画面から来た params を読む。読めなければ理由 */
export function parseCloseProjectsParams(params: unknown): { projectIds: string[] } | { error: string } {
  const ids = (params as { projectIds?: unknown } | undefined)?.projectIds;
  if (!Array.isArray(ids) || ids.length === 0) return { error: "projectIds が要ります" };
  if (ids.length > 20 || !ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id))) {
    return { error: "projectIds は Project の id の並び（20 個まで）で渡してください" };
  }
  return { projectIds: [...new Set(ids as string[])] };
}
