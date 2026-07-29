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

/** キャンバスビューが受け取る props。params は canvas.open で渡されたもの。 */
export interface CanvasViewProps {
  params: Record<string, unknown>;
  tabId: string;
  kind: string;
}

/**
 * エクスポート名 → コンポーネント。
 * Kobo の Extension Pack が提供するコンポーネントも、将来ここに合流する。
 */
const REGISTRY: Record<string, ComponentType<CanvasViewProps>> = {
  DemoHello,
  DemoClock,
};

export function resolveCanvasView(component: string): ComponentType<CanvasViewProps> | undefined {
  return REGISTRY[component];
}
