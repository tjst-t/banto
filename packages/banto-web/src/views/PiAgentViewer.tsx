/**
 * pi.agent 設定ビューア（task-0050）。
 *
 * pi coding agent の接続情報を表示・編集するキャンバスビュー。
 *
 * 表示内容：
 *   - auth.json: API キー（マスク表示）
 *   - models.json: providers の一覧（名前、baseUrl、models）
 *   - settings.json: llm.provider / llm.model（編集可能）
 *
 * 編集：
 *   - provider, model の変更を GUI 上で行い、settings.json に保存
 */

import { useEffect, useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
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
  llm: { provider?: string; model?: string };
}

/** キーの表示状態（マスク/展開） */
type KeyVisibility = Record<string, boolean>;

export function PiAgentViewer({ endpoint }: CanvasViewProps): React.ReactElement {
  const describe = useModuleTool<PiAgentData>(endpoint, "pi.agent.describe");
  const data = describe.data;

  // 入力中のドラフト状態
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  // キーの表示切替
  const [keyVisibility, setKeyVisibility] = useState<KeyVisibility>({});

  // データ取得時に入力を初期化
  useEffect(() => {
    if (data) {
      setProvider(data.llm?.provider ?? "");
      setModel(data.llm?.model ?? "");
    }
  }, [data?.llm?.provider, data?.llm?.model]);

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

  // 保存実行
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await callModuleTool<{ llm: { provider?: string; model?: string } }>(
        endpoint,
        "pi.agent.update",
        { provider: provider || undefined, model: model || undefined }
      );
      setNotice(`保存しました: ${result.llm.provider ?? "?"}/${result.llm.model ?? "?"}`);
      describe.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (describe.loading && !data) {
    return <div className="pa-loading">読み込み中…</div>;
  }

  if (describe.error) {
    return <div className="fb-error">読み込めません: {describe.error}</div>;
  }

  // data が undefined なら空配列で描画（ガード済みだが型アサーション）
  const safeData = data ?? { auth: [], providers: [], llm: {} };

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

      {/* 設定値セクション（編集可能） */}
      <section className="pa-section pa-edit">
        <h3 className="pa-title">
          <span className="pa-icon">⚙️</span> 設定値
          <span className="pa-badge">settings.json</span>
        </h3>

        <div className="pa-fields">
          <label className="pa-field">
            <span className="pa-label">プロバイダ</span>
            <input
              className="pa-input"
              type="text"
              value={provider}
              placeholder="opencode"
              onChange={(e) => setProvider(e.target.value)}
            />
          </label>

          <label className="pa-field">
            <span className="pa-label">モデル</span>
            <input
              className="pa-input"
              type="text"
              value={model}
              placeholder="deepseek-v4-flash-free"
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
        </div>

        {/* 現在値のプレビュー */}
        {safeData.llm && (
          <div className="pa-preview">
            現在: <code>{safeData.llm.provider ?? "—"}</code> /{" "}
            <code>{safeData.llm.model ?? "—"}</code>
          </div>
        )}

        {/* 入力中のドラフト値のプレビュー */}
        <div className="pa-preview pa-draft">
          変更後: <code>{provider || "—"}</code> / <code>{model || "—"}</code>
        </div>

        {notice && <div className="rm-notice">{notice}</div>}
        {error && <div className="fb-error">{error}</div>}

        <div className="pa-actions">
          <button className="pp-approve" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存する"}
          </button>
        </div>
      </section>
    </div>
  );
}
