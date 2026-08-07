/**
 * 記憶ビューア（studio モジュール提供・ADR-0010 決定25・28・31、ADR-0003）。
 *
 * 番頭が覚えている事実・好み・習慣を見せる。番頭に記憶があること（D11）が banto の核なので、
 * POが「何を覚えている？」を確かめられる場所が要る。
 *
 * ## ここが担う3つのこと
 *
 * 1. **出所の可視化**（決定28）。抽出した記憶は自動で有効になるので、
 *    「POが言ったこと」と「番頭が会話から拾ったこと」が見分けられないと困る
 * 2. **忘れさせる**（決定28）。誤って覚えたものを PO が消せることが、
 *    自動抽出を PO 確認なしで有効にする条件だった
 * 3. **層の切り替え**（ADR-0003）。人の記憶とプロジェクトの記憶は別物で、混ぜない
 *
 * **有効／訂正済み／忘れたの別はサーバが付ける**（`active`）。同じ規則を画面でもう一度
 * 実装すると割れる（D3/D5）。
 */

import { useEffect, useMemo, useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorNote,
  Loading,
  Scroll,
  SearchField,
  Toggle,
  ViewBar,
  ViewShell,
  ViewTitle,
  formatRelative,
  formatTime,
  useTicker,
  type Tone,
} from "./ui.js";

interface MemoryRecord {
  id: string;
  kind: "preference" | "habit" | "fact";
  text: string;
  createdAt: string;
  /** 出所（決定28）。省略は explicit と同じ扱い（この欄が無かった頃の記憶） */
  origin?: "explicit" | "extracted";
  /** 世界で真になった時刻（記録した時刻とは別軸） */
  validFrom?: string;
  refs?: string[];
  supersedes?: string;
  /** 「忘れた」ことを表す記録なら、忘れた記憶のID */
  forgets?: string;
  reason?: string;
  /** いま有効か。サーバが導出して付ける（画面で導出しない） */
  active?: boolean;
}
interface MemoryList {
  records: MemoryRecord[];
  scope: "person" | "project";
  place?: string;
}
interface ScopeList {
  places: Array<{ id: string; label: string }>;
}

const KINDS: ReadonlyArray<{ key: "" | MemoryRecord["kind"]; label: string; tone: Tone }> = [
  { key: "", label: "すべて", tone: "neutral" },
  { key: "fact", label: "事実", tone: "accent" },
  { key: "preference", label: "好み", tone: "ok" },
  { key: "habit", label: "習慣", tone: "warn" },
];

function toneOf(kind: string): Tone {
  return KINDS.find((k) => k.key === kind)?.tone ?? "neutral";
}
function labelOf(kind: string): string {
  return KINDS.find((k) => k.key === kind)?.label ?? kind;
}

