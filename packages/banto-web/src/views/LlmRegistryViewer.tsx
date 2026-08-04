/**
 * LLM・モデル — プロバイダ・モデル・キーの一元管理 GUI（ADR-0004 / spec §3.5）。
 *
 * 番頭は具体モデルを持ち、職人は tier で指定する。tier は難度の軸、制約
 * （vision / local / free）は候補を絞る条件で、互いに直交する。
 *
 * 決定25: 人はモジュールのデータAPIを叩く。ここは番頭の Tool を呼ばない。
 */

import { useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

type Tier = "reasoning" | "standard" | "fast";
type Scope = "host" | "worker";
type ConstraintKey = "vision" | "local" | "free";

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
  /** 文脈に入る最大トークン数（分かるときだけ）。 */
  contextWindow?: number;
  /** 100万トークンあたりの値段（分かるときだけ）。 */
  cost?: { input: number; output: number };
  free: boolean;
  hostUsable: boolean;
  workerUsable: boolean;
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
  defaults: { host?: { provider: string; model: string }; workerTier: Tier };
  files: FileState;
}

interface Resolution {
  model: { provider: string; id: string; name: string };
  tier: Tier;
  requestedTier: Tier;
  usedFallbackTier: boolean;
  droppedPick: boolean;
  key?: KeyInfo;
}

/** 「探して採用」の絞り込み。プロバイダごとに持つ。 */
interface SearchState {
  query: string;
  vision: boolean;
  free: boolean;
  minContext: number;
  sort: "name" | "context" | "price";
}

const EMPTY_SEARCH: SearchState = { query: "", vision: false, free: false, minContext: 0, sort: "name" };

/** 100万トークンあたりの値段を短く。 */
function priceOf(cost: { input: number; output: number } | undefined): string | undefined {
  if (!cost) return undefined;
  if (cost.input === 0 && cost.output === 0) return "無料";
  return `$${cost.input}/$${cost.output}`;
}

