/**
 * テスト用のキャンバスGUIのカタログ定義（task-0013 a4）。
 *
 * キャンバス機構が動いていることを目で確かめるためのもの。Kobo 由来のGUIも
 * 基本GUIセット（決定18・24）もまだ無いため、当面の唯一の中身になる。
 * 実物のGUIが揃ったら不要になる可能性が高い——本番の判断材料には使わない。
 *
 * `component` は React コンポーネントのエクスポート名（決定17）。実体への解決は
 * UI側（`packages/banto-web/src/views/registry.tsx`）が行い、ホストは React に依存しない。
 */

import { Type } from "typebox";
import type { CanvasViewSpec } from "./canvas.js";

export const demoCanvasViews: CanvasViewSpec[] = [
  {
    kind: "demo.hello",
    title: "テスト用GUI",
    description:
      "キャンバス機構の動作確認用の最小GUI。渡した params をそのまま表示する。" +
      "POに『キャンバスの動作を見たい』と言われたときや、表示経路の確認に使う。",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "画面に渡す任意のメッセージ" })),
    }),
    component: "DemoHello",
    category: "demo",
    icon: "🧪",
  },
  {
    kind: "demo.clock",
    title: "時計",
    description:
      "1秒ごとに更新される時計。タブの切り替えが効いているか、描画が生きているかの確認に使う。",
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: "見出しに出す名前" })),
    }),
    component: "DemoClock",
    category: "demo",
    icon: "🕐",
  },
];
