/**
 * SKILL の学習層（記憶の第二層。ADR-0010 決定26、task-0017、提案§5）。
 *
 * ## 3層のいちばん上
 *
 * SKILL は「番頭核の既定・モジュールの既定・**番頭の学習層**」の3層で、学習層が既定を
 * 上書きする（決定26）。これでモジュールを更新しても番頭の学びが消えず、番頭の学びが
 * モジュールの既定を汚さない。
 *
 * ## 決定26 が名指しした危険への対処
 *
 * 層A資産は「壊れると静かに劣化する」（`spec-improvement-loop` §1）。オーバーライドが
 * **既定の改良を黙って隠す**事故が起きやすい——モジュールが手順を直しても、上に載った
 * 古い学習層が効き続け、改良が永久に届かない。
 *
 * だから**元にした既定の版（ハッシュ）を記録する**。既定が変わったオーバーライドは
 * `detectStaleOverrides` で見つかり、黙って古いまま使わずに incident として積める（P3）。
 *
 * ## なぜ記憶（memory.jsonl）と別の置き場か
 *
 * SKILL は本文が長く、`skill.read` で必要なときだけ読む段階的開示に乗っている。
 * 追記のみの JSONL に混ぜると、注入の予算（提案§3.3）と噛み合わない。層が違う。
 *
 * D6: 依存は node:fs / node:path / node:crypto のみ。
 * I2: 壊れた学習層は黙って飛ばさずエラーにする（`loadBantoSkills` と同じ扱い）。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BantoSkill } from "./skills.js";
import { loadBantoSkills } from "./skills.js";

/** 学習層の由来（`SkillEntry.origin` に載る）。 */
export const LEARNED_ORIGIN = "learned";

/** 何を元に上書きしたか（決定26・task-0017 a3）。 */
export interface SkillBaseline {
  /** 元にした既定の由来（`core` またはモジュール名）。 */
  origin: string;
  /** 元にした既定の本文のハッシュ。既定が変わったかはこれで判る。 */
  hash: string;
}

/** 学習層の1件。 */
export interface LearnedSkill {
  skill: BantoSkill;
  /** 既定を上書きしているなら、その元の版。新しく作った SKILL なら undefined。 */
  basedOn?: SkillBaseline;
}

/** 本文のハッシュ。**改行の揺れで別物にしない**ため、末尾の空白を落としてから取る。 */
export function skillHash(body: string): string {
  return createHash("sha256").update(body.trimEnd()).digest("hex").slice(0, 16);
}

/**
 * 番頭の学習層。
 *
 * `<dataDir>/skills/<name>/SKILL.md` に本文、`<name>/baseline.json` に元の版。
 * **番頭が書ける場所ではなくホストのデータ置き場**に置く——リポジトリの中に置くと
 * 番頭が自分の手順を書き換えて、既定の統制から外れる（決定38b と同じ理由）。
 */
export class LearnedSkillStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 学習層を書く。同名があれば上書きする（学習は上書きでよい——履歴は記憶ではない）。 */
  save(params: {
    name: string;
    description: string;
    body: string;
    basedOn?: SkillBaseline;
  }): LearnedSkill {
    assertSkillName(params.name);
    const skillDir = path.join(this.dir, params.name);
    fs.mkdirSync(skillDir, { recursive: true });
    const filePath = path.join(skillDir, "SKILL.md");

    // frontmatter は agentskills.io 形式。name はディレクトリ名と一致させる
    const front = ["---", `name: ${params.name}`, `description: ${params.description}`, "---", ""];
    fs.writeFileSync(filePath, `${front.join("\n")}\n${params.body.trimEnd()}\n`, "utf-8");

    if (params.basedOn) {
      fs.writeFileSync(
        path.join(skillDir, "baseline.json"),
        `${JSON.stringify(params.basedOn, null, 2)}\n`,
        "utf-8"
      );
    } else {
      fs.rmSync(path.join(skillDir, "baseline.json"), { force: true });
    }

    return {
      skill: { name: params.name, description: params.description, filePath },
      ...(params.basedOn ? { basedOn: params.basedOn } : {}),
    };
  }

  /** 学習層を捨てる（既定に戻す）。 */
  remove(name: string): void {
    assertSkillName(name);
    fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
  }

  /** 学習層の一覧。**`loadBantoSkills` と同じ規則で読む**（形式を2つ持たない）。 */
  list(): LearnedSkill[] {
    return loadBantoSkills(this.dir).map((skill) => {
      const baseline = this.readBaseline(skill.name);
      return { skill, ...(baseline ? { basedOn: baseline } : {}) };
    });
  }

  private readBaseline(name: string): SkillBaseline | undefined {
    const file = path.join(this.dir, name, "baseline.json");
    if (!fs.existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SkillBaseline>;
      if (typeof parsed.origin !== "string" || typeof parsed.hash !== "string") {
        throw new Error("origin / hash がありません");
      }
      return { origin: parsed.origin, hash: parsed.hash };
    } catch (err) {
      // I2: 壊れた記録を黙って無視すると、陳腐化の検出が静かに止まる
      throw new Error(`学習層の baseline が読めません（${file}）: ${String(err)}`);
    }
  }
}

/** 陳腐化したオーバーライド1件（決定26・task-0017 a4）。 */
export interface StaleOverride {
  name: string;
  /** 元にした既定の版。 */
  was: SkillBaseline;
  /** いまの既定のハッシュ。既定が消えていれば undefined。 */
  now: string | undefined;
  reason: "既定が変わった" | "既定が無くなった";
}

/**
 * 既定側が変わったオーバーライドを見つける。
 *
 * **黙って古いまま使わない**（P3・決定26）。これが無いと、モジュールの改良が
 * 永久に届かない状態が静かに続く。
 *
 * @param learned  学習層
 * @param defaults 既定（番頭核とモジュールを解決した後のもの）
 */
export function detectStaleOverrides(
  learned: readonly LearnedSkill[],
  defaults: readonly BantoSkill[]
): StaleOverride[] {
  const byName = new Map(defaults.map((s) => [s.name, s]));
  const stale: StaleOverride[] = [];

  for (const entry of learned) {
    // 元にした既定が無い＝新しく作った SKILL。上書きしていないので陳腐化しない
    if (!entry.basedOn) continue;
    const current = byName.get(entry.skill.name);
    if (!current) {
      stale.push({
        name: entry.skill.name,
        was: entry.basedOn,
        now: undefined,
        reason: "既定が無くなった",
      });
      continue;
    }
    const now = skillHash(fs.readFileSync(current.filePath, "utf-8"));
    if (now !== entry.basedOn.hash) {
      stale.push({ name: entry.skill.name, was: entry.basedOn, now, reason: "既定が変わった" });
    }
  }
  return stale;
}

/** 陳腐化を人が読める形にする（incident の本文に使う）。 */
export function renderStaleOverrides(stale: readonly StaleOverride[]): string {
  return stale
    .map(
      (s) =>
        `- ${s.name}: ${s.reason}（元にした版 ${s.was.hash} / いま ${s.now ?? "（無し）"}、` +
        `由来 ${s.was.origin}）`
    )
    .join("\n");
}

/** ディレクトリ名に使う前に検算する（I2：`../` で外へ出させない）。 */
function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error(`SKILL の名前は英小文字・数字・ハイフンで始まる形です: ${name}`);
  }
}
