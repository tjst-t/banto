#!/usr/bin/env node
// 一覧のブランチ（既定 `backlog`）で、番号（number）の無い項目に通し番号を振る——一度だけの振り直し（§4.4「番号」）。
//
//   node assign-numbers.mjs [--repo <リポジトリ>] [--branch backlog] [--legacy <rev>:<path>] [--push]
//
// - 順は「作った順」：createdAt の無い（古い）項目が先、その中は `--legacy`（Backlog の形に移す前の tasks.json。
//   tasks 配列の並び）の順。次に createdAt のある項目を createdAt の順。決まりは model.ts の assignMissingNumbers
// - **番号がある項目は変えない**——何度流しても同じ結果（振るものが無ければコミットしない）
// - Backlog Module と同じ書き方：作業ツリーにも index にも触らず、ブランチに1コミット。ref は compare-and-swap で動かし、
//   先を越されたら読み直して振り直す
// - `--push` で、そのブランチだけを origin へ送る（force しない）
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assignMissingNumbers, parseDocument, serializeDocument, validateDocument } from "../dist/model.js";
import { checkBranch } from "../dist/settings.js";

const AUTHOR = { GIT_AUTHOR_NAME: "banto", GIT_AUTHOR_EMAIL: "banto@localhost", GIT_COMMITTER_NAME: "banto", GIT_COMMITTER_EMAIL: "banto@localhost" };
const ATTEMPTS = 5;

function parseArgs(argv) {
  const out = { repo: process.cwd(), branch: "backlog", legacy: undefined, push: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--push") out.push = true;
    else if (a === "--repo" || a === "--branch" || a === "--legacy") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} の値がありません`);
      out[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`知らない引数です：${a}`);
  }
  return out;
}

export function assignNumbers({ repo, branch, legacy, push }) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), ...AUTHOR, LC_ALL: "C" };
  const git = (args, input) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}), stdio: ["pipe", "pipe", "pipe"] });
  const name = checkBranch(branch);
  const ref = `refs/heads/${name}`;

  let legacyEntries = [];
  if (legacy !== undefined) {
    const raw = JSON.parse(git(["show", legacy]));
    if (!Array.isArray(raw?.tasks)) throw new Error(`${legacy} は古い tasks.json の形（"tasks" の配列）ではありません`);
    legacyEntries = raw.tasks.map((t) => ({ id: String(t.id), title: String(t.title ?? "") }));
  }

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let head;
    try {
      head = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]).trim();
    } catch {
      throw new Error(`${name} ブランチがありません`);
    }
    const parsed = parseDocument(JSON.parse(git(["cat-file", "blob", `${head}:tasks.json`])));
    if (!parsed.ok) throw new Error(`${name} の tasks.json は banto-backlog/1 として読めません：${parsed.reason}`);
    const known = new Set(validateDocument(parsed.doc));
    const { doc, result } = assignMissingNumbers(parsed.doc, legacyEntries);
    if (result.length === 0) return { branch: name, assigned: [], commit: undefined };
    const added = validateDocument(doc).filter((p) => !known.has(p));
    if (added.length > 0) throw new Error(`振ると一覧に問題が増えます：${added.join("／")}`);
    const first = result[0].number;
    const last = result[result.length - 1].number;
    const message = `backlog: 番号の無い ${result.length} 件に #${first}〜#${last} を振る（作った順）\n`;
    const blob = git(["hash-object", "-w", "--stdin"], serializeDocument(doc)).trim();
    const tree = git(["mktree"], `100644 blob ${blob}\ttasks.json\n`).trim();
    const commit = git(["commit-tree", tree, "-p", head, "-F", "-"], message).trim();
    try {
      git(["update-ref", "-m", message.trim(), ref, commit, head]);
    } catch (err) {
      if (/cannot lock ref/i.test(String(err.stderr))) continue; // 先を越された——読み直して振り直す
      throw err;
    }
    let pushed;
    if (push) {
      try {
        git(["push", "origin", `${ref}:${ref}`]);
        pushed = { ok: true };
      } catch (err) {
        pushed = { ok: false, message: String(err.stderr || err.message).trim() };
      }
    }
    return { branch: name, assigned: result.map((i) => ({ id: i.id, number: i.number })), commit, pushed };
  }
  throw new Error(`ほかの書き込みに ${ATTEMPTS} 回続けて先を越されたので、振れませんでした`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    const r = assignNumbers(parseArgs(process.argv.slice(2)));
    if (r.assigned.length === 0) {
      console.log(`${r.branch} ブランチの項目には、もう全部番号があります（何も変えていません）。`);
    } else {
      const a = r.assigned;
      console.log(`${r.branch} ブランチの ${a.length} 件に #${a[0].number}〜#${a[a.length - 1].number} を振りました（${r.commit.slice(0, 12)}）。`);
      console.log(`最初：${a.slice(0, 3).map((i) => `#${i.number} ${i.id}`).join("、")}　最後：${a.slice(-3).map((i) => `#${i.number} ${i.id}`).join("、")}`);
      if (r.pushed?.ok) console.log(`origin へ送りました（git push origin ${r.branch}）。`);
      else if (r.pushed) console.log(`origin へ送れませんでした——あとで git push origin ${r.branch} で送れます：${r.pushed.message}`);
      else console.log(`origin へは送っていません（送るなら git push origin ${r.branch}。Backlog は次の変更のときにも送ります）。`);
    }
  } catch (err) {
    console.error(`振れませんでした：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
