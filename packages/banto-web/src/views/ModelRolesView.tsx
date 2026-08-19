/**
 * 「役割とモデル」統合表（ADR-0021 の続き・2026-08-19 提案 model-roles-module-offer）。
 *
 * 行＝役割（番頭 / 職人・等級 / 工場などモジュールの役）、欄＝いま効いている / 出所 / 設定。
 * 値と選択肢は区画の read() が構造化した `_rolesTable` を受け取り、変更は設定画面の口
 * （settings.update）で保存する（D5：判断は持たない。描くだけ）。
 *
 * モジュールが `modelRoles` で宣言した役は、この表に自動で並ぶ——Kobo の executor /
 * rework / audit、将来のモジュールの役も同じ行として現れる。
 */

import { useState } from "react";
import type { CanvasViewProps } from "./registry.js";
import { Button, ErrorNote, Note, ViewBar, ViewShell } from "./ui.js";

interface RoleRow {
  key: string;
  label: string;
  origin: string;
  tierDependent: boolean;
  binding: string;
  effective: string;
  source: "override" | "tier" | "fallback" | "none";
  options: Array<{ value: string; label: string }>;
}

const SOURCE_LABELS: Record<RoleRow["source"], string> = {
  override: "上書き（名指し）",
  tier: "等級既定",
  fallback: "バックエンド既定",
  none: "未指定",
};

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

      <div className="roles-grid">
        {rows.length === 0 && (
          <div className="cv-muted">役の一覧を読み込めませんでした（区画の read を確認してください）。</div>
        )}
        {rows.map((row) => (
          <div key={row.key} className="roles-row">
            <div className="roles-cell roles-role">
              <div className="roles-role-name">{row.label}</div>
              {row.origin !== "core" && <div className="roles-origin">（{row.origin}）</div>}
              {row.tierDependent && <div className="roles-hint">タスクの等級に従う</div>}
            </div>
            <div className="roles-cell roles-effective">
              <div className="roles-effective-value">{row.effective}</div>
              <div className="roles-source">{SOURCE_LABELS[row.source]}</div>
            </div>
            <div className="roles-cell roles-select">
              <select
                className="sp-input"
                value={row.binding}
                disabled={busy}
                aria-label={`${row.label}のモデル`}
                onChange={(e) => void save(row.key, e.target.value)}
              >
                {row.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </ViewShell>
  );
}
