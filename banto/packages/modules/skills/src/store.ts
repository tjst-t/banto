// Skill の置き場。**ファイルが真実**——一覧は毎回ディスクから導く（規則3、写しを持たない）。
//
//   <置き場>/<Skill 名>/SKILL.md
//   <置き場>/<Skill 名>/references/…   （兄弟の資源として配る）
//   <置き場>/<Skill 名>/scripts/…      （配るが、banto では実行されない）
//
// フォルダの中身は原文のまま置く（アーキ仕様 §5.7「書き換えはしない」）。

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { parseSkillMd } from "./skill-md.js";

export interface StoredSkill {
  /** フォルダ名（Agent Skills の仕様で `name` と一致する）。 */
  name: string;
  description: string;
  /** `SKILL.md` 以外のファイル。フォルダからの相対パス（`/` 区切り）。 */
  files: string[];
}

export interface SkillStoreListing {
  skills: StoredSkill[];
  /** 読めなかったフォルダ。**黙って落とさない**——理由を言う（規則2）。 */
  problems: Array<{ dir: string; problem: string }>;
}

/** 1つの Skill が配るファイルの上限。大きすぎるものを丸ごと一覧に載せない。 */
export const MAX_FILES_PER_SKILL = 500;
/** 深さの上限（循環や異常な入れ子で回り続けない）。 */
const MAX_DEPTH = 8;
/** 1ファイルを読む上限。これを超えるものは文脈に入れる大きさではない。 */
export const MAX_FILE_BYTES = 1024 * 1024;

export async function listStoredSkills(root: string): Promise<SkillStoreListing> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    // **まだ1つも無い**のは正常。それ以外（権限など）は隠さない
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const skills: StoredSkill[] = [];
  const problems: SkillStoreListing["problems"] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
    if (text === undefined) {
      problems.push({ dir: entry.name, problem: "SKILL.md がありません" });
      continue;
    }
    const parsed = parseSkillMd(text, entry.name);
    if (!parsed.ok) {
      problems.push({ dir: entry.name, problem: parsed.problem });
      continue;
    }
    const files: string[] = [];
    const overflow = await walk(dir, "", 0, files);
    if (overflow) {
      problems.push({ dir: entry.name, problem: `ファイルが ${MAX_FILES_PER_SKILL} を超えています（先頭の分だけ配ります）` });
    }
    skills.push({ name: parsed.skill.name, description: parsed.skill.description, files });
  }
  return { skills, problems };
}

/** 兄弟のファイルを集める。**隠しファイルとシンボリックリンクは辿らない**（置き場の外へ出ない）。 */
async function walk(dir: string, rel: string, depth: number, out: string[]): Promise<boolean> {
  if (depth > MAX_DEPTH) return false;
  const entries = await readdir(join(dir, rel), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (await walk(dir, child, depth + 1, out)) return true;
    } else if (entry.isFile() && child !== "SKILL.md") {
      if (out.length >= MAX_FILES_PER_SKILL) return true;
      out.push(child);
    }
  }
  return false;
}

export interface SkillFileContent {
  mimeType: string;
  text?: string;
  /** 文字でないファイルは base64。 */
  blob?: string;
}

/**
 * Skill のファイルを読む。**一覧に載っているものだけ**——URI からパスを組み立てて
 * そのまま開くと、`../` で置き場の外を読める（規則2、fail closed）。
 */
export async function readSkillFile(root: string, skillName: string, relPath: string): Promise<SkillFileContent> {
  const listing = await listStoredSkills(root);
  const skill = listing.skills.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Skill「${skillName}」はありません`);
  if (relPath !== "SKILL.md" && !skill.files.includes(relPath)) {
    throw new Error(`Skill「${skillName}」に ${relPath} はありません`);
  }
  const skillDir = await realpath(join(root, skillName));
  const path = await realpath(join(skillDir, ...relPath.split("/")));
  if (!path.startsWith(skillDir + sep)) throw new Error(`${relPath} は Skill のフォルダの外を指しています`);
  const info = await stat(path);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`${relPath} は大きすぎます（${info.size} バイト、上限 ${MAX_FILE_BYTES}）`);
  }
  const bytes = await readFile(path);
  const mimeType = mimeTypeOf(relPath);
  if (isText(mimeType, bytes)) return { mimeType, text: bytes.toString("utf8") };
  return { mimeType, blob: bytes.toString("base64") };
}

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

export function mimeTypeOf(relPath: string): string {
  return MIME_BY_EXT[extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

/** 文字として返すか。拡張子で決まらないものは、NUL を含まなければ文字とみなす。 */
function isText(mimeType: string, bytes: Buffer): boolean {
  if (mimeType.startsWith("text/") || /json|yaml|xml|svg/.test(mimeType)) return true;
  if (mimeType !== "application/octet-stream") return false;
  return !bytes.subarray(0, 8192).includes(0);
}
