/**
 * キャンバスに描くReactコンポーネントの解決表（ADR-0010 決定12・決定17）。
 *
 * カタログのエントリは `component` にエクスポート名を文字列で持つ。ホスト側は React に
 * 依存しないため文字列のまま扱い、実体への解決はここ（UI側）が行う。
 * iframe は使わず、コンポーネントをそのまま描画する（決定12）。
 *
 * **ここに載るのは、どこかが名指ししている面だけ**——モジュールが登録したキャンバスの面か、
 * 中核の設定区画が `view` で宣言した面（決定43）。誰も名指ししていない
 * コンポーネントを置いておくと、直せない・気づけない死んだ画面になる
 * （`tests/acceptance/canvas-view-components.spec.ts` は逆向き——登録された面が
 * ここに在ることを見る）。
 */

import type { ComponentType } from "react";
import { FileBrowser } from "./FileBrowser.js";
import { GitViewer } from "./GitViewer.js";
import { PlaceSettings } from "./PlaceSettings.js";
import { RepoManager } from "./RepoManager.js";
import { EnvManager } from "./EnvManager.js";
import { WorkerViewer } from "./WorkerViewer.js";
import { MemoryViewer } from "./MemoryViewer.js";
import { SkillViewer } from "./SkillViewer.js";
import { LlmRegistryViewer } from "./LlmRegistryViewer.js";
import { KoboBoard } from "./KoboBoard.js";
import { KoboReview } from "./KoboReview.js";

/** キャンバスビューが受け取る props。params は canvas.open で渡されたもの。 */
export interface CanvasViewProps {
  params: Record<string, unknown>;
  tabId: string;
  kind: string;
  /** このGUIを提供しているモジュール名（決定25・27）。 */
  module: string;
  /**
   * そのモジュールへの到達先（決定25）。コンポーネントはデータをここから取る——
   * エンドポイントを直書きしない。相対パスなら自分のオリジンに解決される。
   */
  endpoint: string;
  /**
   * **別のモジュール**の到達先をモジュール名で引く（決定27 のレジストリ方式のGUI版）。
   *
   * 検証環境の画面が場所の一覧（workspace の `place.list`）を要るような、GUI がまたぐ
   * 場面のため。**URLを直書きさせないための口**であって、直接呼び合うこと自体は
   * 決定27 のとおり（Banto をブローカーにしない）。
   * 未登録のモジュールなら undefined——呼び手はその機能を出さない。
   */
  endpointOf(moduleName: string): string | undefined;
  /**
   * **別の面を開く**（PO要望 2026-08-07：タスクの詳細から担当の職人へ飛びたい）。
   *
   * 面同士を直に繋ぐのではなく、キャンバスに「この種類をこの引数で開いて」と頼む形
   * ——開き方（新しいタブか・どこに置くか）はキャンバスの持ち物で、面は知らなくてよい。
   */
  openCanvas(kind: string, params?: Record<string, unknown>): void;
}

/**
 * エクスポート名 → コンポーネント。
 * Kobo の Extension Pack が提供するコンポーネントも、将来ここに合流する。
 */
const REGISTRY: Record<string, ComponentType<CanvasViewProps>> = {
  // 基本GUIセット（workspace モジュール提供。決定18・24）
  FileBrowser,
  GitViewer,
  // リポジトリ／ワークツリー（repo-manager 提供・決定36）と検証環境（environment-pool 提供・決定32）
  RepoManager,
  EnvManager,
  // セッションビューア（worker-pool モジュール提供。決定18・23）
  WorkerViewer,
  // 番頭の中身（studio モジュール提供。決定25・26）
  MemoryViewer,
  SkillViewer,
  // 中核の設定区画が名指しで描く面（ADR-0011 決定43）。キャンバスには出ない
  LlmRegistryViewer,
  PlaceSettings,
  // 工場（kobo モジュール提供。ADR-0013 決定56・57・59）
  KoboBoard,
  KoboReview,
};

export function resolveCanvasView(component: string): ComponentType<CanvasViewProps> | undefined {
  return REGISTRY[component];
}
