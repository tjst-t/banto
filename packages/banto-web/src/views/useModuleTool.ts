/**
 * キャンバスGUIが、自分を提供しているモジュールのデータAPIから情報を取るためのフック
 * （ADR-0010 決定25）。
 *
 * 決定25：人はGUI→モジュールのデータAPI、番頭はモジュールのTool→モジュール。
 * **UIは番頭のToolを呼ばない**——同じTool契約だが経路が違う。到達先は props の
 * `endpoint`（モジュールの登録情報由来）で、コンポーネントに直書きしない。
 */

import { useCallback, useEffect, useState } from "react";
import { MODULE_TOOL_PATH, type ModuleToolResult } from "@banto/core/module-protocol";

export interface ModuleToolState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  /** 同じ引数で取り直す。 */
  reload(): void;
}

/**
 * モジュールのToolを呼び、`details`（構造化データ）を返す。
 *
 * 引数が変わったら取り直す。オブジェクトは毎レンダーで別参照になるため、依存は
 * シリアライズした内容で判定する——`useState` の初期値に取り込むと、2回目以降の
 * 引数変更が無視される（実際にその不具合を踏んだ）。
 *
 * @param endpoint モジュールへの到達先。相対パスなら自分のオリジンに解決される
 * @param toolName 論理Tool名（例 `file.list`）
 * @param args Tool へ渡す引数。変わるたびに取り直す
 * @param enabled false のあいだは呼ばない（前段の結果を待つときに使う）
 */
export function useModuleTool<T>(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown> = {},
  enabled = true
): ModuleToolState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const url = `${endpoint.replace(/\/$/, "")}${MODULE_TOOL_PATH}${encodeURIComponent(toolName)}`;

    setLoading(true);
    setError(undefined);

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: argsKey === "{}" ? JSON.stringify({ args: {} }) : `{"args":${argsKey}}`,
    })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => ({}));
        // I2: 失敗を黙って「データなし」にしない。理由を画面に出す
        if (!res.ok) {
          const message = (body as { error?: string }).error ?? res.statusText;
          throw new Error(message);
        }
        return (body as ModuleToolResult).details as T;
      })
      .then((details) => {
        if (!cancelled) setData(details);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // argsKey は args の内容。参照ではなく内容で再取得を判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps -- args は argsKey で代表させている
  }, [endpoint, toolName, argsKey, reloadToken, enabled]);

  return {
    data,
    error,
    loading,
    reload: useCallback(() => setReloadToken((n) => n + 1), []),
  };
}
