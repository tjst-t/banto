// **PDF・Office の画面で付けたコメントの置き場**（v4-modules.md §2.2「PDF・Office のファイルを読んでコメントを返す」、
// Backlog #307、2026-10-15）。
//
// 画面向けの `getComments`／`saveComments`（`admin`）が読み書きする。置き場は **Project ごとの Module の置き場**
// （host が渡す `BANTO_MODULE_DATA_DIR`——Project ごとの Module は Project ごとに別のフォルダ）で、鍵はファイルの
// 根からの相対パス。**Project の中には書かない**（人のリポジトリを汚さない、`settings.ts` と同じ）。
// 「見ている場所」（URL の `canvasView`、2000 字まで）には載せない——引用を付けたコメントはすぐ超え、会話の中のカード
// からも同じものを見たいため。
//
// 各コメントは**付けたときのファイルの中身のハッシュ**（sha256）を持つ。画面はいまのハッシュと比べて
// 「ファイルが変わりました」と出す。ハッシュは host（ここ）が付ける——画面が持ってきた値を信じない

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 1つのファイルに付けられるコメントの数・1つのコメントの長さ（引用を含む）。置き場を膨らませない */
export const MAX_COMMENTS_PER_FILE = 200;
export const MAX_COMMENT_CHARS = 4000;
const MAX_QUOTE_CHARS = 2000;

/** 範囲（ページ・図の中の囲み）。ページに対する割合（0〜1）で覚える——倍率が変わっても同じ場所を指す */
export interface CommentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * **何を指しているか**。PDF（と PDF にしたもの）はページ・選んだ文・ドラッグした範囲、docx-preview は選んだ文と
 * その上の見出し、表はセル・範囲（`シート名!B4:D6`）とそこの値
 */
export type CommentAnchor =
  | { kind: "page"; page: number }
  | { kind: "text"; quote: string; page?: number; heading?: string }
  | { kind: "region"; page: number; rect: CommentRect }
  | { kind: "cell"; sheet: string; range: string; value?: string };

export interface DocumentComment {
  id: string;
  anchor: CommentAnchor;
  body: string;
  /** 付けたときのファイルの中身の sha256（hex） */
  fileHash: string;
  createdAt: string;
  updatedAt?: string;
}

interface CommentFile {
  version: 1;
  files: Record<string, DocumentComment[]>;
}

function storePath(): string | undefined {
  const dir = process.env.BANTO_MODULE_DATA_DIR;
  return dir ? join(dir, "comments.json") : undefined;
}

async function readStore(): Promise<CommentFile> {
  const path = storePath();
  if (!path) return { version: 1, files: {} };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, files: {} };
    throw err;
  }
  // **壊れていたら止まる**（規則2）——既定に落ちて空で上書きすると、人の付けたコメントが消える
  const parsed = JSON.parse(raw) as Partial<CommentFile>;
  if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null) {
    throw new Error(`コメントの置き場の形が読めません（${path}）`);
  }
  return { version: 1, files: parsed.files };
}

async function writeStore(store: CommentFile): Promise<void> {
  const path = storePath();
  // 置き場が渡されていないなら、**残せたふりをしない**（規則2）
  if (!path) throw new Error("コメントの置き場が渡されていません（BANTO_MODULE_DATA_DIR）");
  await mkdir(dirname(path), { recursive: true });
  // 書きかけで落ちても前のものが残るように、別の名前に書いてから置き換える
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await rename(tmp, path);
}

