/**
 * 番頭の手続き記憶（SKILL.md、agentskills.io形式）— ADR-0010 決定3・決定9。
 *
 * 決定9の境界線：単発は Tool、複数Tool呼び出しにまたがる手順知識は SKILL。
 * 番頭の SKILL は `packages/banto-host/skills/<name>/SKILL.md` に置く。
 *
 * 職人・監査セッション向けのプロンプト資産（リポジトリ直下の `skills/`）とは別物。
 * あちらは Kobo が spawn する職人が使う層Aの資産（→ spec-document-system §1）。
 *
 * ## なぜ pi の SKILL 機構に乗らず自前で持つか
 *
 * pi は progressive disclosure（システムプロンプトには一覧だけ載せ、本体はモデルが
 * `read` ツールで読む）を採る。そのため `read` が無いとSKILLセクションごと出力しない
 * （`core/system-prompt.js`: `hasRead && skills.length > 0`）。番頭は組み込みツールを
 * 無効化している（D10：細かい仕事は職人へ委譲）ため、この前提と噛み合わない。
 * また pi に許可リストを渡すとカスタムToolまで除外されるので、`read` だけ足す回避も効かない。
 *
 * そこで progressive disclosure は同じ考え方のまま自前で持つ：一覧はシステムプロンプトへ
 * 注入し、本体は `skill.read` Tool で読ませる。番頭に汎用のファイル読み取りを与えずに済み、
 * 決定1（結合はTool/SKILLの公開I/Fのみ）とも、ハーネス差し替え可能性とも整合する。
 *
 * D6: 依存は node:fs / node:path / node:url のみ。
 * I2: 壊れたSKILLは黙って飛ばさずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 読み込まれたSKILL1件。本体（body）は必要になるまで読まない。 */
export interface BantoSkill {
  /** ディレクトリ名と一致する識別子（agentskills.io: name はディレクトリ名と一致） */
  name: string;
  /** いつ使うかを1行で書いた説明。これだけが常時システムプロンプトに載る */
  description: string;
  /** SKILL.md の絶対パス */
  filePath: string;
}

/**
 * 番頭のSKILLディレクトリの絶対パス。
 *
 * このファイルは実行時 `packages/banto-host/src/skills.ts`（tsx）または
 * `packages/banto-host/dist/skills.js`（ビルド後）に居る。どちらも1つ上が
 * パッケージルートなので、同じ解決で `packages/banto-host/skills` に着く。
 */
export function bantoSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "skills");
}

/** SKILL.md 冒頭のYAML frontmatterから name / description だけを取り出す。 */
function parseSkillFrontmatter(content: string, filePath: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    throw new Error(`SKILL is missing YAML frontmatter: ${filePath}`);
  }
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    // トップレベルの `key: value` のみ拾う（インデント行は入れ子なので無視）
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  const name = fields["name"];
  const description = fields["description"];
  // I2: description 欠落のSKILLは「いつ使うか」が伝わらず載せる意味がない。エラーにする。
  if (!name) throw new Error(`SKILL is missing "name" in frontmatter: ${filePath}`);
  if (!description) throw new Error(`SKILL is missing "description" in frontmatter: ${filePath}`);
  return { name, description };
}

/**
 * ディレクトリ配下の `<name>/SKILL.md` を読み込む。ディレクトリが無ければ空。
 * frontmatter の name がディレクトリ名と食い違う場合はエラー（agentskills.io の規則）。
 */
export function loadBantoSkills(dir: string = bantoSkillsDir()): BantoSkill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: BantoSkill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath)) continue;

    const { name, description } = parseSkillFrontmatter(fs.readFileSync(filePath, "utf-8"), filePath);
    if (name !== entry.name) {
      throw new Error(`SKILL name "${name}" must match its directory name "${entry.name}": ${filePath}`);
    }
    skills.push({ name, description, filePath });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * システムプロンプトへ注入するSKILL一覧（progressive disclosure の「一覧」側）。
 * SKILLが無ければ空文字。本体は載せない——必要になったら skill.read で読む。
 */
export function renderSkillsForPrompt(skills: BantoSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "# 使えるSKILL（手順知識）",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
    "該当する作業に入る前に skill.read で本体を読み、その手順に従う。",
  ].join("\n");
}

/** SKILL本体を読む。未知の名前はエラー（I2）。 */
export function readBantoSkill(name: string, skills: BantoSkill[]): string {
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    throw new Error(`Unknown SKILL "${name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
  }
  return fs.readFileSync(skill.filePath, "utf-8");
}
