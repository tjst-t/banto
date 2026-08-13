/**
 * LLM・モデル — プロバイダ・モデル・キーの一元管理 GUI（ADR-0004 / ADR-0011）。
 *
 * 番頭は具体モデルを持ち、職人は tier で指定する。tier は難度の軸、制約
 * （vision / local / free）は候補を絞る条件で、互いに直交する。
 *
 * 決定25: 人はモジュールのデータAPIを叩く。ここは番頭の Tool を呼ばない。
 *
 * 面の並びは「上から決める順」：いま何が効いているか（役割の既定）→ どう選ばれるか
 * （tier と解決の確認）→ 素材（プロバイダ・キー・モデル）→ 置き場所。
 */

import { useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import { Icon } from "../icons.js";
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  ErrorNote,
  Loading,
  Note,
  Scroll,
  SearchField,
  Segmented,
  Select,
  TextInput,
  Toggle,
  ViewBar,
  ViewShell,
  formatCount,
} from "./ui.js";

type Tier = "reasoning" | "standard" | "fast";
type Scope = "host" | "worker";

interface KeyInfo {
  name: string;
  host: boolean;
  worker: boolean;
  state: "ok" | "limited" | "invalid" | "untested";
  limitedUntil?: string;
  /** 最後に確かめた時刻。 */
  checkedAt?: string;
  /** どの鍵が入っているかの手がかり（末尾4文字）。値そのものは来ない。 */
  hint?: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  hasAuth: boolean;
  modelCount: number;
  /** モデルを取り込めるか（到達先があるか、ハーネスが定義を内蔵しているか）。 */
  canFetchModels: boolean;
  local: boolean;
  keys: KeyInfo[];
}

interface ModelInfo {
  providerId: string;
  id: string;
  name: string;
  tier: Tier;
  vision: boolean;
  contextWindow?: number;
  cost?: { input: number; output: number };
  free: boolean;
  /** 誰に許しているか（決定98）。空＝採用していない。 */
  policy: Array<"host" | "worker">;
}

interface TierInfo {
  tier: Tier;
  label: string;
  description: string;
  pick?: { provider: string; model: string };
}

interface FileState {
  changed: boolean;
  loadedAt: string;
  loadedHash: string;
  currentHash: string;
}

interface CatalogData {
  providers: ProviderInfo[];
  models: ModelInfo[];
  tiers: TierInfo[];
  defaults: { host?: { backend?: string; provider: string; model: string } };
  files: FileState;
}


/** 「探して採用」の絞り込み。プロバイダごとに持つ。 */
interface SearchState {
  query: string;
  vision: boolean;
  free: boolean;
  minContext: number;
  sort: "name" | "context" | "price";
}

const EMPTY_SEARCH: SearchState = {
  query: "",
  vision: false,
  free: false,
  minContext: 0,
  sort: "name",
};


const EMPTY: CatalogData = {
  providers: [],
  models: [],
  tiers: [],
  defaults: {},
  files: { changed: false, loadedAt: "", loadedHash: "", currentHash: "" },
};

/** 100万トークンあたりの値段を短く。 */
function priceOf(cost: { input: number; output: number } | undefined): string | undefined {
  if (!cost) return undefined;
  if (cost.input === 0 && cost.output === 0) return "無料";
  return `$${cost.input}/$${cost.output}`;
}

