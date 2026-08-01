/**
 * テスト用のキャンバスGUI その2（task-0013 a4）。
 * タブの切り替えが効いているかを見るための、2つ目の種別。
 */

import { useEffect, useState } from "react";
import type { CanvasViewProps } from "./registry.js";

export function DemoClock({ params }: CanvasViewProps): React.ReactElement {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const label = typeof params["label"] === "string" ? params["label"] : "現在時刻";

  return (
    <div className="demo-view">
      <h2 className="demo-title">{label}</h2>
      <p className="demo-lead">1秒ごとに更新されます。タブを切り替えても動き続けます。</p>
      <div className="demo-clock">{now.toLocaleTimeString("ja-JP")}</div>
    </div>
  );
}
