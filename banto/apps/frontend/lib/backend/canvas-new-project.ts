// **Canvas から「新しい Project の画面を、このフォルダで開いて」と頼む口**（banto の拡張、2026-10-02、
// `docs/specs/v4-modules.md` §2.4「core との境目」・`docs/specs/v4-frontend.md` §6.2）。
//
// MCP Apps には、画面が host の中の別の画面を開かせる口が無い（`ui/open-link` は http/https を別タブで開くだけ）。
// Repositories の「Project も作る」（clone・新しいリポジトリのあと）と「Project を始める」が要るので、最小の形で足す：
//
// - 画面 → banto：request `dev.banto/open-new-project`（`params.folder`・`params.name?`）
// - banto：core の新しい Project の画面を、Root パスと名前を入れた状態で開くだけ。**Project は作らない**——作るのは
//   人がその画面で「作る」を押したとき（core に「Project を作る」口を足さない、§2.4）
// - **どの Module からでも同じ**——core は頼んできた Module を名指ししない。人の操作の直後でなくても開く
//   （clone は何分もかかり、終わったときには押した瞬間は過ぎている）。開くのは確かめる画面なので、勝手には何も起きない
//
// 開くのは banto の外枠（`RequestedNewProjectDialog`）。ここは頼みを受け渡す小さな置き場だけ。

export const OPEN_NEW_PROJECT_METHOD = "dev.banto/open-new-project";

export interface NewProjectRequest {
  /** 頼まれた順の番号（同じ中身でも、頼まれるたびに開き直す） */
  seq: number;
  basePath: string;
  name?: string;
}

let current: NewProjectRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/** 画面から来た params を読む。読めなければ理由を返す（画面にそのまま返す） */
export function parseNewProjectParams(params: unknown): { basePath: string; name?: string } | { error: string } {
  const p = params as { folder?: unknown; name?: unknown } | undefined;
  if (typeof p?.folder !== "string" || p.folder.trim() === "") return { error: "folder が要ります" };
  const folder = p.folder.trim();
  if (!folder.startsWith("/") && !folder.startsWith("~/")) return { error: "folder は / か ~/ から始まるパスで渡してください" };
  if (folder.length > 4096) return { error: "folder が長すぎます" };
  if (p.name !== undefined && (typeof p.name !== "string" || p.name.length > 200)) return { error: "name は 200 字までの文字列で渡してください" };
  return { basePath: folder, ...(typeof p.name === "string" && p.name.trim() ? { name: p.name.trim() } : {}) };
}

export function requestNewProject(input: { basePath: string; name?: string }): void {
  seq += 1;
  current = { seq, ...input };
  for (const l of listeners) l();
}

export function clearNewProjectRequest(): void {
  current = null;
  for (const l of listeners) l();
}

export function subscribeNewProjectRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNewProjectRequest(): NewProjectRequest | null {
  return current;
}
