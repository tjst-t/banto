/**
 * ワークスペースモジュール（組み込み・ADR-0010 決定24・25・27）。
 *
 * 基本GUIセットのうち「ファイル／ディレクトリ表示」「Git閲覧」を担う組み込みモジュール。
 * Kobo が無くても価値がある汎用の道具で、標準ライブラリと同じ位置づけ——常に同梱されるが、
 * 機構としては Kobo や将来のモジュールと対等（決定25）。
 *
 * Tool・GUIコンポーネント・データAPI の3点を提供する（決定25）。データAPIは Banto ホストが
 * `{endpoint}/tools/{Tool名}` で公開し（module-serve.ts）、GUIはそこから構造化データを取る。
 * 番頭は同じ Tool を直接実行する——**同じ実装の上に口が2つ**で、契約は1つ（決定27b）。
 */

import { Type } from "typebox";
import { createFileTools } from "../file-tools.js";
import { createGitTools } from "../git-tools.js";
import type { BantoModule } from "../module.js";
import type { CanvasViewSpec } from "../canvas.js";

/** 組み込みモジュールの到達先は Banto ホスト自身。UIは自分のオリジンに解決する。 */
export const WORKSPACE_BASE_URL = "/api/workspace";

/**
 * 基本GUIセットのうち、このモジュールが提供する GUI（決定18・24）。
 * `component` は React のエクスポート名で、実体の解決は UI 側が行う（決定17）。
 */
const workspaceViews: CanvasViewSpec[] = [
  {
    kind: "file.browser",
    title: "ファイル",
    description:
      "ワークスペースのディレクトリとファイルを閲覧する。ツリーを辿れて、ファイルを選ぶと中身も表示される。" +
      "path にファイルを指定すればそのファイルを開いた状態で始まる。POに構成やファイルの中身を見せたいときに開く。",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "最初に開くパス。ディレクトリならその中身、ファイルならそのファイルを開く（省略時はルート）",
        })
      ),
    }),
    component: "FileBrowser",
    category: "workspace",
    icon: "📁",
  },
  {
    kind: "git.viewer",
    title: "Git",
    description:
      "作業ツリーの状態・差分・コミット履歴を閲覧する。レビューや「今どうなっているか」を見せたいときに開く。",
    parameters: Type.Object({
      tab: Type.Optional(
        Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("log")], {
          description: "最初に見せる面（省略時は status）",
        })
      ),
    }),
    component: "GitViewer",
    category: "workspace",
    icon: "🌿",
  },
];

export function createWorkspaceModule(root: string): BantoModule {
  return {
    name: "workspace",
    title: "ワークスペース",
    description:
      "作業ディレクトリのファイルとgit履歴を閲覧する組み込みモジュール（すべて読み取り専用）。",
    endpoint: { baseUrl: WORKSPACE_BASE_URL },
    tools: [...createFileTools(root), ...createGitTools(root)],
    views: workspaceViews,
    skills: [],
  };
}
