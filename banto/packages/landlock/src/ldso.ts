// /etc/ld.so.conf(+.d/*.conf) を読んで動的リンカの検索パスを列挙する。
// poc/07で分かったとおり、npm等はPATH上のディレクトリだけでは動かず、
// 兄弟のlibディレクトリが要る——その一部はld.so.confに載っている。
// 標準ライブラリのみで書く（規則10、新規依存を足さない）。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `*` だけを解釈する最小限のワイルドカード一致。ld.so.conf.d/*.conf で十分。 */
function matchesSimpleGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

function expandSimpleGlob(pattern: string): string[] {
  const dir = dirname(pattern);
  const base = pattern.slice(dir.length + 1);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => matchesSimpleGlob(e, base)).map((e) => join(dir, e)).sort();
}

function parseLdSoConfFile(path: string, seen: Set<string>): string[] {
  if (seen.has(path)) return [];
  seen.add(path);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("include ")) {
      const pattern = line.slice("include ".length).trim();
      const resolvedPattern = pattern.startsWith("/") ? pattern : join(dirname(path), pattern);
      for (const matched of expandSimpleGlob(resolvedPattern)) {
        dirs.push(...parseLdSoConfFile(matched, seen));
      }
      continue;
    }

    dirs.push(resolve(line));
  }
  return dirs;
}

/** `/etc/ld.so.conf` から動的リンカの検索パス一覧を返す。読めなければ空配列。 */
export function listLdSoConfPaths(rootConfPath = "/etc/ld.so.conf"): string[] {
  const dirs = parseLdSoConfFile(rootConfPath, new Set());
  return Array.from(new Set(dirs));
}