/** ファイルの中身の sha256（大きな PDF もあるので流して数える） */
export async function fileHash(absPath: string): Promise<string> {
  const s = await stat(absPath);
  if (!s.isFile()) throw new Error("ファイルではありません");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function fail(message: string): never {
  throw new Error(`コメントの形が正しくありません：${message}`);
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${what} は 1 以上の整数です`);
  return value;
}

function shortText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.length === 0) fail(`${what} が空です`);
  if (value.length > max) fail(`${what} は ${max} 字までです`);
  return value;
}

function ratio(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(`${what} は 0〜1 の割合です`);
  return value;
}

export function parseAnchor(raw: unknown): CommentAnchor {
  if (typeof raw !== "object" || raw === null) fail("anchor がありません");
  const a = raw as Record<string, unknown>;
  switch (a.kind) {
    case "page":
      return { kind: "page", page: positiveInt(a.page, "page") };
    case "text":
      return {
        kind: "text",
        quote: shortText(a.quote, "quote", MAX_QUOTE_CHARS),
        ...(a.page !== undefined ? { page: positiveInt(a.page, "page") } : {}),
        ...(a.heading !== undefined ? { heading: shortText(a.heading, "heading", 500) } : {}),
      };
    case "region": {
      const r = (a.rect ?? {}) as Record<string, unknown>;
      const rect = { x: ratio(r.x, "rect.x"), y: ratio(r.y, "rect.y"), w: ratio(r.w, "rect.w"), h: ratio(r.h, "rect.h") };
      if (rect.w === 0 || rect.h === 0) fail("rect の幅と高さが 0 です");
      return { kind: "region", page: positiveInt(a.page, "page"), rect };
    }
    case "cell":
      return {
        kind: "cell",
        sheet: shortText(a.sheet, "sheet", 200),
        range: shortText(a.range, "range", 100),
        ...(a.value !== undefined ? { value: typeof a.value === "string" && a.value.length <= MAX_QUOTE_CHARS ? a.value : fail("value は 2000 字までの文字です") } : {}),
      };
    default:
      fail(`anchor.kind が分かりません（${String(a.kind)}）`);
  }
}

/**
 * 画面から来た一覧を確かめて、置ける形にする。**ハッシュ・時刻・id は host が付ける**：新しいもの（`fileHash` が無い）は
 * いまのハッシュ、前からあるもの（同じ id）は前に覚えたハッシュと付けた時刻をそのまま——画面が書き換えても受けない
 */
export function normalizeComments(
  raw: unknown,
  previous: readonly DocumentComment[],
  currentHash: string,
  now: string,
): DocumentComment[] {
  if (!Array.isArray(raw)) fail("comments は配列です");
  if (raw.length > MAX_COMMENTS_PER_FILE) fail(`1つのファイルに付けられるのは ${MAX_COMMENTS_PER_FILE} 件までです`);
  const before = new Map(previous.map((c) => [c.id, c]));
  const seen = new Set<string>();
  return raw.map((item: unknown) => {
    if (typeof item !== "object" || item === null) fail("コメントがオブジェクトではありません");
    const c = item as Record<string, unknown>;
    const body = shortText(c.body, "body", MAX_COMMENT_CHARS);
    const anchor = parseAnchor(c.anchor);
    const old = typeof c.id === "string" ? before.get(c.id) : undefined;
    const id = old?.id ?? randomUUID();
    if (seen.has(id)) fail(`同じ id のコメントが2つあります（${id}）`);
    seen.add(id);
    if (!old) return { id, anchor, body, fileHash: currentHash, createdAt: now };
    const changed = old.body !== body || JSON.stringify(old.anchor) !== JSON.stringify(anchor);
    return {
      id,
      anchor,
      body,
      fileHash: old.fileHash,
      createdAt: old.createdAt,
      ...(changed ? { updatedAt: now } : old.updatedAt ? { updatedAt: old.updatedAt } : {}),
    };
  });
}

/** そのファイルのコメントと、いまのファイルのハッシュ */
export async function getComments(relPath: string, absPath: string): Promise<{ comments: DocumentComment[]; hash: string }> {
  const [store, hash] = await Promise.all([readStore(), fileHash(absPath)]);
  return { comments: store.files[relPath] ?? [], hash };
}

// 書き込みは順に流す（2つの画面が同時に保存しても、片方の書き込みで他のファイルのコメントを消さない）
let chain: Promise<unknown> = Promise.resolve();

/** そのファイルのコメントを、渡した一覧で置き換える（空なら消す） */
export function saveComments(
  relPath: string,
  absPath: string,
  raw: unknown,
  now = new Date().toISOString(),
): Promise<{ comments: DocumentComment[]; hash: string }> {
  const run = chain.then(async () => {
    const [store, hash] = await Promise.all([readStore(), fileHash(absPath)]);
    const comments = normalizeComments(raw, store.files[relPath] ?? [], hash, now);
    if (comments.length === 0) delete store.files[relPath];
    else store.files[relPath] = comments;
    await writeStore(store);
    return { comments, hash };
  });
  chain = run.catch(() => undefined);
  return run;
}
