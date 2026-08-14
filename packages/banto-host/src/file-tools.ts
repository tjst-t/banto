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
import {
  HIDDEN_NAMES,
  MAX_BUILTIN_SEARCH_BYTES,
  grepTree,
  listTree,
  looksBinary,
  type SearchOverrides,
} from "./file-search.js";

/**
 * 既定の件数と、頼めば返せる天井（task-0068）。
 *
 * **既定を上げないのは番頭の文脈を埋めないため**で、「それ以上は取れない」ためではない。
 * 元は既定と天井が同じ 200 で、`limit: 1000` と書いても 200 で返っていた——
 * しかも**あと何件あるかを言わなかった**ので、少なく返っていることに気づけなかった。
 */
const MAX_ENTRIES = 200;
const ENTRIES_CEILING = 5_000;
/** 読み取りの上限（行）。超える分は切り、切ったことを明示する。 */
const MAX_LINES = 400;
/** 読み取りの上限（バイト）。 */
const MAX_BYTES = 200_000;

/** よくある除外。番頭が見て意味のないものを既定で隠す。 */
const HIDDEN = new Set<string>(HIDDEN_NAMES);

/** 探索・検索の既定と天井。 */
const MAX_FIND_RESULTS = 200;
const FIND_CEILING = 5_000;
const MAX_GREP_RESULTS = 200;
const GREP_CEILING = 2_000;

/**
 * 各行の開始バイト位置を返す（1始まりの L 行目は `starts[L - 1]`）。
 *
 * **全文を文字列にしない。** `toString()` してから split すると、返さない部分まで
 * 文字列にすることになり、大きいファイルで無駄に膨らむ。改行（0x0A）は多バイト文字の
 * 途中に現れないので、バイトのまま数えて切って良い。
 */
function lineStarts(buffer: Buffer): number[] {
  const starts = [0];
  let at = buffer.indexOf(0x0a);
  while (at !== -1) {
    starts.push(at + 1);
    at = buffer.indexOf(0x0a, at + 1);
  }
  return starts;
}

/**
 * バイト位置を UTF-8 の文字境界まで戻す。
 * 継続バイト（`10xxxxxx`）の上で切ると文字が割れて壊れた字が出る。
 */