export function MemoryViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialKind = typeof params["kind"] === "string" ? params["kind"] : "";
  const initialPlace = typeof params["place"] === "string" ? params["place"] : "";
  const [kind, setKind] = useState(initialKind);
  /**
   * どの層を見ているか（ADR-0003）。`""` は人の記憶、それ以外は場所ID。
   * **人とプロジェクトを1つの一覧に混ぜない**——混ぜた時点で「横断させない」が形骸化する。
   */
  const [place, setPlace] = useState(initialPlace);
  /** 訂正済み・忘れたものも見るか。既定は今有効な記憶だけ（履歴を見たいときだけ出す） */
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  /** 手元にある一覧を絞るだけなので、打つたびに効かせる。 */
  const [filter, setFilter] = useState("");
  /** 忘れさせている最中のID（二度押しを防ぐ）。 */
  const [forgetting, setForgetting] = useState<string | undefined>(undefined);
  const [forgetError, setForgetError] = useState<string | undefined>(undefined);
  const now = useTicker(60_000);

  const scopes = useModuleTool<ScopeList>(endpoint, "studio.memory.scopes", {});
  const places = scopes.data?.places ?? [];

  const list = useModuleTool<MemoryList>(endpoint, "studio.memory", {
    ...(kind ? { kind } : {}),
    includeSuperseded,
    ...(place ? { scope: "project", place } : { scope: "person" }),
  });
  const records = list.data?.records ?? [];

  // 場所が消えた（登録から外れた）ときに、空の一覧を見続けないよう人の記憶へ戻す
  useEffect(() => {
    if (place && scopes.data && !places.some((p) => p.id === place)) setPlace("");
  }, [place, scopes.data, places]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return records;
    return records.filter(
      (r) => r.text.toLowerCase().includes(q) || (r.refs ?? []).join(" ").toLowerCase().includes(q)
    );
  }, [records, filter]);

  /** 忘れさせる。**確認を挟む**——記録は残るが、有効な記憶から外れるのは一方向の操作。 */
  const forget = async (record: MemoryRecord): Promise<void> => {
    const ok = window.confirm(
      `この記憶を忘れさせますか？\n\n${record.text}\n\n` +
        "（記録は残るので後から辿れますが、番頭は以後この記憶を使いません）"
    );
    if (!ok) return;
    setForgetting(record.id);
    setForgetError(undefined);
    try {
      // I2: `callModuleTool` は失敗を例外にする。押したのに何も起きなかったように見せない
      await callModuleTool(endpoint, "studio.memory.forget", {
        id: record.id,
        reason: "記憶ビューアから削除",
        ...(place ? { scope: "project", place } : { scope: "person" }),
      });
      list.reload();
    } catch (err) {
      setForgetError(err instanceof Error ? err.message : String(err));
    } finally {
      setForgetting(undefined);
    }
  };

  const scopeLabel = place ? (places.find((p) => p.id === place)?.label ?? place) : "あなた（人）";

  return (
    <ViewShell className="st">
      <ViewBar>
        <ViewTitle icon="memory" count={shown.length}>
          記憶
        </ViewTitle>
        <span className="cv-spacer" />
        <Button small variant="ghost" onClick={() => list.reload()} title="取り直す">
          ⟳
        </Button>
      </ViewBar>

      {/* ADR-0003: 層の切り替え。場所が1つも無いときは出さない（人の記憶しか無い） */}
      {places.length > 0 && (
        <ViewBar>
          <Chip on={place === ""} onClick={() => setPlace("")} title="全プロジェクトで共有される記憶">
            あなた（人）
          </Chip>
          {places.map((p) => (
            <Chip
              key={p.id}
              on={place === p.id}
              onClick={() => setPlace(p.id)}
              title={`${p.label} に閉じた記憶（他のプロジェクトへは持ち出されない）`}
            >
              {p.label}
            </Chip>
          ))}
        </ViewBar>
      )}

      <ViewBar>
        {KINDS.map((k) => (
          <Chip key={k.key} on={kind === k.key} onClick={() => setKind(k.key)}>
            {k.label}
          </Chip>
        ))}
        <span className="cv-spacer" />
        <Toggle
          checked={includeSuperseded}
          onChange={setIncludeSuperseded}
          title="訂正で置き換えられた記憶・忘れた記憶も一覧に出す"
        >
          訂正前・忘れた記憶も表示
        </Toggle>
      </ViewBar>
      <ViewBar>
        <SearchField value={filter} onChange={setFilter} placeholder="覚えている内容で絞る" />
      </ViewBar>

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}
      {forgetError && <ErrorNote onRetry={() => setForgetError(undefined)}>{forgetError}</ErrorNote>}

      <Scroll>
        {list.loading && !list.data ? (
          <Loading rows={4} />
        ) : shown.length === 0 ? (
          <EmptyState
            icon="memory"
            title={filter ? "当てはまる記憶はありません" : `${scopeLabel}について、まだ何も覚えていません`}
          >
            {filter
              ? "絞り込みを外すと全部出ます。"
              : place
                ? "このプロジェクトの決定や規約を覚えると、ここに並びます。"
                : "話しているうちに、番頭が覚えたことがここに並びます。"}
          </EmptyState>
        ) : (
          <div className="cv-cards">
            {shown.map((r) => (
              <Card key={r.id}>
                <div className="st-card-head">
                  <Badge tone={toneOf(r.kind)}>{labelOf(r.kind)}</Badge>
                  {/* 決定28: 出所。抽出したものは PO が言ったことより弱い扱いになる */}
                  {r.origin === "extracted" && (
                    <Badge tone="neutral" title="会話から番頭が抽出した記憶（POが明示的に言ったものではない）">
                      抽出
                    </Badge>
                  )}
                  {/* 訂正で置き換えた記憶があることを示す（何を直したのか辿れるように） */}
                  {r.supersedes && (
                    <Badge tone="warn" title={`置き換えた記憶: ${r.supersedes}`}>
                      訂正
                    </Badge>
                  )}
                  {/* 履歴表示のとき、いま効いていないものを取り違えない */}
                  {r.active === false && (
                    <Badge tone="neutral" title="いまは効いていない（訂正されたか、忘れられた）">
                      無効
                    </Badge>
                  )}
                  <span className="cv-spacer" />
                  <span className="cv-muted" title={formatTime(r.createdAt)}>
                    {formatRelative(r.createdAt, now) || formatTime(r.createdAt)}
                  </span>
                  {/* 決定28: PO が消せること。有効な記憶にだけ出す */}
                  {r.active !== false && (
                    <Button
                      small
                      variant="ghost"
                      title="この記憶を忘れさせる（記録は残る）"
                      disabled={forgetting === r.id}
                      onClick={() => void forget(r)}
                    >
                      {forgetting === r.id ? "…" : "忘れる"}
                    </Button>
                  )}
                </div>
                <div className="st-text">{r.text}</div>
                {/* 記録した時刻とは別軸。いつから真かが意味を持つ記憶だけ出る */}
                {r.validFrom && <div className="st-refs">{r.validFrom} から</div>}
                {r.reason && <div className="st-refs">理由: {r.reason}</div>}
                {r.refs && r.refs.length > 0 && <div className="st-refs">{r.refs.join(" · ")}</div>}
              </Card>
            ))}
          </div>
        )}
      </Scroll>
    </ViewShell>
  );
}
