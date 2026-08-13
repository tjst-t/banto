/**
 * 職人の設定（worker-pool モジュール提供。決定41・決定43 をモジュールへ開放）。
 *
 * 決めるのは3つ:
 *   1. **バックエンド** — 何で職人を動かすか（pi / Claude Code / 将来の Codex）。
 *      使える状態か・入切・割り当ての無い等級のデフォルト
 *   2. **等級ごとのモデル** — どのバックエンドのモデルでも同じ1つの表に並ぶ。
 *      選択肢は「LLM・モデル」で職人に許したもの＋バックエンドが持つ別名
 *   3. **職人の既定の等級**と、畳み忘れの安全弁
 *
 * 項目の並び（`fields`）にしなかったのは、一覧とその中の状態が絡み合うため——
 * 「切ってあるバックエンドのモデルが選べるように見える」「どのバックエンドのモデルか
 * 分からない」が平たい並びでは避けられない。
 *
 * **読み書きは設定画面の口**（`props.settings`）。この面は自分でエンドポイントを叩かない。
 */

import { useState } from "react";
import type { CanvasViewProps } from "./registry.js";
import { Badge, Button, Card, EmptyState, ErrorNote, Note, Scroll, Select, StatusDot, ViewBar, ViewShell } from "./ui.js";
import { Icon } from "../icons.js";

type Tier = "reasoning" | "standard" | "fast";

interface BackendView {
  id: string;
  title: string;
  description?: string;
  available?: boolean;
  detail?: string;
  enabled: boolean;
  isDefault: boolean;
  modelCount: number;
}

interface ModelOption {
  name: string;
  label: string;
  runtime: string;
  runtimeTitle?: string;
  tier?: string;
}

interface Values {
  idleTimeoutMinutes: number;
  defaultTier: Tier | "";
  tiers: Tier[];
  assignments: Partial<Record<Tier, string>>;
  backends: BackendView[];
  models: ModelOption[];
  fallbacks: Partial<Record<Tier, string>>;
  /** 指定しなかった等級を解くバックエンドの名前。 */
  fallbackBackend?: string;
}

const TIER_LABELS: Record<Tier, string> = {
  reasoning: "高精度（reasoning）",
  standard: "通常（standard）",
  fast: "高速（fast）",
};

/** 使えるかどうかの見え方。**確かめていないものを「使える」と言わない**（I1）。 */
function availabilityOf(b: BackendView): { tone: "ok" | "warn" | "neutral"; text: string } {
  if (b.available === true) return { tone: "ok", text: b.detail ?? "使えます" };
  if (b.available === false) return { tone: "warn", text: b.detail ?? "使えません" };
  return { tone: "neutral", text: b.detail ?? "確かめていません" };
}

