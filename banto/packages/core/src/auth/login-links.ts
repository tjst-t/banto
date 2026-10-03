// **host のコマンドが出すログインのリンク**（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
//
// まっさらなとき・パスキーを全部なくしたときの戻り道。**host に入れる人＝持ち主**を最後の頼りにする
// ——だから札は API で作らず、**データ置き場にファイルで置く**。API で作れると、機械の合言葉（authToken）を
// 持つ者が人として入れてしまう（Fable のレビュー高1）。データ置き場は host にしか無く、コンテナからは見えない。
//
// 置くのはハッシュを名前にしたファイルだけ（中身は期限）。引き換えはファイルを消せたときだけ通す
// ——消すのは1回しか成功しないので、同時に2つ来ても片方しか入れない。

import { mkdir, readFile, unlink, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomSecret, sha256 } from "./store.js";

/** 1回だけの札の寿命（決定・2026-10-03、ユーザー） */
export const ONE_TIME_CODE_TTL_MS = 10 * 60 * 1000;

/** ログインのリンク（札はフラグメントに置く——アクセスログ・Referer に残らない）。画面と API のオリジンが違う
 *  開発・E2E では、画面に API の住所も渡す */
export function loginLinkUrl(uiOrigin: string, apiBaseUrl: string, code: string): string {
  const api = new URL(apiBaseUrl).origin;
  const host = api === uiOrigin ? "" : `?bantoHost=${encodeURIComponent(api)}`;
  return `${uiOrigin}/${host}#banto-login=${code}`;
}

export function loginLinkDir(dataDir: string): string {
  return join(dataDir, "auth", "login-links");
}

/** 札を1つ作ってファイルに置き、札そのものを返す（ファイルには残らない） */
export async function writeLoginLink(dataDir: string, now: number = Date.now()): Promise<{ code: string; expiresAt: string }> {
  const dir = loginLinkDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 使われずに切れたものを片づける（溜めない）
  for (const name of await readdir(dir)) {
    const expiresAt = await readExpiry(join(dir, name));
    if (expiresAt === undefined || expiresAt <= now) await unlink(join(dir, name)).catch(() => undefined);
  }
  const code = randomSecret();
  const expiresAt = new Date(now + ONE_TIME_CODE_TTL_MS).toISOString();
  await writeFile(join(dir, sha256(code)), JSON.stringify({ expiresAt }), { mode: 0o600, flag: "wx" });
  return { code, expiresAt };
}

async function readExpiry(path: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { expiresAt?: unknown };
    return typeof raw.expiresAt === "string" ? Date.parse(raw.expiresAt) : undefined;
  } catch {
    return undefined;
  }
}

/** 札を引き換える。**通ったら札は消える**。通らなければ false（無い・使用済み・期限切れ） */
export async function consumeLoginLink(dataDir: string, code: string, now: number = Date.now()): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return false;
  const path = join(loginLinkDir(dataDir), sha256(code));
  const expiresAt = await readExpiry(path);
  if (expiresAt === undefined) return false;
  try {
    await unlink(path);
  } catch {
    return false; // 先に誰かが使った
  }
  return expiresAt > now;
}
