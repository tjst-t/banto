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
import { PlacePermissions } from "./PlacePermissions.js";
import { RepoManager } from "./RepoManager.js";
import { EnvManager } from "./EnvManager.js";
import { WorkerViewer } from "./WorkerViewer.js";
import { MemoryViewer } from "./MemoryViewer.js";
import { SkillViewer } from "./SkillViewer.js";
import { PiAgentViewer } from "./PiAgentViewer.js";
import { LlmRegistryViewer } from "./LlmRegistryViewer.js";

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
  /**
   * **別のモジュール**の到達先をモジュール名で引く（決定27 のレジストリ方式のGUI版）。
   *
   * 検証環境の画面が場所の一覧（workspace の `place.list`）を要るような、GUI がまたぐ
   * 場面のため。**URLを直書きさせないための口**であって、直接呼び合うこと自体は
   * 決定27 のとおり（Banto をブローカーにしない）。
   * 未登録のモジュールなら undefined——呼び手はその機能を出さない。
   */
  endpointOf(moduleName: string): string | undefined;
}

/**
 * エクスポート名 → コンポーネント。
 * Kobo の Extension Pack が提供するコンポーネントも、将来ここに合流する。
 */
const REGISTRY: Record<string, ComponentType<CanvasViewProps>> = {
  // 基本GUIセット（workspace モジュール提供。決定18・24）
  FileBrowser,
  GitViewer,
  PlacePermissions,
  // リポジトリ／ワークツリー（repo-manager 提供・決定36）と検証環境（environment-pool 提供・決定32）
  RepoManager,
  EnvManager,
  // セッションビューア（worker-pool モジュール提供。決定18・23）
  WorkerViewer,
  // 番頭の中身（studio モジュール提供。決定25・26）
  MemoryViewer,
  SkillViewer,
  // pi agent 設定（pi-agent モジュール提供・task-0050）
  PiAgentViewer,
  // LLM 管理（llm-registry モジュール提供・ADR-0004）
  LlmRegistryViewer,
  // テスト用（実物が揃ったら外す）
  DemoHello,
  DemoClock,
};

export function resolveCanvasView(component: string): ComponentType<CanvasViewProps> | undefined {
  return REGISTRY[component];
}
