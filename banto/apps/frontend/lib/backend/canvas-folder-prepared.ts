// **Module の画面が「このフォルダを用意した」と返す口**（banto の拡張、2026-10-03、`docs/specs/v4-frontend.md` §6.2、
// `docs/specs/v4-modules.md` §2.4「core との境目」）。
//
// core の新しい Project の画面に、Module が「フォルダを用意できる」と名乗って差し出した画面（資源の
// `_meta["dev.banto/canvas"] = "folder-provider"`）が、用意できたら request `dev.banto/folder-prepared` を送る：
// `{ path, suggestedName?, summary }`。core はそれを Root の候補にし、下の段（Project 名・Advanced）を出す。
// **Project を作るのは core**（人がそこで押したとき）。そのフォルダをもう Project が使っているかも core が自分で調べる。
// 受けるのは、新しい Project の画面の枠の中に出した画面だけ（ほかの面からは断る）。

export const FOLDER_PREPARED_METHOD = "dev.banto/folder-prepared";

export interface PreparedFolder {
  path: string;
  suggestedName?: string;
  summary: string;
}

export function parseFolderPrepared(params: unknown): PreparedFolder | { error: string } {
  const p = params as { path?: unknown; suggestedName?: unknown; summary?: unknown } | undefined;
  if (typeof p?.path !== "string" || !p.path.startsWith("/") || p.path.length > 4096) return { error: "path は / から始まるパスで渡してください" };
  if (typeof p.summary !== "string" || p.summary.trim() === "" || p.summary.length > 500) return { error: "summary は 500 字までの1行で渡してください" };
  if (p.suggestedName !== undefined && (typeof p.suggestedName !== "string" || p.suggestedName.length > 200)) {
    return { error: "suggestedName は 200 字までの文字列で渡してください" };
  }
  return {
    path: p.path,
    summary: p.summary.trim(),
    ...(typeof p.suggestedName === "string" && p.suggestedName.trim() ? { suggestedName: p.suggestedName.trim() } : {}),
  };
}
