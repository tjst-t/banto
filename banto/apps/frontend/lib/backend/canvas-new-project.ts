// **Canvas から「新しい Project の画面を、このフォルダで開いて」と頼む口**（banto の拡張、2026-10-02、
// `docs/specs/v4-modules.md` §2.4「core との境目」・`docs/specs/v4-frontend.md` §6.2）。
//
// MCP Apps には、画面が host の中の別の画面を開かせる口が無い（`ui/open-link` は http/https を別タブで開くだけ）。
// Repositories の「Project も作る」（clone・新しいリポジトリのあと）と「Project を始める」が要るので、最小の形で足す：
//
// - 画面 → banto：request `dev.banto/open-new-project`（`params.folder`・`params.name?`）
// - banto：core の新しい Project の画面を、Root パスと名前を入れた状態で開くだけ。**Project は作らない**——作るのは
//   人がその画面で「作る」を押したとき（core に「Project を作る」口を足さない、§2.4）
// - **どの Module からでも同じ**——core は頼んできた Module を名指ししない。ただし**どの Module の画面から頼まれたかは
//   開いた画面に出す**（出所を見せる——知らない Module が勝手に開いたなら、人がそれと分かる）
// - **人の操作の直後でなくても開く**（clone は何分もかかり、終わったときには押した瞬間は過ぎている）——**入口・設定の面
//   から**の頼みだけ。**会話の中の画面**（AI の tool の結果として出たもの）からは、人がその画面を押した直後
//   （一時的な利用者の操作）でなければ受けない——AI のターンの画面が、人の見ていないところで開かせない
// - **開いている間の頼みは受けない**——人が打ちかけた入力を捨てて開き直さない
// - 開く場所（外枠）が無い面（別タブの Canvas）では断る——「開いた」と言って何も出ないことにしない
//
// 開くのは banto の外枠（`RequestedNewProjectDialog`）。ここは頼みを受け渡す小さな置き場だけ。

export const OPEN_NEW_PROJECT_METHOD = "dev.banto/open-new-project";

export interface NewProjectRequest {
  /** 頼まれた順の番号（同じ中身でも、頼まれるたびに開き直す） */
  seq: number;
  basePath: string;
  name?: string;
  /** どの Module の画面から頼まれたか（開いた画面に出す） */
  from?: string;
}

let current: NewProjectRequest | null = null;
let seq = 0;
/** 開く場所（`RequestedNewProjectDialog`）がいくつ出ているか */
let hosts = 0;
const listeners = new Set<() => void>();

/** 頼みを受けてよいか。だめなら理由（画面にそのまま返す） */
export function decideNewProjectRequest(input: {
  /** 会話の中の画面（AI の tool の結果として出たもの）からか */
  fromConversation: boolean;
  /** 人がその画面を押した直後か */
  activated: boolean;
}): { ok: true } | { error: string } {
  if (hosts === 0) return { error: "この画面からは新しい Project の画面を開けません（banto の画面で開いてください）" };
  if (current) return { error: "新しい Project の画面は、もう開いています" };
  if (input.fromConversation && !input.activated) {
    return { error: "会話の中の画面からは、人が押した直後にだけ開けます" };
  }
  return { ok: true };
}

/** 開く場所が出たこと・消えたことを知らせる（外枠の `RequestedNewProjectDialog`） */
export function registerNewProjectHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
  };
}

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

export function requestNewProject(input: { basePath: string; name?: string; from?: string }): void {
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
