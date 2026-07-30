/**
 * キャンバスに描くReactコンポーネントの解決表（ADR-0010 決定12・決定17）。
 *
 * カタログのエントリは `component` にエクスポート名を文字列で持つ。ホスト側は React に
 * 依存しないため文字列のまま扱い、実体への解決はここ（UI側）が行う。
 * iframe は使わず、コンポーネントをそのまま描画する（決定12）。
 */

import type { ComponentType } from "react";
import { DemoHello } from "./DemoHello.js";
import { DemoClock } from "./DemoClock.js";
import { FileBrowser } from "./FileBrowser.js";
import { GitViewer } from "./GitViewer.js";
import { WorkerViewer } from "./WorkerViewer.js";

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
   * データ取得を伴うコンポーネントの実装は task-0016 以降。
   */
  endpoint: string;
}

/**
 * エクスポート名 → コンポーネント。
 * Kobo の Extension Pack が提供するコンポーネントも、将来ここに合流する。
 */
const REGISTRY: Record<string, ComponentType<CanvasViewProps>> = {
  // 基本GUIセット（workspace モジュール提供。決定18・24）
  FileBrowser,
  GitViewer,
  // セッションビューア（worker-pool モジュール提供。決定18・23）
  WorkerViewer,
  // テスト用（実物が揃ったら外す）
  DemoHello,
  DemoClock,
};

export function resolveCanvasView(component: string): ComponentType<CanvasViewProps> | undefined {
  return REGISTRY[component];
}
