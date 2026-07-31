/**
 * 書き込み許可のパネル（workspace モジュール提供・ADR-0010 決定38c・e・task-0042）。
 *
 * 番頭からの「ここに書かせてほしい」をPOがその場で裁く画面。番頭が `canvas.open` で
 * 出せるので、会話の流れの中で承認が起きる。
 *
 * **番頭はこの画面の口を呼べない。** 承認・拒否・取り消しは internalTools で、
 * 番頭のTool一覧には出ない（決定29e と同じ枠）。約束ではなく機構で分けている（I1）。
 *
 * 現在の許可を同じ画面に出しているのは決定38(e) のため——「じわじわ広がる」ことは
 * 機構では防げないので、**見えるようにする**のが対策そのもの。
 */

import { useCallback, useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

interface GrantRequest {
  id: string;
  placeId: string;
  patterns: string[];
  reason: string;
  requestedAt: string;
  state: "pending" | "approved" | "denied";
  decidedAt?: string;
  grantedPatterns?: string[];
  note?: string;
}

interface RequestList {
  requests: GrantRequest[];
  pending: GrantRequest[];
  grants: Record<string, string[]>;
}

/** 広すぎる範囲。許すこと自体は止めないが、押す前に見えるようにする（決定38e）。 */
const BROAD = new Set(["**", "**/*", "*"]);

export function PlacePermissions({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const focusPlace = typeof params["place"] === "string" ? params["place"] : undefined;
  const list = useModuleTool<RequestList>(endpoint, "place.list_requests");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  /** 要求ごとに、POが範囲を狭めて許すための編集欄。 */
  const [edited, setEdited] = useState<Record<string, string>>({});

  const act = useCallback(
    async (key: string, tool: string, args: Record<string, unknown>) => {
      setBusy(key);
      setError(undefined);
      try {
        await callModuleTool(endpoint, tool, args);
        list.reload();
      } catch (err) {
        // I2: 押したのに何も起きなかったように見せない
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    },
    [endpoint, list]
  );

  const pending = list.data?.pending ?? [];
  const grants = Object.entries(list.data?.grants ?? {}).sort(([a], [b]) =>
    a === focusPlace ? -1 : b === focusPlace ? 1 : a.localeCompare(b)
  );
  const decided = (list.data?.requests ?? []).filter((r) => r.state !== "pending");

  return (
    <div className="st">
      <div className="st-head">
        <span className="st-title">書き込み許可</span>
        <span className="gv3-count">{pending.length}</span>
        <button className="gv3-clear" onClick={() => list.reload()}>
          取り直す
        </button>
      </div>

      {(list.error || error) && <div className="fb-error">{list.error ?? error}</div>}

      <section className="pp-section">
        <h3 className="pp-heading">番頭からの要求</h3>
        {pending.length === 0 ? (
          <p className="fb-muted st-empty">{list.loading ? "読み込み中…" : "保留中の要求はありません"}</p>
        ) : (
          <ul className="pp-list">
            {pending.map((request) => {
              const value = edited[request.id] ?? request.patterns.join(", ");
              const patterns = value.split(",").map((p) => p.trim()).filter(Boolean);
              const broad = patterns.some((p) => BROAD.has(p));
              return (
                <li key={request.id} className="pp-item">
                  <div className="pp-place">{request.placeId}</div>
                  <div className="pp-reason">{request.reason}</div>
                  <label className="pp-field">
                    許す範囲
                    <input
                      value={value}
                      onChange={(e) => setEdited((prev) => ({ ...prev, [request.id]: e.target.value }))}
                      spellCheck={false}
                    />
                  </label>
                  {broad && (
                    <div className="pp-warn">
                      この範囲はリポジトリ全体に及びます（.git/ とBanto自身のデータ置き場は除く）
                    </div>
                  )}
                  <div className="pp-actions">
                    <button
                      className="pp-approve"
                      disabled={busy === request.id || patterns.length === 0}
                      onClick={() => act(request.id, "place.approve_write", { requestId: request.id, patterns })}
                    >
                      許可する
                    </button>
                    <button
                      className="pp-deny"
                      disabled={busy === request.id}
                      onClick={() => act(request.id, "place.deny_write", { requestId: request.id })}
                    >
                      断る
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="pp-section">
        <h3 className="pp-heading">いま許している範囲</h3>
        {grants.length === 0 ? (
          <p className="fb-muted st-empty">
            承認で与えた許可はありません（起動時の設定で与えた範囲はここには出ません）
          </p>
        ) : (
          <ul className="pp-list">
            {grants.map(([placeId, patterns]) => (
              <li key={placeId} className="pp-item">
                <div className="pp-place">{placeId}</div>
                <div className="pp-grants">
                  {patterns.map((pattern) => (
                    <span key={pattern} className={BROAD.has(pattern) ? "pp-tag pp-tag-broad" : "pp-tag"}>
                      <code>{pattern}</code>
                      <button
                        title="この許可を取り消す"
                        disabled={busy === `${placeId}:${pattern}`}
                        onClick={() =>
                          act(`${placeId}:${pattern}`, "place.revoke_write", { place: placeId, pattern })
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {decided.length > 0 && (
        <section className="pp-section">
          <h3 className="pp-heading">これまでの判断</h3>
          <ul className="pp-history">
            {decided.map((request) => (
              <li key={request.id}>
                <span className={request.state === "approved" ? "pp-ok" : "pp-ng"}>
                  {request.state === "approved" ? "許可" : "却下"}
                </span>{" "}
                {request.placeId} — <code>{(request.grantedPatterns ?? request.patterns).join(", ")}</code>
                {request.note && <span className="fb-muted"> {request.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
