#!/usr/bin/env node
// 作業ツリーの tasks.json（`banto-backlog/1`）を、一覧のブランチ（既定 `backlog`）へ移す（§4.4「置き場」）。
//
//   node move-to-branch.mjs [--repo <リポジトリ>] [--file docs/tasks.json] [--branch backlog] [--push]
//
// - **作業ツリーにも index にも触らない**——Backlog Module と同じ低レベルのコマンドで、親を持たない（orphan）コミットを
//   1つ作り、ブランチを**まだ無いときだけ**作る（あれば断る——上書きしない）。元のファイルは消さない（消すのは人が、
//   普通のコミットで）
// - 中身は `banto-backlog/1` として読めることを確かめてから移す（古い形なら convert-tasks-json.mjs が先）。バイトは変えない
// - `--push` で、そのブランチだけを origin へ送る（このリポジトリの git の設定のまま。force しない）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument, validateDocument } from "../dist/model.js";
import { checkBranch } from "../dist/settings.js";

const AUTHOR = { GIT_AUTHOR_NAME: "banto", GIT_AUTHOR_EMAIL: "banto@localhost", GIT_COMMITTER_NAME: "banto", GIT_COMMITTER_EMAIL: "banto@localhost" };

function parseArgs(argv) {
  const out = { repo: process.cwd(), file: "docs/tasks.json", branch: "backlog", push: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--push") out.push = true;
    else if (a === "--repo" || a === "--file" || a === "--branch") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} の値がありません`);
      out[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`知らない引数です：${a}`);
  }
  return out;
}

export function moveToBranch({ repo, file, branch, push }) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), ...AUTHOR, LC_ALL: "C" };
  const git = (args, input) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env, ...(input !== undefined ? { input } : {}), stdio: ["pipe", "pipe", "pipe"] }).trim();
  const name = checkBranch(branch);
  const ref = `refs/heads/${name}`;
  let exists = true;
  try {
    git(["rev-parse", "--verify", "-q", ref]);
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`${name} ブランチはもうあります——上書きしません（中身は git show ${name}:tasks.json で見られます）`);

  const path = resolve(repo, file);
  const text = readFileSync(path, "utf8");
  const parsed = parseDocument(JSON.parse(text));
  if (!parsed.ok) {
    throw new Error(`${file} は banto-backlog/1 として読めません：${parsed.reason}${parsed.legacy ? "（古い形——先に convert-tasks-json.mjs で変換します）" : ""}`);
  }
  const problems = validateDocument(parsed.doc);

  const blob = git(["hash-object", "-w", "--stdin"], text);
  const tree = git(["mktree"], `100644 blob ${blob}\ttasks.json\n`);
  const commit = git(["commit-tree", tree, "-F", "-"], `backlog: ${file} から移す（${parsed.doc.items.length} 件）\n`);
  // まだ無いときだけ作る（全部 0 の古い値——別の誰かが先に作っていたら失敗する）
  git(["update-ref", "-m", `backlog: ${file} から移す`, ref, commit, "0".repeat(commit.length)]);
  let pushed;
  if (push) {
    try {
      git(["push", "origin", `${ref}:${ref}`]);
      pushed = { ok: true };
    } catch (err) {
      pushed = { ok: false, message: String(err.stderr || err.message).trim() };
    }
  }
  return { branch: name, commit, items: parsed.doc.items.length, problems, pushed, file };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    const r = moveToBranch(parseArgs(process.argv.slice(2)));
    console.log(`${r.file} の ${r.items} 件を ${r.branch} ブランチに移しました（${r.commit.slice(0, 12)}）。作業ツリーと index には触っていません。`);
    if (r.problems.length > 0) console.log(`一覧に問題があります（そのまま移しました）：${r.problems.join("／")}`);
    if (r.pushed?.ok) console.log(`origin へ送りました（git push origin ${r.branch}）。`);
    else if (r.pushed) console.log(`origin へ送れませんでした——あとで git push origin ${r.branch} で送れます：${r.pushed.message}`);
    else console.log(`origin へは送っていません（送るなら git push origin ${r.branch}。Backlog は次の変更のときにも送ります）。`);
    console.log(`元の ${r.file} は残しています。要らなければ、普通のコミットで消してください。`);
  } catch (err) {
    console.error(`移せませんでした：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
