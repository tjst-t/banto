/**
 * pi.agent 設定ビューア（task-0050）。
 *
 * pi coding agent の接続情報を**表示するだけ**のキャンバスビュー。
 *
 * 表示内容：
 *   - auth.json: API キー（マスク表示）
 *   - models.json: providers の一覧（名前、baseUrl、models）
 *
 * **モデルの選択はここに置かない**（PO裁定 2026-08-04）。置き場所は「LLM・モデル」
 * ひとつだけ——同じものを2箇所から決められると、どちらが効いているのか分からなくなる。
 */

import { useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

/** auth.json のキーエントリ */
interface AuthKey {
  name: string;
  type: string;
  key: string;
  masked: string;
}

/** models.json のプロバイダエントリ */
interface ProviderEntry {
  name: string;
  baseUrl: string;
  modelCount: number;
  models: Array<{ id: string; name?: string }>;
}

/** pi.agent.describe の返却データ */
interface PiAgentData {
  auth: AuthKey[];
  providers: ProviderEntry[];
}

/** キーの表示状態（マスク/展開） */
type KeyVisibility = Record<string, boolean>;

export function PiAgentViewer({ endpoint }: CanvasViewProps): React.ReactElement {
  const describe = useModuleTool<PiAgentData>(endpoint, "pi.agent.describe");
  const data = describe.data;

  // キーの表示切替
  const [keyVisibility, setKeyVisibility] = useState<KeyVisibility>({});

  // 全キーの表示/非表示を切り替え
  const toggleAllKeys = (): void => {
    const allVisible = data?.auth.every((k) => keyVisibility[k.name]);
    const next: KeyVisibility = {};
    data?.auth.forEach((k) => {
      next[k.name] = allVisible ? false : true;
    });
    setKeyVisibility(next);
  };

  // 個別キーの表示/非表示
  const toggleKey = (name: string): void => {
    setKeyVisibility((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  if (describe.loading && !data) {
    return <div className="pa-loading">読み込み中…</div>;
  }

  if (describe.error) {
    return <div className="fb-error">読み込めません: {describe.error}</div>;
  }

  // data が undefined なら空配列で描画（ガード済みだが型アサーション）
  const safeData = data ?? { auth: [], providers: [] };

  return (
    <div className="pa">
      {/* API キーセクション */}
      <section className="pa-section">
        <div className="pa-section-head">
          <h3 className="pa-title">
            <span className="pa-icon">🔑</span> API キー
            <span className="pa-badge">auth.json</span>
          </h3>
          {safeData.auth.length > 0 && (
            <button className="pa-toggle-all" onClick={toggleAllKeys} title="全キーの表示切替">
              {Object.values(keyVisibility).every(Boolean) ? "すべてマスク" : "すべて表示"}
            </button>
          )}
        </div>
        {safeData.auth.length === 0 ? (
          <p className="fb-muted pa-empty">auth.json が見つかりません</p>
        ) : (
          <ul className="pa-keys">
            {safeData.auth.map((k) => {
              const visible = keyVisibility[k.name] ?? false;
              return (
                <li key={k.name} className={`pa-key ${visible ? "pa-key-visible" : ""}`}>
                  <span className="pa-key-name">{k.name}</span>
                  <span className="pa-key-type">{k.type}</span>
                  <span
                    className="pa-key-value"
                    onClick={() => toggleKey(k.name)}
                    title="クリックで表示切替"
                  >
                    {visible ? k.key : k.masked}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* プロバイダ一覧セクション */}
      <section className="pa-section">
        <h3 className="pa-title">
          <span className="pa-icon">📡</span> プロバイダ
          <span className="pa-badge">models.json</span>
        </h3>
        {safeData.providers.length === 0 ? (
          <p className="fb-muted pa-empty">models.json が見つかりません</p>
        ) : (
          <div className="pa-providers">
            {safeData.providers.map((p) => (
              <div key={p.name} className="pa-provider">
                <div className="pa-provider-header">
                  <span className="pa-provider-name">{p.name}</span>
                  <span className="pa-provider-count">{p.modelCount} モデル</span>
                </div>
                <code className="pa-provider-url">{p.baseUrl}</code>
                {p.models.length > 0 && (
                  <ul className="pa-models">
                    {p.models.map((m) => (
                      <li key={m.id} className="pa-model">
                        <span className="pa-model-id">{m.id}</span>
                        {m.name && <span className="pa-model-name">({m.name})</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/*
        モデルの指定はここには置かない（PO裁定 2026-08-04）。
        **置き場所は「LLM・モデル」ひとつだけ**——同じものを2箇所から決められると、
        どちらが効いているのか分からなくなる。ここは接続情報の表示に徹する。
      */}
      <section className="pa-section">
        <h3 className="pa-title">
          <span className="pa-icon">⚙️</span> モデルの選択
        </h3>
        <p className="pa-empty">
          番頭が使うモデルは「LLM・モデル」で選びます（会話ごとの切替はチャットの入力欄から）。
        </p>
      </section>
    </div>
  );
}
