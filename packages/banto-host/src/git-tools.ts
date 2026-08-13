/**
 * Git 閲覧Tool（ADR-0010 決定18・決定24）。
 *
 * 基本GUIセットの「Git閲覧（DIFF／履歴／状態／ブランチ／blame）」のデータ側。
 * Kobo にも Worker Pool にも依存せず、ローカルの git リポジトリだけで動く（決定24）。
 *
 * **すべて閲覧専用**。stage / commit / branch作成などの変更操作は持たない——変更は
 * 職人へ委譲し（D10）、また Kobo のマージキュー・マージゲートと責務が競合するため（決定24）。
 *
 * 各Toolは `content`（番頭・LLM向けのテキスト）と `details`（UI向けの構造化データ）の
 * 両方を返す。ロジックは1箇所にあり、その上に口が2つ出る形（D5・決定25）。
 *
 * D6: node:child_process のみ。git はシェルを介さず引数配列で呼ぶ（注入の余地を作らない）。
 * I2: git の異常終了は握りつぶさず stderr を添えて投げる。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

const execFileAsync = promisify(execFile);

/** 出力の上限。番頭の文脈を埋め尽くさないため。 */
const MAX_OUTPUT_BYTES = 200_000;

/**
 * git を実行して stdout を返す。
 * I2: 非ゼロ終了は stderr を添えて例外にする（「変更なし」と「リポジトリでない」を混同しない）。
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
    });
    return stdout;
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail || String(err)}`);
  }
}

/** 上限を超えたら切って、切ったことを明示する。 */
function bounded(output: string, emptyMessage: string): string {
  const trimmed = output.trimEnd();
  if (trimmed.length === 0) return emptyMessage;
  if (trimmed.length <= MAX_OUTPUT_BYTES) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_BYTES)}\n… 出力が長いため打ち切り（上限 ${MAX_OUTPUT_BYTES} bytes）`;
}

export function createGitTools(repoRoot: string): NamespacedToolDefinition[] {
  const status = defineNamespacedTool({
    name: "git.status",
    label: "Git: Status",
    description:
      "作業ツリーの状態（ブランチ・変更済み・未追跡）。閲覧専用。\n例: {} → \"## main\" \"M packages/banto-host/src/bin.ts\" \"?? notes.md\"",
    parameters: Type.Object({}),
    async execute() {
      const out = await git(repoRoot, ["status", "--porcelain=v1", "-b"]);
      const lines = out.trimEnd().split("\n").filter((l) => l.length > 0);
      const branchLine = lines.find((l) => l.startsWith("##"));
      const details = {
        branch: branchLine?.replace(/^##\s*/, "").split(/\.{3}|\s/)[0] ?? "",
        files: lines
          .filter((l) => !l.startsWith("##"))
          .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
      };
      return { content: [{ type: "text" as const, text: bounded(out, "変更なし") }], details };
    },
  });

  const diff = defineNamespacedTool({
    name: "git.diff",
    label: "Git: Diff",
    description:
      "差分を返す（閲覧専用）。既定は作業ツリーの未コミット分。\n例: {} → 未コミット分／{ref: \"main\", stat: true} → main との変更量だけ\nref とパスは英語で埋める。",
    parameters: Type.Object({
      ref: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      staged: Type.Optional(Type.Boolean()),
      stat: Type.Optional(Type.Boolean())
    }),
    async execute(params) {
      const args = ["diff"];
      if (params.staged) args.push("--cached");
      if (params.stat) args.push("--stat");
      if (params.ref) args.push(params.ref);
      // `--` 以降をパスとして渡し、ref との取り違えを防ぐ
      if (params.path) args.push("--", params.path);

      const out = await git(repoRoot, args);
      return {
        content: [{ type: "text" as const, text: bounded(out, "差分なし") }],
        details: { diff: out.trimEnd(), stat: params.stat === true, ...(params.path ? { path: params.path } : {}) },
      };
    },
  });

  const log = defineNamespacedTool({
    name: "git.log",
    label: "Git: Log",
    description:
      "コミット履歴を新しい順に返す。閲覧専用。\n例: {limit: 5, path: \"docs/adr\"} → \"7133f76 2026-08-13 tjst-t — fix(work): …\"\nref とパスは英語で埋める。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      path: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String())
    }),
    async execute(params) {
      const limit = Math.max(1, Math.min(params.limit ?? 20, 200));
      const args = ["log", `-n${limit}`, "--date=short", "--pretty=format:%h %ad %an — %s"];
      if (params.ref) args.push(params.ref);
      if (params.path) args.push("--", params.path);

      const out = await git(repoRoot, args);
      const commits = out
        .trimEnd()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const m = /^(\S+) (\S+) (.*?) — (.*)$/.exec(line);
          return m
            ? { hash: m[1]!, date: m[2]!, author: m[3]!, subject: m[4]! }
            : { hash: "", date: "", author: "", subject: line };
        });
      return {
        content: [{ type: "text" as const, text: bounded(out, "コミットなし") }],
        details: { commits },
      };
    },
  });

  const branches = defineNamespacedTool({
    name: "git.branches",
    label: "Git: Branches",
    description: "ブランチ一覧を最終更新の新しい順に返す。閲覧専用（作成・切替はしない）。",
    parameters: Type.Object({
      remote: Type.Optional(Type.Boolean({ description: "リモート追跡ブランチも含める" })),
    }),
    async execute(params) {
      const args = [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:short)\t%(contents:subject)",
        "refs/heads",
      ];
      if (params.remote) args.push("refs/remotes");

      const out = await git(repoRoot, args);
      const current = (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const rows = out
        .trimEnd()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const [name = "", date = "", subject = ""] = line.split("\t");
          return { name, date, subject, current: name === current };
        });
      const text =
        rows.length === 0
          ? "ブランチなし"
          : rows.map((r) => `${r.current ? "*" : " "} ${r.name}  ${r.date}  ${r.subject}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { current, branches: rows } };
    },
  });

  const blame = defineNamespacedTool({
    name: "git.blame",
    label: "Git: Blame",
    description:
      "ファイルの各行が、いつ誰のどのコミットで入ったかを返す。" +
      "「なぜこの行がこうなっているか」を辿るときに使う。閲覧専用。",
    parameters: Type.Object({
      path: Type.String({ description: "対象ファイル（リポジトリからの相対パス）" }),
      from: Type.Optional(Type.Number({ description: "開始行（1始まり）" })),
      to: Type.Optional(Type.Number({ description: "終了行" })),
    }),
    async execute(params) {
      const args = ["blame", "--date=short"];
      if (params.from !== undefined) {
        args.push("-L", `${params.from},${params.to ?? params.from + 40}`);
      }
      args.push("--", params.path);

      const out = await git(repoRoot, args);
      return {
        content: [{ type: "text" as const, text: bounded(out, "(空)") }],
        details: { path: params.path, blame: out.trimEnd() },
      };
    },
  });

  const show = defineNamespacedTool({
    name: "git.show",
    label: "Git: Show",
    description:
      "1つのコミットが入れた変更（メタ・変更ファイル一覧・差分）。閲覧専用。\n例: {ref: \"7133f76\"} → 全体／{ref: \"HEAD\", path: \"docs/ROADMAP.json\"} → 1ファイル分\nref とパスは英語で埋める。",
    parameters: Type.Object({
      ref: Type.String(),
      path: Type.Optional(Type.String())
    }),
    async execute(params) {
      // メタ情報。%x09 はタブ区切り（件名に空白が入っても壊れない）
      const meta = await git(repoRoot, [
        "show",
        "--no-patch",
        "--date=short",
        "--format=%H%x09%h%x09%ad%x09%an%x09%s",
        params.ref,
      ]);
      const [hash = "", short = "", date = "", author = "", subject = ""] = meta.trim().split("\t");

      // 変更ファイル一覧。--root を付けると最初のコミットでも動く。
      // --no-patch は付けない——name-status の出力まで消えてしまう（実測で確認）
      const nameStatus = await git(repoRoot, [
        "show",
        "--name-status",
        "--root",
        "--format=",
        params.ref,
      ]);
      const files = nameStatus
        .trimEnd()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const [status = "", ...rest] = line.split("\t");
          return { status, path: rest.join("\t") };
        });

      const patchArgs = ["show", "--patch", "--root", "--format=", params.ref];
      if (params.path) patchArgs.push("--", params.path);
      const patch = await git(repoRoot, patchArgs);

      const text = [
        `${short} ${date} ${author} — ${subject}`,
        ...files.map((f) => `${f.status}\t${f.path}`),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: bounded(text, "(空)") }],
        details: { hash, short, date, author, subject, files, diff: patch.trimEnd() },
      };
    },
  });

  return [status, diff, log, branches, blame, show];
}
