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

/** NUL を含むならバイナリとみなす（テキストとして出すと文脈を壊す）。 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
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

  return [list, read, stat];
}
