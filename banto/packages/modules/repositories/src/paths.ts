// パスの読み方と見せ方。**画面は打たれた字をそのまま渡してくる**（`~/…` も相対も）——ここで1回だけ直す。

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** `~` を展開し、絶対パスにする。相対は home からと読む（core の `/api/fs/directories` と同じ読み方） */
export function resolveUserPath(input: string | undefined, home: string = homedir()): string {
  const raw = (input ?? "").trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(join(home, raw.slice(2)));
  return isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
}

/** 人に見せる形（home の下は `~/…`）。保存はしない——読むたびに作る（規則3） */
export function displayPath(path: string, home: string = homedir()): string {
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~/${path.slice(home.length + 1)}` : path;
}