/** 文脈長を短く（200000 → 200k）。 */
function contextOf(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

const TIERS: readonly Tier[] = ["reasoning", "standard", "fast"];

const CONSTRAINTS: ReadonlyArray<{ key: ConstraintKey; label: string; hint: string }> = [
  { key: "vision", label: "画像を読む", hint: "スクショ・図をそのまま渡す" },
  { key: "local", label: "外に出さない", hint: "ローカル実行のみ。機密を含む" },
  { key: "free", label: "有料キーを使わない", hint: "無料枠・ローカルのみ" },
];

const EMPTY: CatalogData = {
  providers: [],
  models: [],
  tiers: [],
  defaults: { workerTier: "standard" },
  files: { changed: false, loadedAt: "", loadedHash: "", currentHash: "" },
};

function timeOf(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
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
  const [probeTier, setProbeTier] = useState<Tier>("standard");
  const [probeCons, setProbeCons] = useState<Record<ConstraintKey, boolean>>({
    vision: false,
    local: false,
    free: false,
  });
  const [probe, setProbe] = useState<{ ok: true; value: Resolution } | { ok: false; message: string }>();
  /** プロバイダ追加の入力。開いている間だけ持つ。 */
  const [adding, setAdding] = useState<{ id: string; baseUrl: string; apiKey: string }>();
  /** キーの入力欄（プロバイダごと）。**打ち終わるまでしか持たない**——送ったら消す。 */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  /** キーの確認結果（どのプロバイダに何が起きたか）。 */
  const [checked, setChecked] = useState<{ provider: string; text: string }>();
  /** モデル取り込みの結果（どのプロバイダに何が起きたか）。 */
  const [fetched, setFetched] = useState<{ provider: string; text: string }>();
  /** 「探して採用」の入力（プロバイダごと）。 */
  const [search, setSearch] = useState<Record<string, SearchState>>({});
  /** 検索の結果（プロバイダごと）。 */
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
        result.added.length > 0 ? `${result.added.length} 件を取り込みました` : "新しいモデルはありません",
      ];
      if (result.removed.length > 0) {
        parts.push(`無くなった ${result.removed.length} 件を消しました: ${result.removed.join(", ")}`);
      }
      // 既定が消えていたら選び直している。**何をどう変えたかを必ず出す**
      for (const change of result.repaired ?? []) {
        parts.push(
          change.to
            ? `⚠ ${change.role}（${change.from}）が無くなったので ${change.to} にしました`
            : `⚠ ${change.role}（${change.from}）が無くなり、代わりが見つかりません`
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

  /**
   * キーが通るか確かめる。**結果を文言で残す**——状態の札だけだと、押したのに
   * 何も起きなかったのか、届かなかったのかが分からない。
   */
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

  /**
   * モデルを探す。**ホストに絞り込ませる**——全件を持ってきて画面で絞ると、
   * 運ぶ量も並べる量も減らない。
   */
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
      setFound((prev) => ({ ...prev, [provider]: { models: result.models, matched: result.matched } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runProbe = async (tier: Tier, cons: Record<ConstraintKey, boolean>): Promise<void> => {
    const constraints: Record<string, boolean> = {};
    for (const c of CONSTRAINTS) if (cons[c.key]) constraints[c.key] = true;
    try {
      const value = await callModuleTool<Resolution>(endpoint, "llm.resolve", { tier, constraints });
      setProbe({ ok: true, value });
    } catch (err) {
      setProbe({ ok: false, message: err instanceof Error ? err.message : String(err) });
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

  if (catalog.loading && !catalog.data) return <div className="pa-loading">読み込み中…</div>;
  if (catalog.error) return <div className="fb-error">読み込めません: {catalog.error}</div>;

  const modelsByProvider = new Map<string, ModelInfo[]>();
  for (const m of data.models) {
    const list = modelsByProvider.get(m.providerId) ?? [];
    list.push(m);
    modelsByProvider.set(m.providerId, list);
  }
  const hostModels = data.models.filter((m) => m.hostUsable);
  const workerDefault = data.tiers.find((t) => t.tier === data.defaults.workerTier);

  return (
    <div className="llm">
      {data.files.changed && (
        <div className="llm-ext">
          <span className="llm-ext-ico">⟳</span>
          <div className="llm-ext-main">
            <div className="llm-ext-title">pi の設定ファイルが banto の外で変更されました</div>
            <div className="llm-ext-sub">
              読み込み時 <code>{data.files.loadedHash}</code> → 現在 <code>{data.files.currentHash}</code>
            </div>
          </div>
          <button className="llm-btn" disabled={busy} onClick={() => void run("llm.reload", {})}>
            読み直す
          </button>
        </div>
      )}

      <section className="llm-sec">
        <div className="llm-sec-label">役割の既定</div>
        <div className="llm-role">
          <span className="llm-role-mark">番</span>
          <div className="llm-role-main">
            <div className="llm-role-name">番頭</div>
            <div className="llm-role-sub">具体モデルで固定</div>
          </div>
          <select
            className="llm-select"
            disabled={busy}
            value={data.defaults.host ? `${data.defaults.host.provider}|${data.defaults.host.model}` : ""}
            onChange={(e) => {
              const [provider, model] = e.target.value.split("|");
              if (provider && model) void run("llm.set_host_default", { provider, model });
            }}
          >
            {!data.defaults.host && <option value="">（未設定）</option>}
            {hostModels.map((m) => (
              <option key={`${m.providerId}|${m.id}`} value={`${m.providerId}|${m.id}`}>
                {m.providerId} / {m.id}
              </option>
            ))}
          </select>
        </div>
        <div className="llm-role">
          <span className="llm-role-mark">職</span>
          <div className="llm-role-main">
            <div className="llm-role-name">職人</div>
            <div className="llm-role-sub">
              {workerDefault?.pick
                ? `制約なしのとき ${workerDefault.pick.provider} / ${workerDefault.pick.model}`
                : "tier で指定"}
            </div>
          </div>
          <select
            className="llm-select"
            disabled={busy}
            value={data.defaults.workerTier}
            onChange={(e) => void run("llm.set_worker_tier", { tier: e.target.value })}
          >
            {data.tiers.map((t) => (
              <option key={t.tier} value={t.tier}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="llm-sec">
        <div className="llm-sec-label">tier</div>
        <div className="llm-tiers">
          {data.tiers.map((t) => (
            <div key={t.tier} className="llm-tier-card">
              <div className="llm-tier-head">
                <span className={`llm-tier-badge llm-tier-${t.tier}`}>{t.label}</span>
                {data.defaults.workerTier === t.tier && <span className="llm-tier-def">職人の既定</span>}
              </div>
              <textarea
                className="llm-tier-desc"
                defaultValue={t.description}
                disabled={busy}
                onBlur={(e) => {
                  if (e.target.value !== t.description) {
                    void run("llm.set_tier_description", { tier: t.tier, description: e.target.value });
                  }
                }}
              />
              <div className="llm-tier-pick">
                第一候補:{" "}
                <code>{t.pick ? `${t.pick.provider} / ${t.pick.model}` : "—"}</code>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="llm-sec">
        <div className="llm-sec-label">解決の確認</div>
        <div className="llm-probe">
          <div className="llm-probe-row">
            <span className="llm-probe-label">tier</span>
            <div className="llm-probe-opts">
              {TIERS.map((t) => (
                <button
                  key={t}
                  className={`llm-chip ${probeTier === t ? "is-on" : ""}`}
                  onClick={() => {
                    setProbeTier(t);
                    void runProbe(t, probeCons);
                  }}
                >
                  {data.tiers.find((x) => x.tier === t)?.label ?? t}
                </button>
              ))}
            </div>
          </div>
          <div className="llm-probe-row">
            <span className="llm-probe-label">制約</span>
            <div className="llm-probe-opts">
              {CONSTRAINTS.map((c) => (
                <button
                  key={c.key}
                  className={`llm-chip ${probeCons[c.key] ? "is-on" : ""}`}
                  title={c.hint}
                  onClick={() => {
                    const next = { ...probeCons, [c.key]: !probeCons[c.key] };
                    setProbeCons(next);
                    void runProbe(probeTier, next);
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          {probe && (
            <div className={`llm-probe-out ${probe.ok ? "" : "is-none"}`}>
              {probe.ok ? (
                <>
                  <div className="llm-probe-model">
                    {probe.value.model.provider} / {probe.value.model.id}
                  </div>
                  <div className="llm-probe-line">
                    キー: <code>{probe.value.key?.name ?? "該当なし"}</code>
                  </div>
                  {probe.value.usedFallbackTier && (
                    <div className="llm-probe-line is-warn">
                      要求した tier に候補が無いため別の tier に落ちました
                    </div>
                  )}
                  {probe.value.droppedPick && (
                    <div className="llm-probe-line is-warn">
                      第一候補は制約で落ちたため、同じ tier の次の候補です
                    </div>
                  )}
                </>
              ) : (
                probe.message
              )}
            </div>
          )}
        </div>
      </section>

      <section className="llm-sec">
        <div className="llm-sec-head">
          <span className="llm-sec-label">プロバイダとキー</span>
          <button
            className="llm-btn"
            disabled={busy}
            onClick={() => setAdding(adding ? undefined : { id: "", baseUrl: "", apiKey: "" })}
          >
            {adding ? "やめる" : "＋ プロバイダを追加"}
          </button>
        </div>
        {adding && (
          <div className="llm-add">
            <label className="llm-add-row">
              <span>名前</span>
              <input
                value={adding.id}
                placeholder="例: ollama"
                onChange={(e) => setAdding({ ...adding, id: e.target.value })}
              />
            </label>
            <label className="llm-add-row">
              <span>到達先</span>
              <input
                value={adding.baseUrl}
                placeholder="例: http://10.0.0.2:11434/v1"
                onChange={(e) => setAdding({ ...adding, baseUrl: e.target.value })}
              />
            </label>
            <label className="llm-add-row">
              <span>APIキー</span>
              <input
                type="password"
                value={adding.apiKey}
                placeholder="不要なら空のまま"
                onChange={(e) => setAdding({ ...adding, apiKey: e.target.value })}
              />
            </label>
            <div className="llm-add-actions">
              {/* Banto は認証を持たない。鍵を入れる操作だけは、それを承知でやってもらう */}
              <span className="llm-add-note">
                キーはこのホストの <code>auth.json</code>（本人のみ読める）に保存されます。
                画面には二度と出ません。
              </span>
              <button
                className="llm-btn llm-btn-primary"
                disabled={busy || adding.id.trim().length === 0 || adding.baseUrl.trim().length === 0}
                onClick={() => {
                  void run("llm.add_provider", {
                    id: adding.id.trim(),
                    baseUrl: adding.baseUrl.trim(),
                    ...(adding.apiKey ? { apiKey: adding.apiKey } : {}),
                  }).then(() => setAdding(undefined));
                }}
              >
                追加する
              </button>
            </div>
          </div>
        )}
        {data.providers.length === 0 ? (
          <p className="llm-empty">プロバイダが見つかりません</p>
        ) : (
          data.providers.map((p) => {
            const open = expanded.has(p.id);
            const models = modelsByProvider.get(p.id) ?? [];
            const hostKey = p.keys.find((k) => k.host && k.state !== "limited");
            const workerKey = p.keys.find((k) => k.worker && k.state !== "limited");
            return (
              <div key={p.id} className="llm-prov">
                <div className="llm-prov-head" onClick={() => toggleProvider(p.id)}>
                  <span className="llm-prov-mark">{p.name.slice(0, 1).toUpperCase()}</span>
                  <div className="llm-prov-main">
                    <div className="llm-prov-name">{p.name}</div>
                    <div className="llm-prov-path">
                      {p.baseUrl || "—"} ・ キー {p.keys.length} ・ モデル {models.length}
                      {p.local ? " ・ ローカル" : ""}
                    </div>
                  </div>
                  {!p.hasAuth && <span className="llm-prov-noauth" title="認証キー未設定">🔒</span>}
                  <span className="llm-prov-caret">{open ? "▼" : "▶"}</span>
                </div>

                {open && (
                  <div className="llm-prov-body">
                    <label className="llm-local">
                      <input
                        type="checkbox"
                        checked={p.local}
                        disabled={busy}
                        onChange={(e) => void run("llm.set_provider_local", { provider: p.id, local: e.target.checked })}
                      />
                      外に出ない（ローカル実行）
                    </label>

                    {/*
                      **1プロバイダ1鍵**（auth.json が「プロバイダ名→鍵」の形）。
                      以前は順位と並べ替えを出していたが、常に1本しか無いので何の意味も
                      持っていなかった。複数鍵は auth.json のデータモデル変更（D1）で、
                      必要になったときに作り直す。
                    */}
                    <div className="llm-sub-label">API キー</div>
                    {p.keys.map((k) => (
                      <div key={k.name} className={`llm-key is-${k.state}`}>
                        <span className="llm-key-name">
                          設定済み {k.hint && <code className="llm-key-hint">{k.hint}</code>}
                        </span>
                        <span className={`llm-key-state is-${k.state}`}>
                          {k.state === "limited"
                            ? `上限 ${timeOf(k.limitedUntil ?? "")}まで`
                            : k.state === "invalid"
                              ? "受け付けられません"
                              : k.state === "ok"
                                ? `有効${k.checkedAt ? `（${timeOf(k.checkedAt)} 確認）` : ""}`
                                : "未確認"}
                        </span>
                        {/* 入れただけでは効いているか分からない。ここで確かめられるようにする */}
                        <button
                          className="llm-btn"
                          disabled={busy || !p.baseUrl}
                          title={
                            p.baseUrl
                              ? "到達先へ1回問い合わせて、キーが通るか確かめます"
                              : "到達先（baseUrl）が無いので確かめられません"
                          }
                          onClick={() => void checkKey(p.id)}
                        >
                          確認する
                        </button>
                        {/* 消すのは取り返しがつかないので、右端に控えめに置く */}
                        <button
                          className="llm-key-remove"
                          type="button"
                          disabled={busy}
                          aria-label="キーを消す"
                          title="キーを消す"
                          onClick={() => {
                            if (!confirm(`${p.id} のAPIキーを消します。よろしいですか。`)) return;
                            void run("llm.remove_key", { provider: p.id });
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {checked?.provider === p.id && <div className="llm-fetched">{checked.text}</div>}

                    {/* キーの出し入れ。**入れた値は画面に戻らない**（保存したら欄を空にする） */}
                    <div className="llm-key-edit">
                      <input
                        type="password"
                        placeholder={p.hasAuth ? "入れ直す（新しいキー）" : "APIキーを入れる"}
                        value={keyDraft[p.id] ?? ""}
                        disabled={busy}
                        onChange={(e) => setKeyDraft({ ...keyDraft, [p.id]: e.target.value })}
                      />
                      <button
                        className="llm-btn"
                        disabled={busy || (keyDraft[p.id] ?? "").trim().length === 0}
                        onClick={() => {
                          void run("llm.set_key", { provider: p.id, key: keyDraft[p.id] }).then(() =>
                            setKeyDraft({ ...keyDraft, [p.id]: "" })
                          );
                        }}
                      >
                        {p.hasAuth ? "差し替える" : "入れる"}
                      </button>
                    </div>

                    <div className="llm-sub-head">
                      <span className="llm-sub-label">採用中のモデル {models.length}</span>
                      {/* プロバイダが出すモデルは変わる。押して取り直せるようにする */}
                      <button
                        className="llm-btn"
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
                      </button>
                    </div>
                    {fetched?.provider === p.id && <div className="llm-fetched">{fetched.text}</div>}
                    {models.length === 0 && (
                      <p className="llm-empty">
                        まだ1つも採用していません。下の「探して採用」から選んでください。
                      </p>
                    )}
                    {models.map((m) => {
                      const isHostDef =
                        data.defaults.host?.provider === m.providerId && data.defaults.host?.model === m.id;
                      const tierInfo = data.tiers.find((t) => t.tier === m.tier);
                      const isPick =
                        tierInfo?.pick?.provider === m.providerId && tierInfo?.pick?.model === m.id;
                      return (
                        <div key={`${m.providerId}/${m.id}`} className="llm-model">
                          <span className="llm-model-id">{m.id}</span>
                          {/* 文脈の長さ。取り込み元が教えてくれたものだけ出す（推測しない） */}
                          {m.contextWindow ? (
                            <span className="llm-cap" title={`${m.contextWindow.toLocaleString()} トークン`}>
                              {contextOf(m.contextWindow)}
                            </span>
                          ) : (
                            <span
                              className="llm-cap llm-cap-unknown"
                              title="文脈の長さが分かりません。ハーネスは 0 として扱うため、毎ターン要約が走る可能性があります"
                            >
                              長さ不明
                            </span>
                          )}
                          {/* 値段は「どれを選ぶか」の実際の軸。100万トークンあたり */}
                          {m.cost && (
                            <span className="llm-cap" title="100万トークンあたりの入力/出力">
                              {priceOf(m.cost)}
                            </span>
                          )}
                          {m.vision && <span className="llm-cap">vision</span>}
                          {m.free && !m.cost && <span className="llm-cap">無料</span>}
                          <span className="llm-model-spacer" />
                          {/*
                            tier は3つしかない。**開いてから選ぶより、並べて押す**——
                            いまどこに置かれているかが一覧のまま読め、隣へ移すのも一手で済む
                          */}
                          <span
                            className="llm-tier-switch"
                            role="radiogroup"
                            aria-label={`${m.id} の tier`}
                          >
                            {data.tiers.map((t) => (
                              <button
                                key={t.tier}
                                type="button"
                                role="radio"
                                aria-checked={m.tier === t.tier}
                                className={`llm-tier-opt ${m.tier === t.tier ? `is-on llm-tier-${t.tier}` : ""}`}
                                disabled={busy}
                                title={t.description}
                                onClick={() => {
                                  if (m.tier === t.tier) return;
                                  void run("llm.set_tier", {
                                    provider: m.providerId,
                                    model: m.id,
                                    tier: t.tier,
                                  });
                                }}
                              >
                                {t.label}
                              </button>
                            ))}
                          </span>
                          {(["host", "worker"] as const).map((scope) => (
                            <button
                              key={scope}
                              className={`llm-role-toggle ${scope === "worker" ? "is-w" : ""} ${
                                (scope === "host" ? m.hostUsable : m.workerUsable) ? "is-on" : ""
                              }`}
                              disabled={busy}
                              title={`${scope === "host" ? "番頭" : "職人"}が使ってよい`}
                              onClick={() =>
                                void run("llm.set_usable", {
                                  provider: m.providerId,
                                  model: m.id,
                                  scope,
                                  usable: !(scope === "host" ? m.hostUsable : m.workerUsable),
                                })
                              }
                            >
                              {scope === "host" ? "番頭" : "職人OK"}
                            </button>
                          ))}
                          <button
                            className={`llm-pill ${isHostDef ? "is-on" : ""}`}
                            disabled={busy}
                            onClick={() =>
                              void run("llm.set_host_default", { provider: m.providerId, model: m.id })
                            }
                          >
                            番頭既定
                          </button>
                          <button
                            className={`llm-pill is-w ${isPick ? "is-on" : ""}`}
                            disabled={busy}
                            onClick={() => void run("llm.set_pick", { provider: m.providerId, model: m.id })}
                          >
                            {tierInfo?.label ?? m.tier}の第一候補
                          </button>
                          {/* 採用をやめる＝番頭も職人も使わない。一覧から消えるだけで台帳には残る */}
                          <button
                            className="llm-pill llm-pill-drop"
                            disabled={busy}
                            title="この一覧から外す（台帳には残るので、また探して採用できます）"
                            onClick={() => {
                              void run("llm.set_usable", {
                                provider: m.providerId,
                                model: m.id,
                                scope: "host",
                                usable: false,
                              }).then(() =>
                                run("llm.set_usable", {
                                  provider: m.providerId,
                                  model: m.id,
                                  scope: "worker",
                                  usable: false,
                                })
                              );
                            }}
                          >
                            採用をやめる
                          </button>
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
                      <span className="llm-search-box">
                        <input
                          className="llm-search-input"
                          placeholder="モデル名で探す（例: opus, gpt, llama）"
                          value={(search[p.id] ?? EMPTY_SEARCH).query}
                          onChange={(e) =>
                            setSearch((prev) => ({
                              ...prev,
                              [p.id]: { ...(prev[p.id] ?? EMPTY_SEARCH), query: e.target.value },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                              void runSearch(p.id, search[p.id] ?? EMPTY_SEARCH);
                            }
                          }}
                        />
                        {/* 探した結果を片付ける。**採用中の一覧に戻りたいだけ**のときに、
                            結果が居座ると邪魔になる（消せるものがあるときだけ出す） */}
                        {((search[p.id] ?? EMPTY_SEARCH).query.length > 0 || found[p.id]) && (
                          <button
                            className="llm-search-clear"
                            type="button"
                            title="検索結果を消す"
                            aria-label="検索結果を消す"
                            onClick={() => {
                              setSearch((prev) => ({
                                ...prev,
                                [p.id]: { ...(prev[p.id] ?? EMPTY_SEARCH), query: "" },
                              }));
                              setFound((prev) => {
                                const next = { ...prev };
                                delete next[p.id];
                                return next;
                              });
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                      <button
                        className="llm-btn"
                        disabled={busy}
                        onClick={() => void runSearch(p.id, search[p.id] ?? EMPTY_SEARCH)}
                      >
                        探す
                      </button>
                    </div>
                    <div className="llm-search-filters">
                      {([
                        { key: "vision", label: "画像可" },
                        { key: "free", label: "無料" },
                      ] as const).map((f) => (
                        <button
                          key={f.key}
                          className={`llm-chip ${(search[p.id] ?? EMPTY_SEARCH)[f.key] ? "is-on" : ""}`}
                          disabled={busy}
                          onClick={() => {
                            const next = {
                              ...(search[p.id] ?? EMPTY_SEARCH),
                              [f.key]: !(search[p.id] ?? EMPTY_SEARCH)[f.key],
                            };
                            void runSearch(p.id, next);
                          }}
                        >
                          {f.label}
                        </button>
                      ))}
                      <select
                        className="llm-select llm-select-sort"
                        value={(search[p.id] ?? EMPTY_SEARCH).sort}
                        disabled={busy}
                        onChange={(e) => {
                          const next = {
                            ...(search[p.id] ?? EMPTY_SEARCH),
                            sort: e.target.value as SearchState["sort"],
                          };
                          void runSearch(p.id, next);
                        }}
                      >
                        <option value="name">名前順</option>
                        <option value="context">文脈が長い順</option>
                        <option value="price">安い順</option>
                      </select>
                    </div>
                    {found[p.id] && (
                      <div className="llm-found">
                        {/* I1: 何件のうち何件を出しているかを言う */}
                        <div className="llm-found-count">
                          {found[p.id]!.matched} 件中 {found[p.id]!.models.length} 件
                        </div>
                        {found[p.id]!.models.map((m) => (
                          <div key={`found/${m.providerId}/${m.id}`} className="llm-model">
                            <span className="llm-model-id">{m.id}</span>
                            {m.contextWindow ? (
                              <span className="llm-cap">{contextOf(m.contextWindow)}</span>
                            ) : (
                              <span className="llm-cap llm-cap-unknown">長さ不明</span>
                            )}
                            {m.cost && <span className="llm-cap">{priceOf(m.cost)}</span>}
                            {m.vision && <span className="llm-cap">vision</span>}
                            <span className="llm-model-spacer" />
                            <button
                              className="llm-pill"
                              disabled={busy || m.hostUsable}
                              onClick={() => {
                                void run("llm.set_usable", {
                                  provider: m.providerId,
                                  model: m.id,
                                  scope: "host",
                                  usable: true,
                                }).then(() => void runSearch(p.id, search[p.id] ?? EMPTY_SEARCH));
                              }}
                            >
                              {m.hostUsable ? "採用済み" : "採用する"}
                            </button>
                          </div>
                        ))}
                        {found[p.id]!.models.length === 0 && (
                          <div className="llm-empty">見つかりません</div>
                        )}
                      </div>
                    )}

                    {/* プロバイダごと消す。取り返しがつかないので、何が消えるかを言ってから聞く */}
                    <div className="llm-prov-danger">
                      <button
                        className="llm-btn llm-btn-danger"
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
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="llm-sec">
        <div className="llm-sec-label">設定の保存先</div>
        <div className="llm-role">
          <span className="llm-role-mark">pi</span>
          <div className="llm-role-main">
            <div className="llm-role-name">モデルと鍵の一覧</div>
            <div className="llm-role-sub">~/.pi/agent/models.json ・ ~/.pi/agent/auth.json</div>
          </div>
          <span className={`llm-key-state ${data.files.changed ? "is-limited" : "is-ok"}`}>
            {data.files.changed ? "外部で変更あり" : `同期済 ${timeOf(data.files.loadedAt)}`}
          </span>
          <button className="llm-btn" disabled={busy} onClick={() => void run("llm.reload", {})}>
            再読込
          </button>
        </div>
        <div className="llm-role">
          <span className="llm-role-mark">番</span>
          <div className="llm-role-main">
            <div className="llm-role-name">tier・既定・使用可・キーの並び順</div>
            <div className="llm-role-sub">llm-registry.json</div>
          </div>
          <span className="llm-key-state is-ok">保存済</span>
        </div>
      </section>

      {error && <div className="llm-error">{error}</div>}
    </div>
  );
}
