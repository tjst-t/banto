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
import { createFileRawHandler } from "../file-raw.js";
import { createFileWriteTools, type FileWriteToolOptions } from "../file-write-tools.js";
import { createPlaceTools } from "../place-tools.js";
import { createPlaceGrantAdminTools, createPlaceRequestTools } from "../place-grant-tools.js";
import type { PlaceGrantStore } from "../place-grants.js";
import type { Inbox } from "../inbox.js";
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
      place: Type.Optional(
        Type.String({
          description:
            "どの場所（リポジトリ等）を開くか。place.list の id。省略するとPOが画面で選ぶ",
        })
      ),
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
    /**
     * **1つのファイルを読む面**（ADR-0017 決定79）。
     *
     * `file.browser`（探す・移動する）とは目的が違うので別種にする——決定17 が
     * 「シェルと職人ビューアは目的が違うので別コンポーネント」としたのと同じ理屈。
     * 器の `doc`（抜粋）から「全部読む →」で来る先がここ。
     */
    kind: "file.viewer",
    title: "ファイルを読む",
    description:
      "**1つのファイルを読むだけ**の面。一覧は出さないので、本文に幅を全部使える。" +
      "器（doc）に抜粋を出したあと「全部読む」で開く先。探して回りたいなら file.browser を使う。" +
      "line を渡すとその行まで自動でスクロールして強調する。",
    parameters: Type.Object({
      place: Type.Optional(
        Type.String({ description: "どの場所（リポジトリ等）のファイルか。place.list の id" })
      ),
      path: Type.String({ description: "読むファイルのパス（ディレクトリは開けない）" }),
      line: Type.Optional(
        Type.Number({ description: "この行まで自動スクロールして強調する（1始まり）" })
      ),
      endLine: Type.Optional(Type.Number({ description: "範囲で強調したいときの終了行" })),
    }),
    component: "FileViewer",
    category: "workspace",
    icon: "📄",
  },
  {
    kind: "git.viewer",
    title: "Git",
    description:
      "コミット一覧・変更ファイル一覧・差分を一画面で閲覧する。レビューや「今どうなっているか」" +
      "「このコミットで何が変わったか」を見せたいときに開く。ref で特定のコミット、path で" +
      "そのコミットの特定ファイルの差分を開いた状態にできる。閲覧専用で、commit等の操作はできない。",
    parameters: Type.Object({
      place: Type.Optional(
        Type.String({
          description:
            "どの場所（リポジトリ等）を開くか。place.list の id。省略するとPOが画面で選ぶ",
        })
      ),
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
 * 書き込み許可は**キャンバスの面を持たない**（決定75）。
 *
 * かつては `place.permissions` という面をここから登録していたが、設定の「場所」と
 * 同じことを2箇所で決められる状態になっていた（PO報告 2026-08-09「かぶっている」）。
 * 場所と、そこで書ける範囲は**同じ1つの設定**なので設定側に寄せた。
 *
 * **その場の判断は取次で足りる**（決定73）——番頭が頼むと判断待ちの札が積まれ、
 * POは会話の横のボタンで許せる。細かく決めたいときだけ、札から設定へ飛ぶ。
 *
 * @param places 場所の帳簿。`file.*` / `git.*` は**呼び出しごとに場所を選ぶ**（決定36e）。
 *   GUI も同じ Tool 契約を HTTP 経由で呼ぶので、引数が1つ増えるだけで場所の選択UIが
 *   成り立つ（決定25：人も番頭も同じ契約、経路が違うだけ）。
 * @param write 書き込み（`file.write`）の設定。ホスト自身のデータ置き場を渡す（決定38b）
 * @param grants 許可の帳簿。渡すと `place.request_write` と承認の口が生える
 * @param inbox 取次。渡すと、番頭の書き込み要求がPOの判断待ちとして積まれる（決定73）
 */
export function createWorkspaceModule(
  places: PlaceRegistry,
  write: FileWriteToolOptions = {},
  grants?: PlaceGrantStore,
  inbox?: Inbox
): BantoModule {
  return {
    name: "workspace",
    title: "ワークスペース",
    description:
      "登録された場所（リポジトリ等）のファイルとgit履歴を扱う組み込みモジュール。" +
      "どこで作業できるかは place.list で分かる。" +
      "閲覧は登録されたどの場所にも届き、書き込みはPOが場所ごとに許した範囲だけ（既定は読み取り専用）。" +
      "gitは閲覧のみで、変更操作は持たない（決定37）。どの場所を見るかは place で選ぶ。",
    endpoint: { baseUrl: WORKSPACE_BASE_URL },
    // Tool の規約に乗らない口（決定27b・39）。バイトをそのまま渡す役は `details` に
    // 載せられないので、この経路だけモジュールが自分で捌く（spec-file-browser §5.8）
    serve: createFileRawHandler(places, WORKSPACE_BASE_URL),
    tools: [
      // 場所の一覧。file.* の引数を埋めるために要る（決定36e）
      ...createPlaceTools(places),
      ...placeScopedTools(places, createFileTools),
      ...createFileWriteTools(places, write),
      ...placeScopedTools(places, createGitTools),
      // 決定38c: 番頭は範囲の拡大を「頼める」だけ。承認は internalTools 側にある
      ...(grants ? createPlaceRequestTools(places, grants, { ...(inbox ? { inbox } : {}) }) : []),
    ],
    // 番頭には渡さない口（決定29e と同じ枠）。番頭が自分で承認できないことの機構的な保証
    internalTools: grants ? createPlaceGrantAdminTools(grants, places) : [],
    views: workspaceViews,
    // このモジュールが既定として出す SKILL（決定26 の第2層）。
    // 置き場所は banto-host パッケージ直下の module-skills/（core 用の skills/ とは混ぜない）。
    // src/modules/workspace.ts も dist/modules/workspace.js も深さが同じなので、
    // どちらからでも `../../module-skills` で packages/banto-host/module-skills に着く
    skills: [
      {
        name: "workspace",
        description:
          "場所（place）の選び方と、ファイル・git の閲覧、書き込み許可の手順。" +
          "どこで作業できるかを見るとき、書いてよい範囲をPOに頼むときに使う。" +
          "既定は読み取り専用で、書けるのはPOが場所ごとに許した範囲だけ。",
        filePath: `${new URL("../../module-skills", import.meta.url).pathname}/workspace/SKILL.md`,
      },
    ],
  };
}