export function WorkerSettings(props: CanvasViewProps): React.ReactElement {
  const bridge = props.settings;
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  if (!bridge) {
    // I2: 設定の外で開かれたら、空白ではなく理由を出す
    return (
      <ErrorNote title="この面は設定の区画として開きます">
        職人の設定は設定画面から開いてください（キャンバスの面ではありません）。
      </ErrorNote>
    );
  }

  const values = bridge.values as unknown as Values;
  const backends = values.backends ?? [];
  const models = values.models ?? [];
  const tiers = values.tiers ?? (["reasoning", "standard", "fast"] as Tier[]);

  const send = async (update: Record<string, unknown>): Promise<void> => {
    setError(undefined);
    setNotice(undefined);
    try {
      const message = await bridge.save(update);
      setNotice(message ?? "変えました。");
    } catch (err) {
      // I2: 保存できなかったのに保存したように見せない
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** そのモデルはどのバックエンドのものか（切ってあるものは選べない）。 */

  return (
    <ViewShell className="ws-view">
      <ViewBar>
        <span className="llm-sec-label">
          バックエンド {backends.filter((b) => b.enabled).length} / {backends.length} ・ 選べるモデル{" "}
          {models.length}
        </span>
        <span className="cv-spacer" />
        <Button small variant="ghost" disabled={bridge.busy} onClick={() => bridge.reload()}>
          ⟳ 読み直す
        </Button>
      </ViewBar>

      <Scroll pad={false}>
        <div className="llm">
          {error && <ErrorNote onRetry={() => setError(undefined)}>{error}</ErrorNote>}
          {notice && <Note tone="ok">{notice}</Note>}

          {/* ① 何で動かすか */}
          <section className="llm-sec">
            <div className="llm-sec-label">バックエンド</div>
            {backends.length === 0 ? (
              <EmptyState icon="warn" title="バックエンドがありません">
                職人を起こす仕組みが1つも登録されていません（工房の構成を確認してください）。
              </EmptyState>
            ) : (
              backends.map((b) => {
                const state = availabilityOf(b);
                return (
                  <Card key={b.id} className={b.enabled ? "ws-backend" : "ws-backend is-off"}>
                    <div className="ws-backend-head">
                      <StatusDot tone={state.tone} />
                      <span className="ws-backend-name">{b.title}</span>
                      {b.isDefault && <Badge tone="ok">割り当ての無い等級のデフォルト</Badge>}
                      {!b.enabled && <Badge>切ってある</Badge>}
                      <Badge title="この仕組みから選べるモデルの数">{b.modelCount} モデル</Badge>
                      <span className="cv-spacer" />
                      <Button
                        small
                        variant="ghost"
                        disabled={bridge.busy || b.isDefault || !b.enabled}
                        onClick={() => void send({ backends: { [b.id]: { makeDefault: true } } })}
                      >
                        割り当ての無い等級のデフォルトにする
                      </Button>
                      <Button
                        small
                        variant="ghost"
                        disabled={bridge.busy}
                        onClick={() => void send({ backends: { [b.id]: { enabled: !b.enabled } } })}
                      >
                        {b.enabled ? "切る" : "入れる"}
                      </Button>
                    </div>
                    {b.description && <div className="ws-backend-sub">{b.description}</div>}
                    {/* 使える状態かは**確かめられた分だけ**出す（I1） */}
                    <div className={`ws-backend-state is-${state.tone}`}>{state.text}</div>
                  </Card>
                );
              })
            )}
          </section>

          {/* ② どの等級に何を当てるか */}
          <section className="llm-sec">
            <div className="llm-sec-head">
              <span className="llm-sec-label">等級ごとのモデル</span>
              <span className="llm-add-note">
                <strong>「役ごとのモデル」へ移りました</strong>（ADR-0021 決定102）
                ——割り当てはバックエンドを跨ぐ問いなので、番頭と一緒に1枚で選びます。
              </span>
            </div>
            <div className="llm-tiers">
              {tiers.map((tier) => (
                <div key={tier} className="llm-tier-card">
                  <div className="llm-tier-head">
                    <Badge className={`is-tier-${tier}`}>{TIER_LABELS[tier]}</Badge>
                    {values.defaultTier === tier && <Badge tone="ok">職人の既定</Badge>}
                  </div>
                  <div className="llm-tier-pick">
                    {values.assignments?.[tier] ? (
                      <>
                        いま: <code>{values.assignments[tier]}</code>
                      </>
                    ) : (
                      <span className="cv-muted">（割り当てなし）</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="llm-sec">
            <div className="llm-role">
              <span className="llm-role-mark">等</span>
              <div className="llm-role-main">
                <div className="llm-role-name">既定の等級</div>
                <div className="llm-role-sub">
                  タスクにも番頭にも指定が無いときに使う等級
                </div>
              </div>
              <span className="llm-tier-pick">
                {values.defaultTier ? TIER_LABELS[values.defaultTier] : "（指定なし）"}
                <span className="cv-muted">　→「役ごとのモデル」で変えます</span>
              </span>
            </div>
            <div className="llm-role">
              <span className="llm-role-mark">弁</span>
              <div className="llm-role-main">
                <div className="llm-role-name">アイドルの安全弁</div>
                <div className="llm-role-sub">
                  何もしていない職人を畳むまでの時間。**主機構ではない**——畳むのは番頭の判断で、
                  これはその取りこぼしを拾うだけ（0 で切る）
                </div>
              </div>
              <input
                className="sp-input ws-minutes"
                type="number"
                min={0}
                disabled={bridge.busy}
                aria-label="アイドルの安全弁（分）"
                defaultValue={values.idleTimeoutMinutes}
                onBlur={(e) => {
                  const minutes = Number(e.target.value);
                  if (minutes !== values.idleTimeoutMinutes) {
                    void send({ idleTimeoutMinutes: minutes });
                  }
                }}
              />
            </div>
          </section>
        </div>
      </Scroll>
    </ViewShell>
  );
}
