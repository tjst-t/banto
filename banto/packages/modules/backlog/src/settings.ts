// Backlog Module 自身の設定——一覧を置くブランチの名前（§4.4「設定」。既定 `backlog`、中のファイルは tasks.json 固定）と、
// 送るときに借りる SSH 鍵（§4.4「Vault の SSH 鍵で送る」。Vault の ssh-identity の alias 名だけ——鍵は置かない。既定は使わない）。
// それと、**一覧をどこに置くか**（§4.4「Gist の置き場」、Backlog #535）——既定はリポジトリの一覧のブランチ（tasks.json）、
// 選べば GitHub Gist（非公開）。Gist の id と、Gist に書くトークンの Vault の alias 名（値は置かない）。Gist を選んでも
// ブランチ名・SSH 鍵の設定は残す（戻したときにそのまま使う）。
//
// 置き場は FileSystem と同じく **host が必ず渡す** `BANTO_MODULE_DATA_DIR`。Project ごとの Module は
// 接続名が Project ごとに分かれ、置き場も Project ごとになる——**設定は Project ごと**。
// **Project の中には書かない**（設定の写しを人のリポジトリに置かない）。
//
// 以前の設定（`path`——作業ツリーの tasks.json の場所、2026-10-04 まで）は読まない。残っていても既定のブランチになる。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BacklogError } from "./model.js";
import { checkGistId } from "./gist.js";

export const DEFAULT_BRANCH = "backlog";

/** 一覧の置き場——`tasks-json`（リポジトリの一覧のブランチ）・`gist`（GitHub Gist、非公開） */
export const BACKENDS = ["tasks-json", "gist"] as const;
export type BacklogBackendKind = (typeof BACKENDS)[number];

export interface BacklogSettings {
  /** 一覧の置き場。既定は tasks-json */
  backend: BacklogBackendKind;
  /** 一覧を置くブランチ（`refs/heads/` の下の名前） */
  branch: string;
  /** 自分の git で送る・取ってくるときに Vault から借りる SSH 鍵の alias 名。無ければ使わない */
  sshIdentity?: string;
  /** Gist の id（`backend: gist` のとき要る） */
  gistId?: string;
  /** Gist に書くトークンの Vault の alias 名（`backend: gist` のとき要る） */
  gistToken?: string;
}

const DEFAULTS: BacklogSettings = { backend: "tasks-json", branch: DEFAULT_BRANCH };

function settingsPath(): string | undefined {
  const dir = process.env.BANTO_MODULE_DATA_DIR;
  return dir ? join(dir, "settings.json") : undefined;
}

/**
 * ブランチ名として受け付けるか。git の決まり（`check-ref-format`）のうち、ここで要るものを見る——コマンドの引数と
 * refspec に入れるので、`-` で始まるもの・記号（`:` `+` `*` `~` `^` `?` `[` 空白など）・`..`・`@{`・`.lock` で終わるもの等は断る
 */
export function checkBranch(raw: string): string {
  const name = raw.trim().replace(/^refs\/heads\//, "");
  if (name === "") throw new BacklogError("ブランチ名が空です");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)) {
    throw new BacklogError("ブランチ名に使えるのは英数字と . _ / - です（英数字で始める）");
  }
  if (name.includes("..") || name.includes("//") || name.includes("/.") || name.includes("@{")) {
    throw new BacklogError("ブランチ名に .. ・ // ・ /. は使えません");
  }
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) throw new BacklogError("ブランチ名を / ・ . ・ .lock で終えられません");
  return name;
}

/** alias 名として受け付けるか（中身は Vault が見る。ここでは空・改行・長すぎるものを断る）。空なら「使わない」 */
export function checkSshIdentity(raw: string): string | undefined {
  const name = raw.trim();
  if (name === "") return undefined;
  if (name.length > 200 || /[\s\u0000-\u001f]/.test(name)) throw new BacklogError("SSH 鍵の名前に空白・改行は使えません（200 文字まで）");
  return name;
}

/** alias 名として受け付けるか（Gist のトークン）。空なら無し */
export function checkGistToken(raw: string): string | undefined {
  const name = raw.trim();
  if (name === "") return undefined;
  if (name.length > 200 || /[\s\u0000-\u001f]/.test(name)) throw new BacklogError("トークンの名前に空白・改行は使えません（200 文字まで）");
  return name;
}

/** 揃っているかを見て、書く形にする。Gist を選んだなら id とトークンが要る（片方だけの Gist を黙って使わない） */
function normalize(raw: Partial<Record<keyof BacklogSettings, unknown>>): BacklogSettings {
  const backend = raw.backend === undefined ? "tasks-json" : raw.backend;
  if (typeof backend !== "string" || !(BACKENDS as readonly string[]).includes(backend)) {
    throw new BacklogError(`一覧の置き場は ${BACKENDS.join("・")} のどれかです`);
  }
  const branch = typeof raw.branch === "string" ? checkBranch(raw.branch) : DEFAULT_BRANCH;
  const sshIdentity = typeof raw.sshIdentity === "string" ? checkSshIdentity(raw.sshIdentity) : undefined;
  const gistId = typeof raw.gistId === "string" && raw.gistId.trim() !== "" ? checkGistId(raw.gistId) : undefined;
  const gistToken = typeof raw.gistToken === "string" ? checkGistToken(raw.gistToken) : undefined;
  if (backend === "gist" && !gistId) throw new BacklogError("Gist に置くなら、Gist の id が要ります");
  if (backend === "gist" && !gistToken) throw new BacklogError("Gist に置くなら、Gist に書くトークン（Vault の名前）が要ります");
  return {
    backend: backend as BacklogBackendKind,
    branch,
    ...(sshIdentity ? { sshIdentity } : {}),
    ...(gistId ? { gistId } : {}),
    ...(gistToken ? { gistToken } : {}),
  };
}

export function readSettings(): BacklogSettings {
  const path = settingsPath();
  if (!path) return DEFAULTS;
  let raw: Partial<Record<keyof BacklogSettings, unknown>>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof BacklogSettings, unknown>>;
  } catch (err) {
    // まだ書かれていない——既定。**壊れているのは既定に落とさない**（違うブランチを黙って読み書きしない、規則2）
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS;
    throw new BacklogError(`Backlog の設定を読めません（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
  // 前の形（backend が無い）は tasks-json として読む
  return normalize(raw);
}

export function writeSettings(next: BacklogSettings): BacklogSettings {
  const path = settingsPath();
  // 置き場が渡されていないなら、**保存できたふりをしない**（規則2）
  if (!path) throw new BacklogError("設定の置き場が渡されていません（BANTO_MODULE_DATA_DIR）");
  const saved = normalize(next);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return saved;
}