function backToCharBoundary(buffer: Buffer, at: number): number {
  let i = Math.min(at, buffer.length);
  while (i > 0 && (buffer[i]! & 0b1100_0000) === 0b1000_0000) i--;
  return i;
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
 * @param overrides 探す道具を1つに固定する（task-0068）。**試験が3経路を突き合わせる**ための口で、
 *   本番では渡さない——渡さなければ rg → grep → 自前の順で使えるものが選ばれる。
 */
export function createFileTools(
  root: string,
  overrides: SearchOverrides = {}
): NamespacedToolDefinition[] {
  const list = defineNamespacedTool({
    name: "file.list",
    label: "File: List",
    description:
      "ディレクトリの中身を一覧する（閲覧専用）。\n例: {path: \"packages/banto-host/src\"} → \"d canvas/\" \"f bin.ts (52413 bytes)\"\npath は英語のパスで埋める。",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      includeHidden: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number())
    }),
    async execute(params) {
      const target = resolveInWorkspace(root, params.path ?? ".");
      // I2: 存在しない・ディレクトリでない場合は黙って空一覧を返さずエラーにする
      if (!fs.existsSync(target)) {
        throw new Error(`No such path: ${params.path ?? "."}`);
      }
      if (!fs.statSync(target).isDirectory()) {
        throw new Error(`Not a directory: ${params.path ?? "."} (use file.read for files)`);
      }
      const limit = Math.max(1, Math.min(params.limit ?? MAX_ENTRIES, ENTRIES_CEILING));

      const all = fs.readdirSync(target, { withFileTypes: true });
      const visible = params.includeHidden
        ? all
        : all.filter((e) => !e.name.startsWith(".") && !HIDDEN.has(e.name));
      const sorted = visible.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const shown = sorted.slice(0, limit);
      const lines = shown.map((entry) => {
        if (entry.isDirectory()) return `d ${entry.name}/`;
        const size = fs.statSync(path.join(target, entry.name)).size;
        return `f ${entry.name} (${size} bytes)`;
      });
      if (sorted.length > shown.length) {
        // task-0068: **あと何件あるかを言う。** 「打ち切り」だけだと全部に見える
        lines.push(
          `… 他 ${sorted.length - shown.length} 件（${shown.length} 件だけ出した。` +
            `limit を上げれば ${ENTRIES_CEILING} 件まで取れる）`
        );
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
      "ファイルを読む（閲覧専用）。長いと打ち切られ、続きの読み方が末尾に出る。\n例: {path: \"docs/adr/adr-0019.md\"} → 1〜400行目／{offset: 401} → その続き\npath は英語のパスで埋める（ワークスペースからの相対）。",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      maxLines: Type.Optional(Type.Number())
    }),
    async execute(params) {
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

      // 行の切れ目はファイル全体から取る。**切った後の残りから数えない**——
      // そうすると総行数を過少に申告し、画面も番頭も「これで全部だ」と誤る
      const starts = lineStarts(buffer);
      const totalLines = starts.length;

      const from = Math.max(1, Math.trunc(params.offset ?? 1));
      // I2: 範囲外の offset は黙って空を返さず、全体の大きさを添えて断る
      if (from > totalLines) {
        throw new Error(`offset ${from} is past the end of ${params.path} (全 ${totalLines} 行)`);
      }
      const limit = Math.max(1, Math.trunc(params.maxLines ?? MAX_LINES));

      /** L 行目の終わり（改行を含まない、排他的なバイト位置）。 */
      const endByteOf = (line: number): number =>
        line < totalLines ? starts[line]! - 1 : buffer.length;

      const startByte = starts[from - 1]!;
      let to = Math.min(totalLines, from + limit - 1);
      // サイズ上限は「返す分」にかける。行の切れ目まで下げてから、それでも入らなければ字で切る
      let cutMidLine = false;
      while (to > from && endByteOf(to) - startByte > MAX_BYTES) to--;
      let endByte = endByteOf(to);
      if (endByte - startByte > MAX_BYTES) {
        endByte = backToCharBoundary(buffer, startByte + MAX_BYTES);
        cutMidLine = true;
      }

      const content = buffer.subarray(startByte, endByte).toString("utf-8");
      const truncated = from > 1 || to < totalLines || cutMidLine;

      // I2: 切った理由を並べる。行で切ったこととサイズで切ったことは同時に起こる——
      // どちらかだけ出すと、offset を進めれば全部読めるはずの所で読み落とす
      const notes: string[] = [];
      if (to < totalLines || cutMidLine) {
        const shownTo = cutMidLine ? `${to} 行目の途中` : `${to} 行目`;
        const rest =
          to < totalLines
            ? `以降 ${totalLines - to} 行を省略。` +
              `続きは file.read({ path: "${params.path}", offset: ${to + 1} }) で読める`
            : "";
        notes.push(`… ${from}〜${shownTo}まで（全 ${totalLines} 行）。${rest}`);
      }
      if (cutMidLine) {
        // offset は行単位なので、この行の残りへは進めない。**進めないことを言う**——
        // 「offset を上げれば続きが取れる」と誤らせない（中身を追うなら file.grep）
        notes.push(
          `（${to} 行目だけで ${MAX_BYTES} bytes を超える。この行の残りは file.read では読めない）`
        );
      } else if (to < Math.min(totalLines, from + limit - 1)) {
        notes.push(`（1回に返せるのは ${MAX_BYTES} bytes まで。maxLines より手前で打ち切った）`);
      }

      const text = [content, ...notes].join("\n");
      const details = {
        path: params.path,
        binary: false,
        size: stat.size,
        content,
        totalLines,
        from,
        to,
        shownLines: to - from + 1,
        /** 最後の行を途中で切ったか（1行がサイズ上限より大きいとき）。 */
        partialLine: cutMidLine,
        truncated,
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });

  const stat = defineNamespacedTool({
    name: "file.stat",
    label: "File: Stat",
    description:
      "パスが在るか・ファイルかディレクトリか・サイズを返す。\n例: {path: \"docs/spec\"} → \"docs/spec: dir\"／{path: \"README.md\"} → \"file (2841 bytes)\"\npath は英語で埋める。",
    parameters: Type.Object({ path: Type.String() }),
    async execute(params) {
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
      "ファイル名の glob で探す（閲覧専用）。`/` を含まないパターンはファイル名だけに照合。\n例: {pattern: \"*.spec.ts\", path: \"tests\"} → \"tests/acceptance/env-docker-run.spec.ts (5120 bytes)\"\npattern は英語で埋める（中身を探すなら file.grep）。",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      includeHidden: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number())
    }),
    async execute(params) {
      const start = params.path ?? ".";
      resolveInWorkspace(root, start);
      const limit = Math.max(1, Math.min(params.limit ?? MAX_FIND_RESULTS, FIND_CEILING));
      const { re, matchBasename } = globToRegExp(params.pattern);

      // task-0068: **数え上げは最後まで進める。** 上限で走査ごと打ち切っていたので、
      // 結果がツリーの一角に偏るうえ、あと何件あるかも言えなかった
      const { paths, engine } = await listTree(
        root,
        start,
        params.includeHidden === true,
        overrides
      );
      const matches: Array<{ path: string; size: number }> = [];
      let total = 0;
      for (const relative of paths) {
        const subject = matchBasename ? path.basename(relative) : relative;
        if (!re.test(subject)) continue;
        total++;
        if (matches.length >= limit) continue;
        try {
          matches.push({ path: relative, size: fs.statSync(path.join(root, relative)).size });
        } catch {
          // 走査中に消えたファイル。数には入っているので黙って減らさない
          matches.push({ path: relative, size: -1 });
        }
      }

      const lines = matches.map((m) => `${m.path} (${m.size < 0 ? "読めず" : `${m.size} bytes`})`);
      const truncated = total > matches.length;
      if (truncated) {
        lines.push(
          `… 全 ${total} 件のうち ${matches.length} 件だけ出した` +
            `（limit を上げれば ${FIND_CEILING} 件まで取れる）`
        );
      }
      const text =
        matches.length === 0 ? `"${params.pattern}" に一致するファイルなし` : lines.join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { pattern: params.pattern, matches, total, truncated, engine },
      };
    },
  });

  const grep = defineNamespacedTool({
    name: "file.grep",
    label: "File: Grep",
    description:
      "ファイルの中身を正規表現で検索し、一致行を `path:line: 本文` で返す（閲覧専用）。\n例: {pattern: \"PRESENTED_TOOL_NAMES\", glob: \"*.ts\"} → \"packages/banto-host/src/presented-tools.ts:31: export const …\"\npattern は英語の識別子・正規表現で埋める。",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      ignoreCase: Type.Optional(Type.Boolean()),
      includeHidden: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number())
    }),
    async execute(params) {
      const start = params.path ?? ".";
      resolveInWorkspace(root, start);
      const limit = Math.max(1, Math.min(params.limit ?? MAX_GREP_RESULTS, GREP_CEILING));

      // 自前の走査に落ちたときだけ使う glob（rg / grep へは指定をそのまま渡す）
      const fileFilter = params.glob ? globToRegExp(params.glob) : undefined;
      const matchesGlob = fileFilter
        ? (relative: string): boolean =>
            fileFilter.re.test(fileFilter.matchBasename ? path.basename(relative) : relative)
        : undefined;

      const outcome = await grepTree(
        root,
        {
          pattern: params.pattern,
          start,
          ...(params.glob ? { glob: params.glob } : {}),
          ...(params.ignoreCase ? { ignoreCase: true } : {}),
          ...(params.includeHidden ? { includeHidden: true } : {}),
          limit,
        },
        matchesGlob,
        overrides
      );

      const notes: string[] = [];
      // task-0068: **あと何件あるかを言う。** 「打ち切り」だけだと、少なく返っていることに
      // 気づけない（返り値だけ見ると全部に見える）
      if (outcome.truncated) {
        notes.push(
          `… 全 ${outcome.totalExact ? outcome.total : `${outcome.total}+`} 件のうち ` +
            `${outcome.hits.length} 件だけ出した（limit を上げれば ${GREP_CEILING} 件まで取れる）`
        );
      }
      // I2: 開かなかったファイルがあることを黙って隠さない（自前の走査のときだけ起きる）
      if (outcome.skippedLarge > 0) {
        notes.push(
          `（${outcome.skippedLarge} 件は ${MAX_BUILTIN_SEARCH_BYTES} bytes 超のため未検索）`
        );
      }

      const text =
        outcome.hits.length === 0
          ? [`"${params.pattern}" に一致する行なし`, ...notes].join("\n")
          : [...outcome.hits.map((h) => `${h.path}:${h.line}: ${h.text.trim()}`), ...notes].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          pattern: params.pattern,
          hits: outcome.hits,
          total: outcome.total,
          totalExact: outcome.totalExact,
          truncated: outcome.truncated,
          skippedLarge: outcome.skippedLarge,
          // どの道具で探したか。方言が揃わなかったときに追える
          engine: outcome.engine,
        },
      };
    },
  });

  return [list, read, stat, find, grep];
}
