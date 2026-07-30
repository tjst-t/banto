/**
 * ファイル／ディレクトリ閲覧Tool（ADR-0010 決定18・決定24）。
 *
 * 基本GUIセットの「ファイル／ディレクトリ表示」のデータ側。Kobo にも Worker Pool にも
 * 依存せず、ローカルのファイルだけで動く——Kobo が無くても価値のある汎用の道具（決定24）。
 *
 * **閲覧専用**。書き込み・削除は持たない。番頭はファイルを変更せず職人へ委譲する（D10）。
 *
 * 各Toolは `content`（番頭・LLM向けのテキスト）と `details`（UI向けの構造化データ）の
 * 両方を返す。ロジックは1箇所にあり、その上に口が2つ出る形（D5・決定25）。
 *
 * D6: node:fs / node:path のみ。
 * I2: 範囲外・不在・バイナリは黙って空を返さずエラーまたは明示的な断りを返す。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";
import { resolveInWorkspace, toWorkspaceRelative } from "./workspace.js";

/** 一覧の上限。番頭の文脈を埋め尽くさないため。 */
const MAX_ENTRIES = 200;
/** 読み取りの上限（行）。超える分は切り、切ったことを明示する。 */
const MAX_LINES = 400;
/** 読み取りの上限（バイト）。 */
const MAX_BYTES = 200_000;

/** よくある除外。番頭が見て意味のないものを既定で隠す。 */
const HIDDEN = new Set([".git", "node_modules", "dist", ".DS_Store"]);

/** 探索・検索の上限。番頭の文脈を埋め尽くさないため、また巨大なツリーで止まらないため。 */
const MAX_FIND_RESULTS = 200;
const MAX_GREP_RESULTS = 200;
/** 検索で開くファイルサイズの上限。これを超えるものは飛ばす（その旨を返す）。 */
const MAX_SEARCH_BYTES = 1_000_000;

/** NUL を含むならバイナリとみなす（テキストとして出すと文脈を壊す）。 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * glob をアンカー付きの正規表現へ変換する。
 * `**` は階層をまたぐ、`*` と `?` は階層をまたがない。`/` を含まないパターンは
 * ファイル名（basename）に対して照合する——`*.ts` が素直に効くように。
 */
function globToRegExp(pattern: string): { re: RegExp; matchBasename: boolean } {
  const matchBasename = !pattern.includes("/");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { re: new RegExp(`^${out}$`), matchBasename };
}

/**
 * ルート配下のファイルを走査する。`HIDDEN`（.git / node_modules / dist 等）と
 * ドット始まりは既定で降りない——番頭の文脈を無駄に埋めないため。
 *
 * @param visit false を返すと走査を打ち切る（上限に達したとき）
 */
function walkFiles(
  root: string,
  startRelative: string,
  includeHidden: boolean,
  visit: (relativePath: string, absolutePath: string) => boolean
): void {
  const stack: string[] = [startRelative];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    const absolute = path.join(root, relative === "." ? "" : relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      // 読めないディレクトリは飛ばす（権限等）。走査全体を止めない
      continue;
    }
    for (const entry of entries) {
      if (!includeHidden && (entry.name.startsWith(".") || HIDDEN.has(entry.name))) continue;
      const childRelative = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(childRelative);
      } else if (entry.isFile()) {
        if (!visit(childRelative, path.join(absolute, entry.name))) return;
      }
    }
  }
}

