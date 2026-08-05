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

import { useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Button,
  Card,
  Disclosure,
  EmptyState,
  ErrorNote,
  Loading,
  Note,
  Scroll,
  SectionHead,
  TextInput,
  ViewBar,
  ViewShell,
  ViewTitle,
  formatRelative,
  useAction,
  useTicker,
} from "./ui.js";

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
  const action = useAction();
  /** 要求ごとに、POが範囲を狭めて許すための編集欄。 */
  const [edited, setEdited] = useState<Record<string, string>>({});
  const now = useTicker(30_000);

  const act = (key: string, tool: string, args: Record<string, unknown>): void => {
    void action.run(key, async () => {
      await callModuleTool(endpoint, tool, args);
      list.reload();
    });
  };

  const pending = list.data?.pending ?? [];
  const grants = Object.entries(list.data?.grants ?? {}).sort(([a], [b]) =>
    a === focusPlace ? -1 : b === focusPlace ? 1 : a.localeCompare(b)
  );
  const decided = (list.data?.requests ?? []).filter((r) => r.state !== "pending");

  return (
    <ViewShell className="pp">
      <ViewBar>
        <ViewTitle icon="🔐" count={pending.length}>
          書き込み許可
        </ViewTitle>
        <span className="cv-spacer" />
        <Button small variant="ghost" onClick={() => list.reload()} title="取り直す">
          ⟳
        </Button>
      </ViewBar>

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}
      {action.error && <ErrorNote onRetry={action.clearError}>{action.error}</ErrorNote>}

      <Scroll>
        <SectionHead count={pending.length}>番頭からの要求</SectionHead>
        {list.loading && !list.data ? (
          <Loading rows={3} />
        ) : pending.length === 0 ? (
          <EmptyState icon="✓" title="待っている要求はありません">
            番頭が書きたい場所を見つけると、ここに要求が積まれます。
          </EmptyState>
        ) : (
          <div className="cv-cards">
            {pending.map((request) => {
              const value = edited[request.id] ?? request.patterns.join(", ");
              const patterns = value
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
              const broad = patterns.some((p) => BROAD.has(p));
              return (
                <Card key={request.id} tone={broad ? "warn" : undefined}>
                  <div className="st-card-head">
                    <Badge tone="accent">{request.placeId}</Badge>
                    <span className="cv-spacer" />
                    <span className="cv-muted">{formatRelative(request.requestedAt, now)}</span>
                  </div>
                  <div className="st-text">{request.reason}</div>

                  <label className="pp-field">
                    許す範囲（コンマ区切りの glob。狭めてから許してよい）
                    <TextInput
                      value={value}
                      onChange={(e) =>
                        setEdited((prev) => ({ ...prev, [request.id]: e.target.value }))
                      }
                    />
                  </label>
                  {/* 番頭が頼んだ形へ戻せるようにする（狭めすぎて分からなくなったとき） */}
                  {value !== request.patterns.join(", ") && (
                    <div className="pp-patterns">
                      <Button
                        small
                        variant="ghost"
                        onClick={() =>
                          setEdited((prev) => ({ ...prev, [request.id]: request.patterns.join(", ") }))
                        }
                      >
                        頼まれた範囲に戻す（{request.patterns.join(", ")}）
                      </Button>
                    </div>
                  )}
                  {broad && (
                    <Note tone="warn" icon="⚠">
                      この範囲はリポジトリ全体に及びます（.git/ と Banto 自身のデータ置き場は除く）。
                    </Note>
                  )}

                  <div className="pp-actions">
                    <Button
                      variant="ok"
                      disabled={action.busy === request.id || patterns.length === 0}
                      onClick={() =>
                        act(request.id, "place.approve_write", { requestId: request.id, patterns })
                      }
                    >
                      {action.busy === request.id ? "…" : "この範囲で許す"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={action.busy === request.id}
                      onClick={() => act(request.id, "place.deny_write", { requestId: request.id })}
                    >
                      断る
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <SectionHead count={grants.length}>いま許している範囲</SectionHead>
        {grants.length === 0 ? (
          <p className="cv-muted" style={{ padding: "0 2px 8px" }}>
            承認で与えた許可はありません（起動時の設定で与えた範囲はここには出ません）。
          </p>
        ) : (
          <div className="cv-cards">
            {grants.map(([placeId, patterns]) => (
              <Card key={placeId} tone={patterns.some((p) => BROAD.has(p)) ? "warn" : undefined}>
                <div className="st-card-head">
                  <strong>{placeId}</strong>
                </div>
                <div className="pp-patterns">
                  {patterns.map((pattern) => (
                    <span key={pattern} className={`pp-tag ${BROAD.has(pattern) ? "is-broad" : ""}`}>
                      <code>{pattern}</code>
                      <button
                        title="この許可を取り消す"
                        aria-label={`${placeId} の ${pattern} を取り消す`}
                        disabled={action.busy === `${placeId}:${pattern}`}
                        onClick={() =>
                          act(`${placeId}:${pattern}`, "place.revoke_write", {
                            place: placeId,
                            pattern,
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}

        {decided.length > 0 && (
          <>
            <SectionHead count={decided.length}>これまでの判断</SectionHead>
            <Disclosure summary="許可・却下の履歴を見る">
              <ul className="pp-history">
                {decided.map((request) => (
                  <li key={request.id}>
                    <Badge tone={request.state === "approved" ? "ok" : "neutral"}>
                      {request.state === "approved" ? "許可" : "却下"}
                    </Badge>
                    <span>{request.placeId}</span>
                    <code className="cv-mono">
                      {(request.grantedPatterns ?? request.patterns).join(", ")}
                    </code>
                    {request.note && <span className="cv-muted">{request.note}</span>}
                    <span className="cv-spacer" />
                    <span className="cv-muted">{formatRelative(request.decidedAt, now)}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </>
        )}
      </Scroll>
    </ViewShell>
  );
}
