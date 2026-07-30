/**
 * ワークスペースモジュール（組み込み・ADR-0010 決定24・25・27）。
 *
 * 基本GUIセットのうち「ファイル／ディレクトリ表示」「Git閲覧」を担う組み込みモジュール。
 * Kobo が無くても価値がある汎用の道具で、標準ライブラリと同じ位置づけ——常に同梱されるが、
 * 機構としては Kobo や将来のモジュールと対等（決定25）。
 *
 * 現時点で提供するのは Tool のみ。GUIコンポーネントとデータAPIは task-0016 で追加する
 * （決定25：人はGUI→モジュールのデータAPI、番頭はモジュールのTool→モジュール）。
 */

import { createFileTools } from "../file-tools.js";
import { createGitTools } from "../git-tools.js";
import type { BantoModule } from "../module.js";

/** 組み込みモジュールの到達先は Banto ホスト自身。UIは自分のオリジンに解決する。 */
export const WORKSPACE_BASE_URL = "/api/workspace";

export function createWorkspaceModule(root: string): BantoModule {
  return {
    name: "workspace",
    title: "ワークスペース",
    description:
      "作業ディレクトリのファイルとgit履歴を閲覧する組み込みモジュール（すべて読み取り専用）。",
    endpoint: { baseUrl: WORKSPACE_BASE_URL },
    tools: [...createFileTools(root), ...createGitTools(root)],
    // GUIコンポーネントは task-0016 で追加する
    views: [],
    skills: [],
  };
}
