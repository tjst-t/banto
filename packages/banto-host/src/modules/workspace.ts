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
import type { PlaceRegistry } from "../places.js";
import { placeScopedTools } from "../place-scoped.js";
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
      "path にファイルを指定すればそのファイルを開いた状態で始まり、line を渡すとその行まで自動で" +
      "スクロールして強調表示する（file.grep で見つけた箇所をそのまま見せられる）。" +
      "POに構成やファイルの中身、特定の箇所を見せたいときに開く。",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "最初に開くパス。ディレクトリならその中身、ファイルならそのファイルを開く（省略時はルート）",
        })
      ),
      line: Type.Optional(
        Type.Number({ description: "この行まで自動スクロールして強調する（1始まり）" })
      ),
      endLine: Type.Optional(
        Type.Number({ description: "範囲で強調したいときの終了行（line と併せて使う）" })
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
      "コミット一覧・変更ファイル一覧・差分を一画面で閲覧する。レビューや「今どうなっているか」" +
      "「このコミットで何が変わったか」を見せたいときに開く。ref で特定のコミット、path で" +
      "そのコミットの特定ファイルの差分を開いた状態にできる。閲覧専用で、commit等の操作はできない。",
    parameters: Type.Object({
      ref: Type.Optional(
        Type.String({
          description: "最初に選ぶコミット（例: HEAD, a1b2c3）。省略時は未コミットの変更を表示",
        })
      ),
      path: Type.Optional(
        Type.String({ description: "差分を1ファイルに絞る（そのファイルを選択した状態で開く）" })
      ),
    }),
    component: "GitViewer",
    category: "workspace",
    icon: "🌿",
  },
];

/**
 * @param places 場所の帳簿。`file.*` / `git.*` は**呼び出しごとに場所を選ぶ**（決定36e）。
 *   GUI も同じ Tool 契約を HTTP 経由で呼ぶので、引数が1つ増えるだけで場所の選択UIが
 *   成り立つ（決定25：人も番頭も同じ契約、経路が違うだけ）。
 */
export function createWorkspaceModule(places: PlaceRegistry): BantoModule {
  return {
    name: "workspace",
    title: "ワークスペース",
    description:
      "登録された場所（リポジトリ等）のファイルとgit履歴を閲覧する組み込みモジュール" +
      "（すべて読み取り専用）。どの場所を見るかは place で選ぶ。",
    endpoint: { baseUrl: WORKSPACE_BASE_URL },
    tools: [...placeScopedTools(places, createFileTools), ...placeScopedTools(places, createGitTools)],
    views: workspaceViews,
    skills: [],
  };
}
