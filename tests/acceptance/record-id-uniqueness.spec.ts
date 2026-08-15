/**
 * 記録の id は一意である（task-0152 / imp-0055）。
 *
 * `work/inbox/**` の起票（imp / inc / prop）と `docs/adr/**` の ADR は、
 * **ファイル名の慣習で採番している**。機構が採番していないため（imp-0054）、
 * 枝が並走すると同じ番号を2つの枝が同時に取る。2026-08-15 には
 * adr-0023 / imp-0040 / imp-0041 / inc-0070 が2本ずつ在った。
 *
 * ここで落とすもの:
 *   1. 同じ id を名乗る記録が2本以上ある（ファイル名の id・frontmatter の `id:` の両方で見る）
 *   2. ファイル名の id と frontmatter の `id:` が食い違う
 *
 * ここで落とさないもの:
 *   - 欠番（adr-0024 など）。起票して消した跡かもしれず、欠番それ自体は異常ではない。
 *     見落とさないよう**一覧だけ出す**（警告）。
 *   - frontmatter を持たない古い記録（imp-0015 など）。id を名乗っていないので
 *     食い違いようがない。こちらも一覧だけ出す。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

/** 走査する場所。ここに置かれた `*.md` が記録とみなされる */
const RECORD_ROOTS = ["work/inbox", "docs/adr"];

/** ファイル名の先頭にある id（`imp-0040-...md` → `imp-0040`） */
const FILENAME_ID = /^([a-z]+)-(\d{4})(?:-|$)/;

interface Record {
  /** リポジトリ相対のパス */
  relPath: string;
  /** ファイル名から読んだ id */
  filenameId: string;
  /** 種別（imp / inc / prop / adr） */
  prefix: string;
  /** 連番 */
  seq: number;
  /** frontmatter の `id:`。frontmatter が無い／`id:` が無ければ null */
  frontmatterId: string | null;
}

function listMarkdown(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/** 先頭の `---` ... `---` から `id:` を1つ拾う。無ければ null */
function readFrontmatterId(absPath: string): string | null {
  const lines = fs.readFileSync(absPath, "utf8").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const m = /^id:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

function collectRecords(): Record[] {
  const records: Record[] = [];
  for (const root of RECORD_ROOTS) {
    for (const relPath of listMarkdown(root)) {
      const name = path.basename(relPath, ".md");
      const m = FILENAME_ID.exec(name);
      if (!m) continue; // README など、採番されていないファイルは記録ではない
      records.push({
        relPath,
        filenameId: `${m[1]}-${m[2]}`,
        prefix: m[1],
        seq: Number(m[2]),
        frontmatterId: readFrontmatterId(path.join(repoRoot, relPath)),
      });
    }
  }
  return records;
}

function groupBy(records: Record[], key: (r: Record) => string | null): Map<string, Record[]> {
  const map = new Map<string, Record[]>();
  for (const r of records) {
    const k = key(r);
    if (k === null) continue;
    const bucket = map.get(k);
    if (bucket) bucket.push(r);
    else map.set(k, [r]);
  }
  return map;
}

const records = collectRecords();

describe("[AC-T0152-1] 記録の id は一意（work/inbox・docs/adr）", () => {
  it("そもそも記録が拾えている（走査の空振りで緑になっていない）", () => {
    assert.ok(
      records.length >= 100,
      `${RECORD_ROOTS.join(" / ")} から拾えた記録が ${records.length} 件しかない。走査の指定が壊れていないか`,
    );
  });

  it("[a1] ファイル名の id が重複していない", () => {
    const dups = [...groupBy(records, (r) => r.filenameId)]
      .filter(([, rs]) => rs.length > 1)
      .map(([id, rs]) => `  ${id}: ${rs.map((r) => r.relPath).join(" / ")}`);
    assert.equal(
      dups.length,
      0,
      `同じ id を名乗る記録がある。後から書かれた方を空き番号へ振り直し、参照も付け替えること（imp-0055）:\n${dups.join("\n")}`,
    );
  });

  it("[a1] frontmatter の `id:` が重複していない", () => {
    const dups = [...groupBy(records, (r) => r.frontmatterId)]
      .filter(([, rs]) => rs.length > 1)
      .map(([id, rs]) => `  ${id}: ${rs.map((r) => r.relPath).join(" / ")}`);
    assert.equal(
      dups.length,
      0,
      `同じ id を frontmatter に書いた記録がある:\n${dups.join("\n")}`,
    );
  });

  it("[a2] ファイル名の id と frontmatter の `id:` が食い違わない", () => {
    const mismatched = records
      .filter((r) => r.frontmatterId !== null && r.frontmatterId !== r.filenameId)
      .map((r) => `  ${r.relPath}: ファイル名=${r.filenameId} / frontmatter=${r.frontmatterId}`);
    assert.equal(
      mismatched.length,
      0,
      `ファイル名と frontmatter で id が違う。振り直しのときは両方直すこと:\n${mismatched.join("\n")}`,
    );
  });

  it("欠番は落とさない——一覧に出すだけ（起票して消した跡かもしれない）", () => {
    const byPrefix = groupBy(records, (r) => r.prefix);
    const lines: string[] = [];
    for (const [prefix, rs] of [...byPrefix].sort()) {
      const used = new Set(rs.map((r) => r.seq));
      const max = Math.max(...used);
      const missing: number[] = [];
      for (let n = 1; n <= max; n++) if (!used.has(n)) missing.push(n);
      if (missing.length > 0) {
        lines.push(`  ${prefix}: ${missing.map((n) => String(n).padStart(4, "0")).join(", ")}`);
      }
    }
    if (lines.length > 0) {
      console.log(`[record-id] 欠番（異常ではない。採番の参考に）:\n${lines.join("\n")}`);
    }
    const noFrontmatter = records.filter((r) => r.frontmatterId === null);
    if (noFrontmatter.length > 0) {
      console.log(
        `[record-id] frontmatter に id: が無い記録（古い書式。食い違いは検査できない）:\n${noFrontmatter
          .map((r) => `  ${r.relPath}`)
          .join("\n")}`,
      );
    }
    // 欠番・古い書式は失敗にしない（この試験の主は重複を落とすこと）
    assert.ok(true);
  });
});
