// docs/specs/v4-architecture.md §5.6・§5.7「Skill——Module が配り、core が効かせる」の型。

/** Module が配っている Skill 1件（`resources/list` に `dev.banto/skill` の印で出ているもの）。 */
export interface SkillRef {
  /** 配っている Module の名前（宣言の name——Runner から見える `mcp__<name>__…` と同じ）。 */
  module: string;
  /** Agent Skills の `name`（Module が frontmatter から載せたもの）。 */
  name: string;
  /** Agent Skills の `description`。 */
  description: string;
  /** 本体（`SKILL.md`）の資源の URI。AI はこれを `ReadMcpResourceTool` で読む。 */
  uri: string;
}

/** 読めなかった Module・形の合わない Skill。**黙って落とさない**（規則2）。 */
export interface SkillProblem {
  module: string;
  message: string;
}

/**
 * **会話（のセッション）が始まった時点で固定した集合**（決定・2026-09-23）。
 *
 * `instructions` は `resume` でも Fork でも読み直されない（実測）ので、効かせる
 * 集合は新しいセッションの開始時に決まり、そのセッションが続くかぎり変わらない。
 * **設定は「これから」、この記録は「あのとき」**——あとから設定を変えても、
 * この会話がなぜそう振る舞ったかはこれで説明できる。
 */
export interface SessionSkillSet {
  /** 効かせた Skill。名前と説明が `instructions` に載る。 */
  active: SkillRef[];
  /** 効かせていない Skill **も**配っている Module——`instructions` に「他にもある」と書く。 */
  othersIn: string[];
  problems: SkillProblem[];
}
