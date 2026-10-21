// **今あるフォルダをリポジトリにする画面と話す口**（banto の拡張、2026-10-21、Backlog #502、
// v4-architecture.md §2.2「チャット」の「Project にする」・v4-modules.md §2.4「core との境目」）。
//
// 「Project にする」の画面は、Module が名乗った画面（資源の `_meta["dev.banto/canvas"] = "folder-adopter"`）を
// リポジトリの欄に枠ごと出す。core は Repositories を名指ししない——やりとりは3つだけ：
//
// - **どのフォルダか**：hostContext の `dev.banto/folder-adopter` = `{ path, name }`（`name` はリポジトリの名前の案。
//   人が打ち替えたら渡し直す）。`dev.banto/project` と同じく、仕様が認める追加の項目
// - **押せるか**：画面 → host の notification `dev.banto/folder-adopter-state` = `{ ready, choice, reason? }`。
//   `choice` は画面が人に選ばせたもの（`github`・`local`・`none`）——host は言い方にだけ使う
// - **押したとき**：host → 画面の request `dev.banto/adopt-folder` = `{ path, name }`（フォルダを置き場へ移したあとの場所）。
//   画面がリポジトリにし（GitHub に上げるなら上げ終わるまで）、`{ choice, summary, path?, github? }` を返す。
//   失敗は JSON-RPC の error で、理由をそのまま人に見せる
//
// MCP Apps の標準の口はどれも会話（モデル）へ渡す意味なので使わない（`dev.banto/folder-prepared` と同じ）。

export const FOLDER_ADOPTER_CONTEXT_KEY = "dev.banto/folder-adopter";
export const FOLDER_ADOPTER_STATE_METHOD = "dev.banto/folder-adopter-state";
export const ADOPT_FOLDER_METHOD = "dev.banto/adopt-folder";
/**
 * 押してから返るまで待つ長さ。GitHub に上げるときは push を含むので、request の既定（60秒）では足りない。
 * 画面が答えない（固まった）ときだけ切れる長さにする
 */
export const ADOPT_FOLDER_TIMEOUT_MS = 15 * 60_000;

export type FolderAdopterChoice = "github" | "local" | "none";

export interface FolderAdopterTarget {
  path: string;
  name: string;
}

export interface FolderAdopterState {
  ready: boolean;
  choice: FolderAdopterChoice;
  reason?: string;
}

export interface AdoptedFolder {
  choice: FolderAdopterChoice;
  /** 1行の結果（人に見せる） */
  summary: string;
  /** リポジトリにしたフォルダ（作らないときは無い） */
  path?: string;
  /** GitHub に上げた先 */
  github?: { owner: string; name: string; htmlUrl?: string };
}

function isChoice(v: unknown): v is FolderAdopterChoice {
  return v === "github" || v === "local" || v === "none";
}

function oneLine(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : undefined;
}

/** 画面からの「押せるか」。形が違えば undefined（押せないことにする——黙って押せることにしない） */
export function parseFolderAdopterState(params: unknown): FolderAdopterState | undefined {
  const p = params as { ready?: unknown; choice?: unknown; reason?: unknown } | undefined;
  if (typeof p?.ready !== "boolean" || !isChoice(p.choice)) return undefined;
  const reason = oneLine(p.reason, 500);
  return { ready: p.ready, choice: p.choice, ...(reason ? { reason } : {}) };
}

/** 画面が返した結果。形が違えば理由を返す（「できた」と取り違えない） */
export function parseAdoptedFolder(result: unknown): AdoptedFolder | { error: string } {
  const r = result as { choice?: unknown; summary?: unknown; path?: unknown; github?: unknown } | undefined;
  if (!isChoice(r?.choice)) return { error: "リポジトリの画面の答えに choice がありません" };
  const summary = oneLine(r.summary, 500);
  if (!summary) return { error: "リポジトリの画面の答えに summary がありません" };
  if (r.choice !== "none" && (typeof r.path !== "string" || !r.path.startsWith("/"))) {
    return { error: "リポジトリの画面の答えに、リポジトリにしたフォルダ（path）がありません" };
  }
  const g = r.github as { owner?: unknown; name?: unknown; htmlUrl?: unknown } | undefined;
  if (r.choice === "github" && (typeof g?.owner !== "string" || typeof g.name !== "string")) {
    return { error: "リポジトリの画面の答えに、GitHub の場所がありません" };
  }
  return {
    choice: r.choice,
    summary,
    ...(typeof r.path === "string" && r.choice !== "none" ? { path: r.path } : {}),
    ...(r.choice === "github" && g
      ? {
          github: {
            owner: g.owner as string,
            name: g.name as string,
            ...(typeof g.htmlUrl === "string" && /^https?:\/\//.test(g.htmlUrl) ? { htmlUrl: g.htmlUrl } : {}),
          },
        }
      : {}),
  };
}