function timeOf(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** キーの状態を1行で。**未確認と有効を混ぜない**（I1）。 */
function keyStateOf(k: KeyInfo): { text: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (k.state === "limited") return { text: `上限 ${timeOf(k.limitedUntil)}まで`, tone: "warn" };
  if (k.state === "invalid") return { text: "受け付けられません", tone: "danger" };
  if (k.state === "ok") {
    return { text: `有効${k.checkedAt ? `（${timeOf(k.checkedAt)} 確認）` : ""}`, tone: "ok" };
  }
  return { text: "未確認", tone: "neutral" };
}

/**
 * モデルの能力の札。**分からないものは分からないと出す**（推測しない）。
 *
 * 文脈長だけは**押すと手で入れられる**（PO要望 2026-08-11）。プロバイダの `/models` は
 * 文脈長を返さないことがあり（huihui の `deepseek-v4-flash-abliterated` は 1M あるのに
 * 分からない）、分からないままだと章立ての閾値も目盛りも効かず、実際より短いものとして
 * 進む。**分かっている人がその場で入れられる**のがいちばん短い道。
 */
function ModelCaps({
  model,
  onSetContextWindow,
}: {
  model: ModelInfo;
  onSetContextWindow?(value: number | undefined): void;
}): React.ReactElement {
  const [editing, setEditing] = useState<string>();
  const commit = (): void => {
    const raw = (editing ?? "").trim();
    setEditing(undefined);
    if (raw === "") {
      // 空＝手入力の取り消し（プロバイダが言う値に戻る）
      if (model.contextWindow !== undefined) onSetContextWindow?.(undefined);
      return;
    }
    // 「1M」「200k」も受ける——人はその単位で覚えている
    const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/u.exec(raw);
    if (!m) return; // 読めないものは黙って捨てる（ホスト側でも弾かれる）
    const unit = m[2]?.toLowerCase();
    const value = Number(m[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
    onSetContextWindow?.(Math.round(value));
  };
  return (
    <span className="llm-model-caps">
      {editing !== undefined ? (
        <input
          className="cv-input llm-ctx-input"
          value={editing}
          autoFocus
          placeholder="1M / 200k / 128000"
          aria-label={`${model.id} の文脈長`}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(undefined);
          }}
        />
      ) : model.contextWindow ? (
        <Badge
          title={`${model.contextWindow.toLocaleString()} トークン（押すと直せます）`}
          {...(onSetContextWindow
            ? { onClick: () => setEditing(String(model.contextWindow)) }
            : {})}
        >
          {formatCount(model.contextWindow)}
        </Badge>
      ) : (
        <Badge
          tone="warn"
          title={
            "文脈の長さが分かりません。ハーネスは 0 として扱うため、毎ターン要約が走る可能性があります。" +
            (onSetContextWindow ? "押すと手で入れられます" : "")
          }
          {...(onSetContextWindow ? { onClick: () => setEditing("") } : {})}
        >
          長さ不明
        </Badge>
      )}
      {model.cost && <Badge title="100万トークンあたりの入力/出力">{priceOf(model.cost)}</Badge>}
      {model.vision && <Badge tone="accent">画像可</Badge>}
      {model.free && !model.cost && <Badge tone="ok">無料</Badge>}
    </span>
  );
}

export function LlmRegistryViewer({ endpoint }: CanvasViewProps): React.ReactElement {
  /**
   * 採用しているモデルだけを取る。**全件は取りに行かない**——プロバイダによっては
   * 数百あり、開くたびに数十KBを運んだうえ、並べても選べない（ADR-0011 決定47）。
   */
  const catalog = useModuleTool<CatalogData>(endpoint, "llm.list", { adopted: true, limit: 200 });
  const data = catalog.data ?? EMPTY;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** プロバイダ追加の入力。開いている間だけ持つ。 */
  const [adding, setAdding] = useState<{ id: string; baseUrl: string; apiKey: string }>();
  /** キーの入力欄（プロバイダごと）。**打ち終わるまでしか持たない**——送ったら消す。 */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  /** キーの確認結果・モデル取り込みの結果（どのプロバイダに何が起きたか）。 */
  const [checked, setChecked] = useState<{ provider: string; text: string }>();
  const [fetched, setFetched] = useState<{ provider: string; text: string }>();
  /** 「探して採用」の入力と結果（プロバイダごと）。 */
  const [search, setSearch] = useState<Record<string, SearchState>>({});
  const [found, setFound] = useState<Record<string, { models: ModelInfo[]; matched: number }>>({});

  const run = async (tool: string, args: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await callModuleTool(endpoint, tool, args);
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * モデルの取り込み。**何が起きたかを文言で出す**——「押したけど何も変わらない」
   * （＝新しいモデルが無かった）のか、届かなかったのかが区別できないと困る。
   */
  const fetchModels = async (provider: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setFetched(undefined);
    try {
      const result = await callModuleTool<{
        added: string[];
        removed: string[];
        repaired: Array<{ role: string; from: string; to?: string }>;
      }>(endpoint, "llm.fetch_models", { provider });
      const parts = [
        result.added.length > 0
          ? `${result.added.length} 件を取り込みました`
          : "新しいモデルはありません",
      ];
      if (result.removed.length > 0) {
        parts.push(`無くなった ${result.removed.length} 件を消しました: ${result.removed.join(", ")}`);
      }
      // 既定が消えていたら選び直している。**何をどう変えたかを必ず出す**
      for (const change of result.repaired ?? []) {
        parts.push(
          change.to
            ? `${change.role}（${change.from}）が無くなったので ${change.to} にしました`
            : `${change.role}（${change.from}）が無くなり、代わりが見つかりません`
        );
      }
      setFetched({ provider, text: parts.join("。") });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** キーが通るか確かめる。**結果を文言で残す**——札だけだと押したのか届かないのか分からない。 */
  const checkKey = async (provider: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setChecked(undefined);
    try {
      const result = await callModuleTool<{ state: string; status: number }>(
        endpoint,
        "llm.check_key",
        { provider }
      );
      setChecked({
        provider,
        text:
          result.state === "ok"
            ? "キーは有効です。"
            : result.state === "invalid"
              ? `キーが受け付けられませんでした（${result.status}）。入れ直してください。`
              : `上限に当たっています（${result.status}）。しばらく待つと戻ります。`,
      });
      catalog.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** モデルを探す。**ホストに絞り込ませる**——全件を持ってきて画面で絞っても何も減らない。 */
  const runSearch = async (provider: string, state: SearchState): Promise<void> => {
    setSearch((prev) => ({ ...prev, [provider]: state }));
    try {
      const result = await callModuleTool<{ models: ModelInfo[]; matched: number }>(
        endpoint,
        "llm.list",
        {
          adopted: false,
          provider,
          ...(state.query.trim().length > 0 ? { query: state.query.trim() } : {}),
          ...(state.vision ? { vision: true } : {}),
          ...(state.free ? { free: true } : {}),
          ...(state.minContext ? { minContext: state.minContext } : {}),
          sort: state.sort,
          limit: 30,
        }
      );
      setFound((prev) => ({
        ...prev,
        [provider]: { models: result.models, matched: result.matched },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleProvider = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (catalog.loading && !catalog.data) return <Loading rows={6} />;
  if (catalog.error) {
    return <ErrorNote onRetry={catalog.reload}>{catalog.error}</ErrorNote>;
  }

  const modelsByProvider = new Map<string, ModelInfo[]>();
  for (const m of data.models) {
    const listForProvider = modelsByProvider.get(m.providerId) ?? [];
    listForProvider.push(m);
    modelsByProvider.set(m.providerId, listForProvider);
  }
  const hostModels = data.models.filter((m) => m.policy.includes("host"));
  const tierOptions = data.tiers.map((t) => ({ value: t.tier, label: t.label, title: t.description }));

  return (
    <ViewShell className="llm-view">
      {/*
        見出しは置かない——この面は設定の区画としても開かれ、そちらには既に見出しがある。
        代わりに、いま何を相手にしているかの規模だけを出す。
      */}
      <ViewBar>
        <span className="llm-sec-label">
          プロバイダ {data.providers.length} ・ 採用モデル {data.models.length}
        </span>
        <span className="cv-spacer" />
        <Button small variant="ghost" disabled={busy} onClick={() => void run("llm.reload", {})}>
          ⟳ 読み直す
        </Button>
      </ViewBar>

      <Scroll pad={false}>
        <div className="llm">
          {data.files.changed && (
            <Note tone="warn">
              pi の設定ファイルが banto の外で変更されました（読み込み時{" "}
              <code className="cv-mono">{data.files.loadedHash}</code> → 現在{" "}
              <code className="cv-mono">{data.files.currentHash}</code>）。上の「読み直す」で取り込みます。
            </Note>
          )}

          {/* ① いま何が効いているか */}
          <section className="llm-sec">
            <div className="llm-sec-label">役割の既定</div>
            <div className="llm-role">
              <span className="llm-role-mark">番</span>
              <div className="llm-role-main">
                <div className="llm-role-name">番頭</div>
                <div className="llm-role-sub">具体モデルで固定</div>
              </div>
              <Select
                disabled={busy}
                aria-label="番頭が使うモデル"
                value={
                  data.defaults.host ? `${data.defaults.host.provider}|${data.defaults.host.model}` : ""
                }
                onChange={(e) => {
                  const [provider, model] = e.target.value.split("|");
                  // ADR-0020 決定94: 束縛の口は `llm.set_role` 1本
                  if (provider && model) void run("llm.set_role", { role: "steward", provider, model });
                }}
              >
                {!data.defaults.host && <option value="">（未設定）</option>}
                {hostModels.map((m) => (
                  <option key={`${m.providerId}|${m.id}`} value={`${m.providerId}|${m.id}`}>
                    {m.providerId} / {m.id}
                  </option>
                ))}
              </Select>
            </div>
            {/*
              職人の既定（等級・等級ごとのモデル）は**「職人」の区画へ移した**
              （PO要望 2026-08-10）。ここに置くと pi のモデルだけが特別扱いになり、
              Claude Code のような登録に載らないバックエンドのモデルを並べられない。
              この区画が持つのは素材（プロバイダ・鍵・モデル）と**採用**まで。
            */}
            <p className="cv-muted llm-moved">
              職人が何で動くか・等級ごとにどのモデルを使うかは「職人」の区画で決めます。
              ここで決めるのは<strong>職人に使わせてよいモデル</strong>（下の採用）までです。
            </p>
          </section>

          {/* ② どう選ばれるか */}
          <section className="llm-sec">
            <div className="llm-sec-label">tier（難度の軸）</div>
            <div className="llm-tiers">
              {data.tiers.map((t) => (
                <div key={t.tier} className="llm-tier-card">
                  <div className="llm-tier-head">
                    <Badge className={`is-tier-${t.tier}`}>{t.label}</Badge>
                  </div>
                  <textarea
                    className="llm-tier-desc"
                    defaultValue={t.description}
                    disabled={busy}
                    aria-label={`${t.label} の説明`}
                    onBlur={(e) => {
                      if (e.target.value !== t.description) {
                        void run("llm.set_tier_description", {
                          tier: t.tier,
                          description: e.target.value,
                        });
                      }
                    }}
                  />

                </div>
              ))}
            </div>
          </section>

          {/*
            「解決の確認」（tier と制約を選んで実際に決まるモデルを見る）はここから外した。
            確かめたいのは**職人がどのモデルで動くか**で、その割り当ては「職人」の区画に
            あるため——あちらの等級ごとの行に「指定なし（いまは X になります）」が出る。
          */}

          {/* ③ 素材 */}
          <section className="llm-sec">
            <div className="llm-sec-head">
              <span className="llm-sec-label">プロバイダとキー</span>
              <Button
                small
                disabled={busy}
                onClick={() => setAdding(adding ? undefined : { id: "", baseUrl: "", apiKey: "" })}
              >
                {adding ? "やめる" : <><Icon name="plus" size={14} /> プロバイダを追加</>}
              </Button>
            </div>

            {adding && (
              <div className="llm-add">
                <label className="llm-add-row">
                  <span>名前</span>
                  <TextInput
                    value={adding.id}
                    placeholder="例: ollama"
                    onChange={(e) => setAdding({ ...adding, id: e.target.value })}
                  />
                </label>
                <label className="llm-add-row">
                  <span>到達先</span>
                  <TextInput
                    value={adding.baseUrl}
                    placeholder="例: http://10.0.0.2:11434/v1"
                    onChange={(e) => setAdding({ ...adding, baseUrl: e.target.value })}
                  />
                </label>
                <label className="llm-add-row">
                  <span>APIキー</span>
                  <TextInput
                    type="password"
                    value={adding.apiKey}
                    placeholder="不要なら空のまま"
                    onChange={(e) => setAdding({ ...adding, apiKey: e.target.value })}
                  />
                </label>
                <div className="llm-add-actions">
                  {/* Banto は認証を持たない。鍵を入れる操作だけは、それを承知でやってもらう */}
                  <span className="llm-add-note">
                    キーはこのホストの <code className="cv-mono">auth.json</code>（本人のみ読める）に
                    保存されます。画面には二度と出ません。
                  </span>
                  <Button
                    variant="primary"
                    disabled={
                      busy || adding.id.trim().length === 0 || adding.baseUrl.trim().length === 0
                    }
                    onClick={() => {
                      void run("llm.add_provider", {
                        id: adding.id.trim(),
                        baseUrl: adding.baseUrl.trim(),
                        ...(adding.apiKey ? { apiKey: adding.apiKey } : {}),
                      }).then(() => setAdding(undefined));
                    }}
                  >
                    追加する
                  </Button>
                </div>
              </div>
            )}

            {data.providers.length === 0 ? (
              <EmptyState icon="model" title="プロバイダが見つかりません">
                「プロバイダを追加」から、到達先とキーを入れてください。
              </EmptyState>
            ) : (
              data.providers.map((p) => {
                const open = expanded.has(p.id);
                const models = modelsByProvider.get(p.id) ?? [];
                const state = search[p.id] ?? EMPTY_SEARCH;
                const result = found[p.id];
                return (
                  <div key={p.id} className="llm-prov">
                    <button
                      className="llm-prov-head"
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleProvider(p.id)}
                    >
                      <span className="llm-prov-mark">{p.name.slice(0, 1).toUpperCase()}</span>
                      <span className="llm-prov-main">
                        <span className="llm-prov-name">{p.name}</span>
                        <span className="llm-prov-path">
                          {p.baseUrl || "到達先なし"} ・ モデル {models.length}
                          {p.local ? " ・ ローカル" : ""}
                        </span>
                      </span>
                      {!p.hasAuth && (
                        <Badge tone="warn" title="認証キー未設定">
                          鍵なし
                        </Badge>
                      )}
                      <span className="llm-prov-caret" aria-hidden="true">
                        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
                      </span>
                    </button>

                    {open && (
                      <div className="llm-prov-body">
                        <div style={{ margin: "10px 0 4px" }}>
                          <Toggle
                            checked={p.local}
                            disabled={busy}
                            title="制約「外に出さない」で選ばれる対象になります"
                            onChange={(next) =>
                              void run("llm.set_provider_local", { provider: p.id, local: next })
                            }
                          >
                            外に出さない（ローカル実行）
                          </Toggle>
                        </div>

                        {/*
                          **1プロバイダ1鍵**（auth.json が「プロバイダ名→鍵」の形）。
                          複数鍵は auth.json のデータモデル変更（D1）で、必要になったときに作り直す。
                        */}
                        <div className="llm-sub-head">
                          <span className="llm-sub-label">API キー</span>
                        </div>
                        {p.keys.map((k) => {
                          const ks = keyStateOf(k);
                          return (
                            <div key={k.name} className={`llm-key is-${k.state}`}>
                              <span className="llm-key-name">
                                設定済み
                                {k.hint && <code className="llm-key-hint">{k.hint}</code>}
                              </span>
                              <Badge tone={ks.tone}>{ks.text}</Badge>
                              {/* 入れただけでは効いているか分からない。ここで確かめられるようにする */}
                              <Button
                                small
                                disabled={busy || !p.baseUrl}
                                title={
                                  p.baseUrl
                                    ? "到達先へ1回問い合わせて、キーが通るか確かめます"
                                    : "到達先（baseUrl）が無いので確かめられません"
                                }
                                onClick={() => void checkKey(p.id)}
                              >
                                確認する
                              </Button>
                              {/* 消すのは取り返しがつかないので、右端に控えめに置く */}
                              <Button
                                small
                                variant="ghost"
                                disabled={busy}
                                title="キーを消す"
                                onClick={() => {
                                  if (!confirm(`${p.id} のAPIキーを消します。よろしいですか。`)) return;
                                  void run("llm.remove_key", { provider: p.id });
                                }}
                              >
                                <Icon name="close" size={13} />
                              </Button>
                            </div>
                          );
                        })}
                        {checked?.provider === p.id && <Note tone="neutral">{checked.text}</Note>}

                        {/* キーの出し入れ。**入れた値は画面に戻らない**（保存したら欄を空にする） */}
                        <div className="llm-key-edit">
                          <TextInput
                            type="password"
                            placeholder={p.hasAuth ? "入れ直す（新しいキー）" : "APIキーを入れる"}
                            value={keyDraft[p.id] ?? ""}
                            disabled={busy}
                            onChange={(e) => setKeyDraft({ ...keyDraft, [p.id]: e.target.value })}
                          />
                          <Button
                            disabled={busy || (keyDraft[p.id] ?? "").trim().length === 0}
                            onClick={() => {
                              void run("llm.set_key", { provider: p.id, key: keyDraft[p.id] }).then(
                                () => setKeyDraft({ ...keyDraft, [p.id]: "" })
                              );
                            }}
                          >
                            {p.hasAuth ? "差し替える" : "入れる"}
                          </Button>
                        </div>

                        <div className="llm-sub-head">
                          <span className="llm-sub-label">採用中のモデル {models.length}</span>
                          {/* プロバイダが出すモデルは変わる。押して取り直せるようにする */}
                          <Button
                            small
                            disabled={busy || !p.canFetchModels}
                            title={
                              p.canFetchModels
                                ? p.baseUrl
                                  ? "プロバイダに問い合わせて一覧を取り込む"
                                  : "ハーネスが知っている定義から取り込む（到達先は登録されていない）"
                                : "到達先も組み込みの定義も無いので取り込めません"
                            }
                            onClick={() => void fetchModels(p.id)}
                          >
                            ⟳ モデルを取り込む
                          </Button>
                        </div>
                        {fetched?.provider === p.id && <Note tone="neutral">{fetched.text}</Note>}
                        {models.length === 0 && (
                          <p className="cv-muted" style={{ margin: "0 0 6px" }}>
                            まだ1つも採用していません。下の「探して採用」から選んでください。
                          </p>
                        )}

                        {models.map((m) => {
                          const isHostDef =
                            data.defaults.host?.provider === m.providerId &&
                            data.defaults.host?.model === m.id;
                          const tierInfo = data.tiers.find((t) => t.tier === m.tier);
                          const isPick =
                            tierInfo?.pick?.provider === m.providerId && tierInfo?.pick?.model === m.id;
                          return (
                            <div key={`${m.providerId}/${m.id}`} className="llm-model">
                              <span className="llm-model-id">{m.id}</span>
                              <ModelCaps
                                model={m}
                                onSetContextWindow={(contextWindow) =>
                                  void run("llm.set_context_window", {
                                    provider: m.providerId,
                                    model: m.id,
                                    ...(contextWindow !== undefined ? { contextWindow } : {}),
                                  })
                                }
                              />
                              <span className="llm-model-acts">
                                {/* tier は3つしかない。**開いて選ぶより、並べて押す** */}
                                <Segmented
                                  label={`${m.id} の tier`}
                                  value={m.tier}
                                  disabled={busy}
                                  options={tierOptions}
                                  onChange={(tier) =>
                                    void run("llm.set_tier", {
                                      provider: m.providerId,
                                      model: m.id,
                                      tier,
                                    })
                                  }
                                />
                                {(["host", "worker"] as const).map((scope: Scope) => (
                                  <Chip
                                    key={scope}
                                    on={scope === "host" ? m.policy.includes("host") : m.policy.includes("worker")}
                                    disabled={busy}
                                    title={`${scope === "host" ? "番頭" : "職人"}が使ってよい`}
                                    onClick={() =>
                                      void run("llm.set_policy", {
                                        provider: m.providerId,
                                        model: m.id,
                                        scope,
                                        usable: !(scope === "host" ? m.policy.includes("host") : m.policy.includes("worker")),
                                      })
                                    }
                                  >
                                    {scope === "host" ? "番頭" : "職人"}
                                  </Chip>
                                ))}
                                <Chip
                                  on={isHostDef}
                                  disabled={busy}
                                  title="番頭が使うモデルにする"
                                  onClick={() =>
                                    void run("llm.set_role", {
                                      role: "steward",
                                      provider: m.providerId,
                                      model: m.id,
                                    })
                                  }
                                >
                                  番頭
                                </Chip>
                                <Chip
                                  on={isPick}
                                  disabled={busy}
                                  title={`職人の ${tierInfo?.label ?? m.tier} に割り当てる`}
                                  onClick={() =>
                                    void run("llm.set_role", {
                                      role: `worker.${m.tier}`,
                                      provider: m.providerId,
                                      model: m.id,
                                    })
                                  }
                                >
                                  職人の{tierInfo?.label ?? m.tier}
                                </Chip>
                                {/* 採用をやめる＝番頭も職人も使わない。台帳には残る */}
                                <Button
                                  small
                                  variant="ghost"
                                  disabled={busy}
                                  title="この一覧から外す（台帳には残るので、また探して採用できます）"
                                  onClick={() => {
                                    void run("llm.set_policy", {
                                      provider: m.providerId,
                                      model: m.id,
                                      scope: "host",
                                      usable: false,
                                    }).then(() =>
                                      run("llm.set_policy", {
                                        provider: m.providerId,
                                        model: m.id,
                                        scope: "worker",
                                        usable: false,
                                      })
                                    );
                                  }}
                                >
                                  採用をやめる
                                </Button>
                              </span>
                            </div>
                          );
                        })}

                        {/*
                          探して採用。**一覧を全部並べない**——数百あるプロバイダでは、
                          並べた時点で選べなくなる。絞ってから採用する（ADR-0011 決定47）
                        */}
                        <div className="llm-sub-head">
                          <span className="llm-sub-label">探して採用</span>
                        </div>
                        <div className="llm-search">
                          <SearchField
                            value={state.query}
                            onChange={(query) =>
                              setSearch((prev) => ({ ...prev, [p.id]: { ...state, query } }))
                            }
                            onSubmit={(query) => void runSearch(p.id, { ...state, query })}
                            placeholder="モデル名で探す（例: opus, gpt, llama）"
                          />
                          <Button small disabled={busy} onClick={() => void runSearch(p.id, state)}>
                            探す
                          </Button>
                        </div>
                        <div className="llm-filters">
                          {(
                            [
                              { key: "vision", label: "画像可" },
                              { key: "free", label: "無料" },
                            ] as const
                          ).map((f) => (
                            <Chip
                              key={f.key}
                              on={state[f.key]}
                              disabled={busy}
                              onClick={() => void runSearch(p.id, { ...state, [f.key]: !state[f.key] })}
                            >
                              {f.label}
                            </Chip>
                          ))}
                          <Select
                            value={state.sort}
                            disabled={busy}
                            aria-label="並び順"
                            onChange={(e) =>
                              void runSearch(p.id, {
                                ...state,
                                sort: e.target.value as SearchState["sort"],
                              })
                            }
                          >
                            <option value="name">名前順</option>
                            <option value="context">文脈が長い順</option>
                            <option value="price">安い順</option>
                          </Select>
                        </div>
                        {result && (
                          <div className="llm-found">
                            {/* I1: 何件のうち何件を出しているかを言う */}
                            <div className="llm-found-count">
                              {result.matched} 件中 {result.models.length} 件
                            </div>
                            {result.models.map((m) => (
                              <div key={`found/${m.providerId}/${m.id}`} className="llm-model">
                                <span className="llm-model-id">{m.id}</span>
                                <ModelCaps
                                model={m}
                                onSetContextWindow={(contextWindow) =>
                                  void run("llm.set_context_window", {
                                    provider: m.providerId,
                                    model: m.id,
                                    ...(contextWindow !== undefined ? { contextWindow } : {}),
                                  })
                                }
                              />
                                <span className="llm-model-acts">
                                  <Button
                                    small
                                    variant={m.policy.includes("host") ? "ghost" : "primary"}
                                    disabled={busy || m.policy.includes("host")}
                                    onClick={() => {
                                      void run("llm.set_policy", {
                                        provider: m.providerId,
                                        model: m.id,
                                        scope: "host",
                                        usable: true,
                                      }).then(() => void runSearch(p.id, state));
                                    }}
                                  >
                                    {m.policy.includes("host") ? "採用済み" : "採用する"}
                                  </Button>
                                </span>
                              </div>
                            ))}
                            {result.models.length === 0 && (
                              <p className="cv-muted" style={{ padding: "4px 6px 8px", margin: 0 }}>
                                見つかりません
                              </p>
                            )}
                          </div>
                        )}

                        {/* プロバイダごと消す。取り返しがつかないので、何が消えるかを言ってから聞く */}
                        <div className="llm-danger">
                          <Button
                            small
                            variant="danger"
                            disabled={busy}
                            onClick={() => {
                              const detail = [
                                `${p.id} を消します。`,
                                `モデル ${models.length} 件の設定`,
                                p.hasAuth ? "APIキー" : undefined,
                                "並び順・使用可の設定",
                              ]
                                .filter(Boolean)
                                .join(" / ");
                              if (!confirm(`${detail} も一緒に消えます。よろしいですか。`)) return;
                              void run("llm.remove_provider", { id: p.id });
                            }}
                          >
                            このプロバイダを消す
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>

          {/* ④ 置き場所 */}
          <section className="llm-sec">
            <div className="llm-sec-label">設定の保存先</div>
            <div className="llm-role">
              <span className="llm-role-mark">pi</span>
              <div className="llm-role-main">
                <div className="llm-role-name">モデルと鍵の一覧</div>
                <div className="llm-role-sub">~/.pi/agent/models.json ・ ~/.pi/agent/auth.json</div>
              </div>
              <Badge tone={data.files.changed ? "warn" : "ok"}>
                {data.files.changed ? "外部で変更あり" : `同期済 ${timeOf(data.files.loadedAt)}`}
              </Badge>
            </div>
            <div className="llm-role">
              <span className="llm-role-mark">番</span>
              <div className="llm-role-main">
                <div className="llm-role-name">tier・既定・使用可の設定</div>
                <div className="llm-role-sub">llm-registry.json</div>
              </div>
              <Badge tone="ok">保存済</Badge>
            </div>
          </section>

          {error && <ErrorNote onRetry={() => setError(undefined)}>{error}</ErrorNote>}
        </div>
      </Scroll>
    </ViewShell>
  );
}
