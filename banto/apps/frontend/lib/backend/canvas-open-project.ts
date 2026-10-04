// **Canvas から「この Project を開いて」と頼む口**（banto の拡張、2026-10-04、`docs/specs/v4-frontend.md` §6.2、
// `docs/specs/v4-modules.md` §2.4「一覧」）。
//
// Repositories の一覧の「Project で使っている」の Project 名を押すと、その Project へ移る。
// - 画面 → banto：request `dev.banto/open-project`（`params.projectId`）
// - banto：**確かめの画面は出さずに、その Project へ移る**——移るのは軽く、戻れる操作（作る・閉じるとは違う）。
//   その代わり、**どの面の画面からでも、人がその画面を押した直後だけ**受ける（既存の2つは確かめの画面が人の目を通すので
//   入口・設定の面からは直後でなくても受けるが、ここは確かめが無いので、押したことが確かめの代わり）
// - **閉じた Project・無い Project は断る**——黙って再開しない（再開は Module の起動を伴う。core の画面でも「閉じたものの
//   一覧」で人が押したときだけ）
// - core は頼んできた Module を名指ししない

export const OPEN_PROJECT_METHOD = "dev.banto/open-project";

/** 画面から来た params を読む。読めなければ理由 */
export function parseOpenProjectParams(params: unknown): { projectId: string } | { error: string } {
  const id = (params as { projectId?: unknown } | undefined)?.projectId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { error: "projectId は Project の id で渡してください" };
  return { projectId: id };
}

/** 開いてよいか。だめなら理由（画面にそのまま返す） */
export function decideOpenProject(input: {
  projectId: string;
  /** 人がその画面を押した直後か */
  activated: boolean;
  projects: ReadonlyArray<{ id: string; name: string; status: string }>;
}): { ok: true } | { error: string } {
  if (!input.activated) return { error: "Project を開くのは、人が画面を押した直後だけです" };
  const project = input.projects.find((p) => p.id === input.projectId);
  if (!project) return { error: "その Project はありません（消えたか、まだ読み込んでいません）" };
  if (project.status === "closed") return { error: `「${project.name}」は閉じた Project です——閉じたものの一覧から再開してから開いてください` };
  return { ok: true };
}
