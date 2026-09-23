// docs/specs/v4-architecture.md §5.7「効かせる粒度は2つ」「効く・効かないの記録先
// ——設定層。ただし会話にも刻む」の設定層の側。
//
// **1つの Skill に1つの鍵**を runtime config に置く。カスケード（Project 上書き →
// banto 全体の既定）がそのまま「banto 全体の既定」と「この Project でだけ
// 効かせる／外す」になる——新しい置き場を作らない（§2.6、規則12）。

import type { RuntimeConfigStore } from "../config/runtime.js";
import type { SkillDiscovery } from "./discover.js";
import type { SessionSkillSet, SkillRef } from "./types.js";

/** その Skill を効かせるかの鍵。Module の名前で修飾する（§5.7「名前空間は Module 識別子」）。 */
export function skillEnabledKey(ref: Pick<SkillRef, "module" | "name">): string {
  return `skillEnabled:${ref.module}/${ref.name}`;
}

/**
 * 効かせるか。**どこにも書かれていなければ効かせない**（決定・2026-09-23）。
 *
 * 効いている Skill は名前と説明が**毎ターン**文脈に入る（§5.7、1つおよそ100トークン）。
 * Skill を50本配る Module を繋いだだけで毎ターンの費用が黙って増える形にしない
 * ——§5.6「効かせる集合は黙って変えない、明示的にだけ変える」。
 * 入っているが効いていない Skill も、資源としては読める（AI が探せば見つかる）。
 */
export function isSkillEnabled(
  config: Pick<RuntimeConfigStore, "resolve"> | undefined,
  ref: Pick<SkillRef, "module" | "name">,
  projectId: string,
): boolean {
  return config?.resolve(skillEnabledKey(ref), projectId) === true;
}

/**
 * 設定を変える。`layer` が `undefined` なら banto 全体の既定、Project の id ならその上書き。
 * **`value` が `undefined` なら Project の上書きを消す**（全体の既定に戻す）。
 */
export async function setSkillEnabled(
  config: RuntimeConfigStore,
  ref: Pick<SkillRef, "module" | "name">,
  projectId: string | undefined,
  value: boolean | undefined,
): Promise<void> {
  const key = skillEnabledKey(ref);
  if (projectId === undefined) {
    // 全体の既定に「消す」は無い——書かれていないのは「効かせない」と同じなので false を書く
    await config.setInstanceDefault(key, value === true);
    return;
  }
  if (value === undefined) await config.unsetProjectOverride(projectId, key);
  else await config.setProjectOverride(projectId, key, value);
}

/** 集めた Skill から、この会話に効かせる集合を作る。 */
export function selectSessionSkills(
  discovery: SkillDiscovery,
  enabled: (ref: SkillRef) => boolean,
): SessionSkillSet {
  const active: SkillRef[] = [];
  const othersIn: string[] = [];
  for (const skill of discovery.skills) {
    if (enabled(skill)) active.push(skill);
    else if (!othersIn.includes(skill.module)) othersIn.push(skill.module);
  }
  return { active, othersIn, problems: discovery.problems };
}

/** 2つの集合が同じか（同じなら刻み直さない——記録を同じもので埋めない）。 */
export function sameSkillSet(a: SessionSkillSet | undefined, b: SessionSkillSet): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
