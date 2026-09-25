// **サンドボックスの列は、宣言ではなく置き場所を出す**（変更・2026-09-25——Landlock をやめ、閉じ込めはコンテナになった）。
// 値は host が導く（`modulePlacement`）。画面は語に直すだけ（規則3）。
import type { ModulePlacement } from "@/lib/backend/client";

export const PLACEMENT_LABEL: Record<Exclude<ModulePlacement, "remote">, string> = {
  "project-container": "Project のコンテナ",
  "instance-container": "全体のコンテナ",
  // 同梱の banto 全体の Module だけがここ（banto 自身のコード）
  host: "banto 本体",
};
