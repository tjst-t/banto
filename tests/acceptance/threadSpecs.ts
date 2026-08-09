/**
 * 幹と枝を試験から開くときの雛形（ADR-0017 決定77・task-0088）。
 *
 * 帳簿は「還す条件と理由が無いと枝は開けない」を型と実行時の両方で縛る。試験のたびに
 * その4欄を書き並べると、**確かめたいこと（配信・帳簿の振る舞い）が埋もれる**ので、
 * ここで1度だけ書く。**縛りを緩めるためのものではない**——枝の型はそのまま通す。
 */

import type { ThreadSpec } from "@banto/host";

/** 幹。プロジェクトに1本で、畳めない。 */
export const TRUNK: ThreadSpec = { kind: "trunk" };

/** 枝。還す条件と理由は書く（書けないものは枝にしない・決定77）。 */
export function branchSpec(title: string, openedBy: "banto" | "po" = "banto"): ThreadSpec {
  return {
    kind: "branch",
    title,
    returnCondition: `${title} の結論が出たら`,
    openedBy,
    reason: `${title} は往復が続くので枝にする`,
  };
}
