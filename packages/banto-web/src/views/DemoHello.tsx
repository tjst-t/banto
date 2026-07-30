/**
 * テスト用のキャンバスGUI（task-0013 a4）。
 *
 * キャンバス機構が正しく動いているかを目で確かめるためのもの：
 *   - canvas.open で渡した params がそのまま表示される
 *   - カウンタが動く＝静的なHTMLではなく生きたReactコンポーネントとして描かれている
 */

import { useState } from "react";
import type { CanvasViewProps } from "./registry.js";

export function DemoHello({ params, tabId, kind, module, endpoint }: CanvasViewProps): React.ReactElement {
  const [count, setCount] = useState(0);

  return (
    <div className="demo-view">
      <h2 className="demo-title">テスト用GUI</h2>
      <p className="demo-lead">
        キャンバス機構の動作確認用。番頭が <code>canvas.open</code> で渡したパラメータを、そのまま表示します。
      </p>

      <dl className="demo-meta">
        <dt>kind</dt>
        <dd><code>{kind}</code></dd>
        <dt>tabId</dt>
        <dd><code>{tabId}</code></dd>
        <dt>module</dt>
        <dd><code>{module}</code></dd>
        <dt>endpoint</dt>
        <dd><code>{endpoint || "(なし)"}</code></dd>
      </dl>

      <h3 className="demo-subtitle">受け取った params</h3>
      <pre className="demo-params">{JSON.stringify(params, null, 2)}</pre>

      <h3 className="demo-subtitle">生きたコンポーネントであることの確認</h3>
      <button className="demo-btn" onClick={() => setCount((c) => c + 1)}>
        クリック回数: {count}
      </button>
    </div>
  );
}
