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
  state: "ok" | "limited" | "untested";
  limitedUntil?: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  hasAuth: boolean;
  modelCount: number;
  local: boolean;
  keys: KeyInfo[];
}

interface ModelInfo {
  providerId: string;
  id: string;
  name: string;
  tier: Tier;
  vision: boolean;
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
  const catalog = useModuleTool<CatalogData>(endpoint, "llm.list");
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
        <div className="llm-sec-label">プロバイダとキー</div>
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

                    <div className="llm-sub-label">API キー {p.keys.length}</div>
                    {p.keys.map((k, i) => (
                      <div key={k.name} className={`llm-key ${k.state === "limited" ? "is-limited" : ""}`}>
                        <span className="llm-key-rank">{i + 1}</span>
                        <span className="llm-key-move">
                          <button
                            disabled={busy || i === 0}
                            title="上へ"
                            onClick={() => {
                              const order = p.keys.map((x) => x.name);
                              [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
                              void run("llm.set_key_order", { provider: p.id, order });
                            }}
                          >
                            ▲
                          </button>
                          <button
                            disabled={busy || i === p.keys.length - 1}
                            title="下へ"
                            onClick={() => {
                              const order = p.keys.map((x) => x.name);
                              [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
                              void run("llm.set_key_order", { provider: p.id, order });
                            }}
                          >
                            ▼
                          </button>
                        </span>
                        <span className="llm-key-name">{k.name}</span>
                        <span className="llm-key-scope">
                          {(["host", "worker"] as const).map((scope) => (
                            <button
                              key={scope}
                              className={`llm-key-role ${k[scope] ? "is-on" : ""} ${scope === "worker" ? "is-w" : ""}`}
                              disabled={busy}
                              onClick={() =>
                                void run("llm.set_key_scope", {
                                  provider: p.id,
                                  key: k.name,
                                  scope,
                                  allowed: !k[scope],
                                })
                              }
                            >
                              {scope === "host" ? "番頭" : "職人"}
                            </button>
                          ))}
                        </span>
                        <span className={`llm-key-state is-${k.state}`}>
                          {k.state === "limited"
                            ? `上限 ${timeOf(k.limitedUntil ?? "")}まで`
                            : k.state === "untested"
                              ? "未検証"
                              : "有効"}
                        </span>
                      </div>
                    ))}
                    <div className="llm-key-note">
                      上から順に消費。いま番頭は <code>{hostKey?.name ?? "該当なし"}</code>、職人は{" "}
                      <code>{workerKey?.name ?? "該当なし"}</code>。
                    </div>

                    <div className="llm-sub-label">モデル {models.length}</div>
                    {models.map((m) => {
                      const isHostDef =
                        data.defaults.host?.provider === m.providerId && data.defaults.host?.model === m.id;
                      const tierInfo = data.tiers.find((t) => t.tier === m.tier);
                      const isPick =
                        tierInfo?.pick?.provider === m.providerId && tierInfo?.pick?.model === m.id;
                      return (
                        <div key={`${m.providerId}/${m.id}`} className="llm-model">
                          <span className="llm-model-id">{m.id}</span>
                          {m.vision && <span className="llm-cap">vision</span>}
                          {m.free && <span className="llm-cap">無料</span>}
                          <span className="llm-model-spacer" />
                          <select
                            className={`llm-select llm-select-tier llm-tier-${m.tier}`}
                            disabled={busy}
                            value={m.tier}
                            title="このモデルをどの tier に置くか"
                            onChange={(e) =>
                              void run("llm.set_tier", {
                                provider: m.providerId,
                                model: m.id,
                                tier: e.target.value,
                              })
                            }
                          >
                            {data.tiers.map((t) => (
                              <option key={t.tier} value={t.tier}>
                                {t.label}
                              </option>
                            ))}
                          </select>
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
                        </div>
                      );
                    })}
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