export function createFileTools(root: string): NamespacedToolDefinition[] {
  const list = defineNamespacedTool({
    name: "file.list",
    label: "File: List",
    description:
      "ワークスペース内のディレクトリの中身を一覧する。閲覧専用で、変更はできない。" +
      "何がどこにあるか把握したいときに使う。",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "ワークスペースからの相対パス。省略時はルート" })
      ),
      includeHidden: Type.Optional(
        Type.Boolean({ description: "ドット始まりや node_modules 等も含める（既定 false）" })
      ),
    }),
    async execute(_toolCallId, params) {
      const target = resolveInWorkspace(root, params.path ?? ".");
      // I2: 存在しない・ディレクトリでない場合は黙って空一覧を返さずエラーにする
      if (!fs.existsSync(target)) {
        throw new Error(`No such path: ${params.path ?? "."}`);
      }
      if (!fs.statSync(target).isDirectory()) {
        throw new Error(`Not a directory: ${params.path ?? "."} (use file.read for files)`);
      }

      const all = fs.readdirSync(target, { withFileTypes: true });
      const visible = params.includeHidden
        ? all
        : all.filter((e) => !e.name.startsWith(".") && !HIDDEN.has(e.name));
      const sorted = visible.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const shown = sorted.slice(0, MAX_ENTRIES);
      const lines = shown.map((entry) => {
        if (entry.isDirectory()) return `d ${entry.name}/`;
        const size = fs.statSync(path.join(target, entry.name)).size;
        return `f ${entry.name} (${size} bytes)`;
      });
      if (sorted.length > shown.length) {
        lines.push(`… 他 ${sorted.length - shown.length} 件（上限 ${MAX_ENTRIES}）`);
      }

      const header = `${toWorkspaceRelative(root, target)} — ${sorted.length} 件`;
      const text = lines.length === 0 ? `${header}\n(空)` : `${header}\n${lines.join("\n")}`;

      // details は UI 向けの構造化データ（決定25：人はモジュールのデータAPIから取る）
      const details = {
        path: toWorkspaceRelative(root, target),
        total: sorted.length,
        truncated: sorted.length > shown.length,
        entries: shown.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ("dir" as const) : ("file" as const),
          size: entry.isDirectory() ? undefined : fs.statSync(path.join(target, entry.name)).size,
        })),
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });

  const read = defineNamespacedTool({
    name: "file.read",
    label: "File: Read",
    description:
      "ワークスペース内のファイルを読む。閲覧専用で、書き込みはできない。" +
      "長いファイルは先頭から一定行で打ち切られ、その旨が示される。",
    parameters: Type.Object({
      path: Type.String({ description: "ワークスペースからの相対パス" }),
      maxLines: Type.Optional(
        Type.Number({ description: `読む行数の上限（既定 ${MAX_LINES}）` })
      ),
    }),
    async execute(_toolCallId, params) {
      const target = resolveInWorkspace(root, params.path);
      if (!fs.existsSync(target)) {
        throw new Error(`No such file: ${params.path}`);
      }
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        throw new Error(`${params.path} is a directory (use file.list)`);
      }

      const buffer = fs.readFileSync(target);
      // I2: バイナリを文字列化して渡すと文脈が壊れる。読めないことを明示して返す
      if (looksBinary(buffer)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${params.path} はバイナリのため表示できません（${stat.size} bytes）`,
            },
          ],
          details: { path: params.path, binary: true, size: stat.size },
        };
      }

      const truncatedBytes = buffer.length > MAX_BYTES;
      const source = truncatedBytes ? buffer.subarray(0, MAX_BYTES) : buffer;
      const allLines = source.toString("utf-8").split("\n");
      const limit = Math.max(1, params.maxLines ?? MAX_LINES);
      const shown = allLines.slice(0, limit);

      const notes: string[] = [];
      if (allLines.length > shown.length) {
        notes.push(`… 以降 ${allLines.length - shown.length} 行を省略（上限 ${limit} 行）`);
      } else if (truncatedBytes) {
        notes.push(`… サイズ上限 ${MAX_BYTES} bytes で打ち切り`);
      }

      const text = [shown.join("\n"), ...notes].join("\n");
      const details = {
        path: params.path,
        binary: false,
        size: stat.size,
        content: shown.join("\n"),
        totalLines: allLines.length,
        shownLines: shown.length,
        truncated: notes.length > 0,
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });

  const stat = defineNamespacedTool({
    name: "file.stat",
    label: "File: Stat",
    description:
      "パスが存在するか、ファイルかディレクトリか、サイズを返す。" +
      "file.list（ディレクトリ用）と file.read（ファイル用）のどちらを使うか決めるときに引く。",
    parameters: Type.Object({
      path: Type.String({ description: "ワークスペースからの相対パス" }),
    }),
    async execute(_toolCallId, params) {
      const target = resolveInWorkspace(root, params.path);
      if (!fs.existsSync(target)) {
        throw new Error(`No such path: ${params.path}`);
      }
      const info = fs.statSync(target);
      const type = info.isDirectory() ? ("dir" as const) : ("file" as const);
      const relative = toWorkspaceRelative(root, target);
      return {
        content: [
          { type: "text" as const, text: `${relative}: ${type}${type === "file" ? ` (${info.size} bytes)` : ""}` },
        ],
        details: { path: relative, type, size: info.size },
      };
    },
  });

  const find = defineNamespacedTool({
    name: "file.find",
    label: "File: Find",
    description:
      "ファイル名のパターンでファイルを探す。glob が使える（`*.ts` / `**/canvas*` 等）。" +
      "`/` を含まないパターンはファイル名だけに照合する。閲覧専用で、どこに何があるか探すときに使う。",
    parameters: Type.Object({
      pattern: Type.String({ description: "ファイル名のglob（例: *.ts, **/git-*.ts, README*）" }),
      path: Type.Optional(Type.String({ description: "探索を始めるディレクトリ（省略時はルート）" })),
      includeHidden: Type.Optional(
        Type.Boolean({ description: "ドット始まりや node_modules 等も探す（既定 false）" })
      ),
      limit: Type.Optional(Type.Number({ description: `件数の上限（既定 ${MAX_FIND_RESULTS}）` })),
    }),
    async execute(_toolCallId, params) {
      const start = params.path ?? ".";
      resolveInWorkspace(root, start);
      const limit = Math.max(1, Math.min(params.limit ?? MAX_FIND_RESULTS, MAX_FIND_RESULTS));
      const { re, matchBasename } = globToRegExp(params.pattern);

      const matches: Array<{ path: string; size: number }> = [];
      let truncated = false;
      walkFiles(root, start, params.includeHidden === true, (relative, absolute) => {
        const subject = matchBasename ? path.basename(relative) : relative;
        if (!re.test(subject)) return true;
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
        matches.push({ path: relative, size: fs.statSync(absolute).size });
        return true;
      });

      const lines = matches.map((m) => `${m.path} (${m.size} bytes)`);
      if (truncated) lines.push(`… 上限 ${limit} 件で打ち切り`);
      const text = matches.length === 0 ? `"${params.pattern}" に一致するファイルなし` : lines.join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { pattern: params.pattern, matches, truncated },
      };
    },
  });

  const grep = defineNamespacedTool({
    name: "file.grep",
    label: "File: Grep",
    description:
      "ファイルの中身を正規表現で検索し、一致した行を行番号つきで返す。" +
      "`glob` でファイルを絞れる。見つけた箇所は file.browser の line 引数でそのまま開ける。" +
      "閲覧専用で、どこに何が書かれているか探すときに使う。",
    parameters: Type.Object({
      pattern: Type.String({ description: "検索する正規表現（例: createModuleRegistry, TODO|FIXME）" }),
      path: Type.Optional(Type.String({ description: "探索を始めるディレクトリ（省略時はルート）" })),
      glob: Type.Optional(Type.String({ description: "対象ファイルを絞るglob（例: *.ts）" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "大文字小文字を区別しない" })),
      includeHidden: Type.Optional(
        Type.Boolean({ description: "ドット始まりや node_modules 等も探す（既定 false）" })
      ),
      limit: Type.Optional(Type.Number({ description: `一致行の上限（既定 ${MAX_GREP_RESULTS}）` })),
    }),
    async execute(_toolCallId, params) {
      const start = params.path ?? ".";
      resolveInWorkspace(root, start);
      const limit = Math.max(1, Math.min(params.limit ?? MAX_GREP_RESULTS, MAX_GREP_RESULTS));

      // I2: 壊れた正規表現は黙って0件にせず、理由を返す
      let re: RegExp;
      try {
        re = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
      } catch (err) {
        throw new Error(`Invalid regular expression "${params.pattern}": ${String(err)}`);
      }
      const fileFilter = params.glob ? globToRegExp(params.glob) : undefined;

      const hits: Array<{ path: string; line: number; text: string }> = [];
      let truncated = false;
      let skippedLarge = 0;

      walkFiles(root, start, params.includeHidden === true, (relative, absolute) => {
        if (fileFilter) {
          const subject = fileFilter.matchBasename ? path.basename(relative) : relative;
          if (!fileFilter.re.test(subject)) return true;
        }
        const size = fs.statSync(absolute).size;
        if (size > MAX_SEARCH_BYTES) {
          skippedLarge++;
          return true;
        }
        const buffer = fs.readFileSync(absolute);
        if (looksBinary(buffer)) return true;

        const lines = buffer.toString("utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue;
          if (hits.length >= limit) {
            truncated = true;
            return false;
          }
          // 長すぎる行はそのまま返すと文脈を食うので切る
          const raw = lines[i]!;
          hits.push({ path: relative, line: i + 1, text: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw });
        }
        return true;
      });

      const notes: string[] = [];
      if (truncated) notes.push(`… 上限 ${limit} 件で打ち切り`);
      // I2: 飛ばしたファイルがあることを黙って隠さない
      if (skippedLarge > 0) notes.push(`（${skippedLarge} 件は ${MAX_SEARCH_BYTES} bytes 超のため未検索）`);

      const text =
        hits.length === 0
          ? [`"${params.pattern}" に一致する行なし`, ...notes].join("\n")
          : [...hits.map((h) => `${h.path}:${h.line}: ${h.text.trim()}`), ...notes].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { pattern: params.pattern, hits, truncated, skippedLarge },
      };
    },
  });

  return [list, read, stat, find, grep];
}
