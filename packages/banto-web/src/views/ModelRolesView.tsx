/**
 * 「役割とモデル」統合表（ADR-0021 の続き・2026-08-19 提案 model-roles-module-offer）。
 *
 * 3列: **役割｜モデル指定｜割り当てモデル**。
 * - モデル指定: この役にモデルを明示するか「継承（上位の設定に従う）」を選ぶ
 * - 割り当てモデル: 指定があればそのモデル、継承なら上（等級既定/バックエンド既定）の解決結果
 *
 * 行と値・選択肢は区画の read() が構造化した `_rolesTable` を受け取り、変更は設定画面の口
 * （settings.update）で保存する（D5：判断は持たない。描くだけ）。
 * 並び順は区画側が「番頭 → 職人 → 工場」に揃えている。
 */

import { useState } from "react";
import type { CanvasViewProps } from "./registry.js";
import { Button, ErrorNote, Note, ViewBar, ViewShell } from "./ui.js";

interface RoleRow {
  key: string;
  group: string;
  label: string;
  tierDependent: boolean;
  value: string;
  effective: string;
  note: string;
  options: Array<{ value: string; label: string }>;
  thinking: string;
  thinkingOptions: Array<{ value: string; label: string }>;
}

export function ModelRolesView(props: CanvasViewProps): React.ReactElement {
  const bridge = props.settings;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  if (!bridge) {
    return (
      <ErrorNote title="この面は設定の区画として開きます">
        「役割とモデル」は設定画面から開いてください（キャンバスの面ではありません）。
      </ErrorNote>
    );
  }

  const rows = (bridge.values["_rolesTable"] ?? []) as RoleRow[];

  const save = async (key: string, value: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const message = await bridge.save({ [key]: value });
      setNotice(message ?? "変えました。次に起こす職人から効きます。");
    } catch (err) {
      // I2: 保存できなかったのに保存したように見せない
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ViewShell className="roles-view">
      <ViewBar>
        <span className="llm-sec-label">
          役割とモデル — 優先順位: ①上書き（名指し） ②等級既定 ③バックエンド既定
        </span>
        <span className="cv-spacer" />
        <Button small variant="ghost" disabled={bridge.busy} onClick={() => bridge.reload()}>
          ⟳ 読み直す
        </Button>
      </ViewBar>

      {error && <ErrorNote onRetry={() => setError(undefined)}>{error}</ErrorNote>}
      {notice && <Note tone="ok">{notice}</Note>}

      <div className="roles-table-scroll">
        <table className="roles-table">
          <thead>
            <tr>
              <th className="roles-th-role">役割</th>
              <th>モデル指定</th>
              <th>思考レベル</th>
              <th>割り当てモデル</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="cv-muted">
                  役の一覧を読み込めませんでした（区画の read を確認してください）。
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="roles-td-role">
                  <div className="roles-role-name">{row.label}</div>
                  {row.tierDependent && <span className="roles-hint">タスクの等級に従う</span>}
                </td>
                <td>
                  <select
                    className="sp-input"
                    value={row.value}
                    disabled={busy}
                    aria-label={`${row.label}のモデル指定`}
                    onChange={(e) => void save(row.key, e.target.value)}
                  >
                    {row.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="sp-input"
                    value={row.thinking}
                    disabled={busy}
                    aria-label={`${row.label}の思考レベル`}
                    onChange={(e) => void save(`${row.key}.thinking`, e.target.value)}
                  >
                    {(row.thinkingOptions ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="roles-effective">{row.effective}</div>
                  <div className="roles-note">{row.note}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ViewShell>
  );
}
