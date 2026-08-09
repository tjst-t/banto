/**
 * 場所と書き込み許可（中核の設定区画・ADR-0011 決定43 の枠、決定74・75）。
 *
 * **かつては2箇所にあった。** 設定の「場所」で `id:/path:glob` を書け、キャンバスの
 * 「書き込み許可」の面でも承認・取り消しができた——同じことを2つの入口で決められる状態で、
 * どちらが効いているのか分からなかった（PO報告 2026-08-09「かぶっている」）。
 * **場所と、そこで書ける範囲は同じ1つの設定**なので、ここへ寄せた。
 *
 * その場の判断はここへ来なくてもできる（決定73）——番頭が頼むと取次に判断待ちが積まれ、
 * POは会話の横のボタンで許せる。この面は「範囲を狭めたい」「共通で許したい」
 * 「広げすぎたのを戻したい」ときの場所。
 *
 * **番頭はこの口を呼べない。** 承認・拒否・取り消し・共通の許可はすべて internalTools で、
 * 番頭の Tool 一覧には出ない（決定29e と同じ枠）。約束ではなく機構で分けている（I1）。
 *
 * 決定38e: 「じわじわ広がる」ことは機構では防げない。だから**いま何が許されていて、
 * それがどこから来たのか**を1画面に出すことが対策そのもの。
 */

import { useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import { Icon } from "../icons.js";
import {
  Badge,
  Button,
  Card,
  Disclosure,
  EmptyState,
  ErrorNote,
  Loading,
  Note,
  SectionHead,
  TextInput,
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

interface PlaceInfo {
  id: string;
  label: string;
  path: string;
  /** いま実際に書ける範囲（設定＋承認＋共通を重ねたもの）。 */
  writable: string[];
}

interface GrantsView {
  requests: GrantRequest[];
  pending: GrantRequest[];
  /** 場所 id → 承認で与えた範囲。 */
  grants: Record<string, string[]>;
  /** どの場所でも許している範囲。 */
  global: string[];
  places: PlaceInfo[];
}

/** 設定画面が配る区画の姿（`settings.describe` の一部）。場所の一覧の編集に使う。 */
interface SettingsDescription {
  sections: Array<{ id: string; values: Record<string, unknown> }>;
  storedAt: string;
}

/** 広すぎる範囲。許すこと自体は止めないが、押す前に見えるようにする（決定38e）。 */
const BROAD = new Set(["**", "**/*", "*"]);

/** コンマ区切りの glob を配列に。空白と空要素は落とす。 */
function splitPatterns(value: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function PlaceSettings({ endpointOf }: CanvasViewProps): React.ReactElement {
  // 決定27 のレジストリ方式：URL は直書きせず、モジュール名から到達先を引く
  const workspace = endpointOf("workspace");
  const settingsEndpoint = endpointOf("settings");

  const view = useModuleTool<GrantsView>(
    workspace ?? "",
    "place.list_requests",
    {},
    workspace !== undefined
  );
  const settings = useModuleTool<SettingsDescription>(
    settingsEndpoint ?? "",
    "settings.describe",
    {},
    settingsEndpoint !== undefined
  );
  const action = useAction();
  const now = useTicker(30_000);

  /** 要求ごとの「許す範囲」の編集欄（POが狭めて許せるようにするため）。 */
  const [edited, setEdited] = useState<Record<string, string>>({});
  /** 共通の許可の編集欄。undefined は「触っていない」。 */
  const [globalDraft, setGlobalDraft] = useState<string>();
  /** 場所の一覧（1件1行）の編集欄。undefined は「触っていない」。 */
  const [placesDraft, setPlacesDraft] = useState<string[]>();

  // I2: 到達先が無いことを空の画面にしない。直せるのは配線なので、そう言う
  if (!workspace) {
    return (
      <ErrorNote title="書き込み許可を出せません">
        workspace モジュールが登録されていません（ホストの構成を確認してください）。
      </ErrorNote>
    );
  }

  const data = view.data;
  const pending = data?.pending ?? [];
  const global = data?.global ?? [];
  const places = data?.places ?? [];
  const decided = (data?.requests ?? []).filter((r) => r.state !== "pending");

  const run = (key: string, tool: string, args: Record<string, unknown>): void => {
    void action.run(key, async () => {
      await callModuleTool(workspace, tool, args);
      view.reload();
    });
  };

  /** 設定に保存されている場所の行（`id:/path:glob,glob`）。 */
  const storedLines = ((): string[] => {
    const section = settings.data?.sections.find((s) => s.id === "places");
    const value = section?.values["places"];
    return Array.isArray(value) ? value.map(String) : [];
  })();
  const lines = placesDraft ?? storedLines;

  const savePlaces = (next: string[]): void => {
    if (!settingsEndpoint) return;
    void action.run("places", async () => {
      await callModuleTool(settingsEndpoint, "settings.update", {
        section: "places",
        values: { places: next.filter((l) => l.trim().length > 0) },
      });
      setPlacesDraft(undefined);
      settings.reload();
      // 場所が変われば「いま書ける範囲」も変わる。両方取り直す（D3：真実はホスト側）
      view.reload();
    });
  };

  return (
    <div className="ps">
      {view.error && <ErrorNote onRetry={view.reload}>{view.error}</ErrorNote>}
      {action.error && <ErrorNote onRetry={action.clearError}>{action.error}</ErrorNote>}

      {/* ── 番頭からの要求 ─────────────────────────────────────────────
          いちばん上に置く。POを待たせているものが他の設定より下にあってはいけない */}
      <SectionHead count={pending.length}>番頭からの要求</SectionHead>
      {view.loading && !data ? (
        <Loading rows={2} />
      ) : pending.length === 0 ? (
        <EmptyState icon="check" title="待っている要求はありません">
          番頭が書きたい場所を見つけると、取次に判断待ちとして積まれます。
          <br />
          その場で許せますが、範囲を狭めたいときはここで決められます。
        </EmptyState>
      ) : (
        <div className="cv-cards">
          {pending.map((request) => {
            const value = edited[request.id] ?? request.patterns.join(", ");
            const patterns = splitPatterns(value);
            const broad = patterns.some((p) => BROAD.has(p));
            const place = places.find((p) => p.id === request.placeId);
            return (
              <Card key={request.id} tone={broad ? "warn" : undefined}>
                <div className="st-card-head">
                  <Badge tone="accent">{place?.label ?? request.placeId}</Badge>
                  <span className="cv-spacer" />
                  <span className="cv-muted">{formatRelative(request.requestedAt, now)}</span>
                </div>
                <div className="st-text">{request.reason}</div>

                <label className="ps-field">
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
                  <div className="ps-tags">
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
                  <Note tone="warn">
                    この範囲はその場所の全体に及びます（.git/ と Banto 自身のデータ置き場は除く）。
                  </Note>
                )}

                <div className="ps-actions">
                  <Button
                    variant="ok"
                    disabled={action.busy === request.id || patterns.length === 0}
                    onClick={() =>
                      run(request.id, "place.approve_write", { requestId: request.id, patterns })
                    }
                  >
                    {action.busy === request.id ? "…" : "この範囲で許す"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action.busy === request.id}
                    onClick={() => run(request.id, "place.deny_write", { requestId: request.id })}
                  >
                    断る
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── 全場所共通の許可（決定74）───────────────────────────────── */}
      <SectionHead>全ての場所で許す範囲</SectionHead>
      <p className="sp-hint ps-lede">
        ここに書いた範囲は<b>登録された全ての場所</b>で書けます（PO裁定 2026-08-09）。
        「どのリポジトリでも <code>docs/**</code> は書いてよい」のように、場所ごとに決める
        意味の無い許可のため。<b>場所ごとの許可に重ねて効きます</b>——ここを消しても、
        その場所に個別に与えた許可は残ります。
      </p>
      <div className="ps-global">
        <TextInput
          value={globalDraft ?? global.join(", ")}
          placeholder="docs/**, work/**"
          onChange={(e) => setGlobalDraft(e.target.value)}
        />
        <Button
          variant="primary"
          disabled={
            action.busy === "global" ||
            globalDraft === undefined ||
            splitPatterns(globalDraft).join(",") === global.join(",")
          }
          onClick={() => {
            const next = splitPatterns(globalDraft ?? "");
            void action.run("global", async () => {
              await callModuleTool(workspace, "place.set_global_write", { patterns: next });
              setGlobalDraft(undefined);
              view.reload();
            });
          }}
        >
          {action.busy === "global" ? "…" : "保存する"}
        </Button>
        {globalDraft !== undefined && (
          <Button variant="ghost" onClick={() => setGlobalDraft(undefined)}>
            やめる
          </Button>
        )}
      </div>
      {splitPatterns(globalDraft ?? global.join(", ")).some((p) => BROAD.has(p)) && (
        <Note tone="warn">
          この範囲は<b>全ての場所の全体</b>に及びます。書けない場所が1つも無くなります。
        </Note>
      )}

      {/* ── 場所ごとの姿 ─────────────────────────────────────────────
          「いま書ける範囲」と「それがどこから来たか」を並べる（決定38e） */}
      <SectionHead count={places.length}>場所ごとに書ける範囲</SectionHead>
      {places.length === 0 ? (
        <p className="cv-muted">登録されている場所がありません。</p>
      ) : (
        <div className="cv-cards">
          {places.map((place) => {
            const approved = data?.grants[place.id] ?? [];
            // 実効値から「承認で与えた分」と「共通の分」を引いた残りが設定由来
            const fromSettings = place.writable.filter(
              (p) => !approved.includes(p) && !global.includes(p)
            );
            const readOnly = place.writable.length === 0;
            return (
              <Card key={place.id} tone={place.writable.some((p) => BROAD.has(p)) ? "warn" : undefined}>
                <div className="st-card-head">
                  <strong>{place.label}</strong>
                  <Badge>{place.id}</Badge>
                  <span className="cv-spacer" />
                  {readOnly && <span className="cv-muted">読み取り専用</span>}
                </div>
                <code className="cv-mono ps-path">{place.path}</code>
                {!readOnly && (
                  <div className="ps-tags">
                    {fromSettings.map((pattern) => (
                      <span key={`s:${pattern}`} className={`ps-tag ${BROAD.has(pattern) ? "is-broad" : ""}`}>
                        <code>{pattern}</code>
                        <em>設定</em>
                      </span>
                    ))}
                    {approved.map((pattern) => (
                      <span key={`a:${pattern}`} className={`ps-tag ${BROAD.has(pattern) ? "is-broad" : ""}`}>
                        <code>{pattern}</code>
                        <em>承認</em>
                        <button
                          title="この許可を取り消す"
                          aria-label={`${place.label} の ${pattern} を取り消す`}
                          disabled={action.busy === `${place.id}:${pattern}`}
                          onClick={() =>
                            run(`${place.id}:${pattern}`, "place.revoke_write", {
                              place: place.id,
                              pattern,
                            })
                          }
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </span>
                    ))}
                    {global
                      .filter((p) => place.writable.includes(p))
                      .map((pattern) => (
                        <span key={`g:${pattern}`} className={`ps-tag is-global ${BROAD.has(pattern) ? "is-broad" : ""}`}>
                          <code>{pattern}</code>
                          <em>共通</em>
                        </span>
                      ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── 場所そのものの足し引き ───────────────────────────────────
          ghq / gwq が見つけるリポジトリは自動で並ぶので、ここに書くのは
          「明示的に足したい場所」だけ。畳んでおく（毎回触るものではない） */}
      <SectionHead>場所を足す・書き換える</SectionHead>
      {settingsEndpoint === undefined ? (
        <Note tone="warn">設定モジュールが登録されていないため、場所の一覧は編集できません。</Note>
      ) : (
        <Disclosure summary={`設定で足している場所（${storedLines.length}）を編集する`}>
          <p className="sp-hint">
            1件1行。<code>id:/絶対パス</code> で読み取り専用、
            <code>id:/絶対パス:glob,glob</code> でその範囲だけ書き込み可。
            <code>.git/</code> と Banto のデータ置き場はどう書いても書けません。
            まだ保存していないときは<b>起動時の指定（BANTO_PLACES）がそのまま出ます</b>。
            <code>desk</code>（成果物の置き場所）は既定で必ずあり、消しても
            <code>~/banto-desk</code> に戻ります。
          </p>
          <div className="sp-rows">
            {lines.map((line, index) => (
              <div className="sp-row" key={index}>
                <input
                  className="sp-input sp-row-input"
                  value={line}
                  placeholder="banto:/home/you/ghq/github.com/you/repo:docs/**"
                  spellCheck={false}
                  onChange={(e) =>
                    setPlacesDraft(lines.map((v, i) => (i === index ? e.target.value : v)))
                  }
                />
                <button
                  className="sp-row-remove"
                  type="button"
                  title="この行を消す"
                  onClick={() => setPlacesDraft(lines.filter((_, i) => i !== index))}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            ))}
            <button
              className="sp-row-add"
              type="button"
              onClick={() => setPlacesDraft([...lines, ""])}
            >
              <Icon name="plus" size={14} /> 追加
            </button>
          </div>
          <div className="ps-actions">
            <Button
              variant="primary"
              disabled={placesDraft === undefined || action.busy === "places"}
              onClick={() => savePlaces(lines)}
            >
              {action.busy === "places" ? "保存中…" : "保存する"}
            </Button>
            {placesDraft !== undefined && (
              <Button variant="ghost" onClick={() => setPlacesDraft(undefined)}>
                やめる
              </Button>
            )}
          </div>
          <p className="cv-muted sp-where">
            保存先: <code>{settings.data?.storedAt}</code>
            <br />
            番頭はこの場所に書けません（設定を書き換えて自分の権限を広げられないように）
          </p>
        </Disclosure>
      )}

      {decided.length > 0 && (
        <>
          <SectionHead count={decided.length}>これまでの判断</SectionHead>
          <Disclosure summary="許可・却下の履歴を見る">
            <ul className="ps-history">
              {decided.map((request) => (
                <li key={request.id}>
                  <Badge tone={request.state === "approved" ? "ok" : "neutral"}>
                    {request.state === "approved" ? "許可" : "却下"}
                  </Badge>
                  <span>{places.find((p) => p.id === request.placeId)?.label ?? request.placeId}</span>
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
    </div>
  );
}
