/**
 * デモモジュール（組み込み・task-0013 a4）。
 *
 * キャンバス機構が動いていることを目で確かめるためのテスト用GUIを提供する。
 * 基本GUIセットの実物（task-0016 以降）が揃ったら不要になる見込み——本番の判断材料には
 * 使わない。モジュール登録機構そのものの検証にも使える最小のモジュール。
 */

import { demoCanvasViews } from "../demo-views.js";
import type { BantoModule } from "../module.js";

export function createDemoModule(): BantoModule {
  return {
    name: "demo",
    title: "デモ",
    description: "キャンバス機構の動作確認用のテストGUI。実物が揃ったら外す。",
    // 表示だけのモジュールでデータ取得を伴わないため、ホスト自身を指す
    endpoint: { baseUrl: "/api/demo" },
    tools: [],
    views: demoCanvasViews,
    skills: [],
  };
}
