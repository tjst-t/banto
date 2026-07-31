/**
 * 検証環境の管理画面（environment-pool モジュール提供・ADR-0010 決定32・34）。
 *
 * **この画面の一番の役目は畳み忘れを見えるようにすること**（I3：外部リソースの消し忘れは
 * 金銭的実害で、`spec-environment` で最も優先度の高い機構）。立っている環境・期限・
 * 畳み損ねが一目で分かり、その場で畳める。
 *
 * プロファイルの一覧は場所を選んで引く（決定34c：在り処は呼び出し側が渡す）。
 * 場所の一覧は workspace モジュールが持っているので、`endpointOf` でそちらの到達先を引く
 * ——URLは直書きしない（決定25）。
 */

import { useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import { PlacePicker, usePlaceSelection } from "./PlacePicker.js";
import type { CanvasViewProps } from "./registry.js";

interface EnvSummary {
  envId: string;
  profile: string;
  driver: string;
  taskId: string;
  projectTag: string;
  workdir?: string;
  url?: string;
  exposedPort?: number;
  createdAt: string;
  ttlDeadline: string;
  state: "live" | "torn-down" | "teardown-failed";
}
interface Limits {
  defaultTtlMs: number;
  maxTtlMs: number;
  maxInstancesPerProfile: number;
  maxInstancesTotal: number;
  adhocDrivers: string;
}
interface EnvList {
  environments: EnvSummary[];
  limits: Limits;
}
interface ProfileList {
  usable: Array<{ name: string; driver: string; ttlMs: number }>;
  rejected: Array<{ name: string; reason: string }>;
}

const STATE_LABEL: Record<EnvSummary["state"], string> = {
  live: "動いている",
  "torn-down": "畳み済み",
  "teardown-failed": "畳み損ね",
};

export function EnvManager({ endpoint, endpointOf }: CanvasViewProps): React.ReactElement {
  const [includeTornDown, setIncludeTornDown] = useState(false);
  const list = useModuleTool<EnvList>(endpoint, "env.list", { includeTornDown });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  // 場所の一覧は workspace が持っている（決定25：URLは直書きしない）
  const workspace = endpointOf("workspace");
  const selection = usePlaceSelection(workspace ?? endpoint);
  const chosen = selection.places.find((p) => p.id === selection.place);
  const profiles = useModuleTool<ProfileList>(
    endpoint,
    "env.list_profiles",
    chosen ? { repoPath: chosen.path } : {},
    workspace !== undefined && chosen !== undefined
  );

  const environments = list.data?.environments ?? [];
  const limits = list.data?.limits;
  const live = environments.filter((e) => e.state === "live");
  const stuck = environments.filter((e) => e.state === "teardown-failed");

  const teardown = async (envId: string): Promise<void> => {
    setBusy(envId);
    setError(undefined);
    try {
      await callModuleTool(endpoint, "env.teardown", { envId });
      list.reload();
    } catch (err) {
      // I2: 畳めなかったことを黙って一覧の更新だけで済ませない
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="st">
      <div className="st-head">
        <span className="st-title">検証環境</span>
        <span className="gv3-count">{live.length}</span>
        <label className="wv-toggle" title="畳んだものも一覧に出す">
          <input
            type="checkbox"
            checked={includeTornDown}
            onChange={(e) => setIncludeTornDown(e.target.checked)}
          />
          畳んだものも含む
        </label>
        <button className="gv3-clear" onClick={() => list.reload()}>
          取り直す
        </button>
      </div>

      {(list.error || error) && <div className="fb-error">{list.error ?? error}</div>}

      {/* 畳み損ねは一番上に出す。放っておくと費用がかかり続ける（I3） */}
      {stuck.length > 0 && (
        <div className="pp-warn em-stuck">
          畳めなかった環境が {stuck.length} 件あります。外にリソースが残っている可能性が
          あるので、畳み直すか手元で確認してください
        </div>
      )}

      <section className="pp-section">
        <h3 className="pp-heading">いま立っている環境</h3>
        {environments.length === 0 ? (
          <p className="fb-muted st-empty">
            {list.loading ? "読み込み中…" : "立っている環境はありません"}
          </p>
        ) : (
          <ul className="pp-list">
            {environments.map((e) => (
              <li key={e.envId} className="pp-item">
                <div className="pp-place">
                  {e.profile}
                  <span className={`em-state em-${e.state}`}>{STATE_LABEL[e.state]}</span>
                </div>
                <div className="pp-reason">
                  {e.envId} / {e.taskId} / 期限 {formatTime(e.ttlDeadline)}
                </div>
                {e.workdir && <div className="rm-path">{e.workdir}</div>}
                {e.url && e.state === "live" && (
                  <div className="em-url">
                    <a href={e.url} target="_blank" rel="noreferrer">
                      開く（{e.url}）
                    </a>
                  </div>
                )}
                {e.state !== "torn-down" && (
                  <div className="pp-actions">
                    <button
                      className="pp-deny"
                      disabled={busy === e.envId}
                      onClick={() => teardown(e.envId)}
                    >
                      畳む
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {limits && (
          <p className="fb-muted">
            同時上限: 全体 {limits.maxInstancesTotal} / プロファイルごと{" "}
            {limits.maxInstancesPerProfile} ・ 既定TTL {formatMs(limits.defaultTtlMs)}（最大{" "}
            {formatMs(limits.maxTtlMs)}） ・ アドホック: {limits.adhocDrivers}
          </p>
        )}
      </section>

      <section className="pp-section">
        <h3 className="pp-heading">
          プロファイル
          {workspace && <PlacePicker selection={selection} title="どのリポジトリの定義を見るか" />}
        </h3>
        {!workspace ? (
          <p className="fb-muted st-empty">場所の一覧を出せません（workspace モジュールが居ません）</p>
        ) : profiles.error ? (
          <div className="fb-error">{profiles.error}</div>
        ) : (
          <>
            {(profiles.data?.usable ?? []).length === 0 && (
              <p className="fb-muted st-empty">
                この場所には検証環境の定義がありません（meta/environments.yaml）
              </p>
            )}
            <ul className="pp-list">
              {(profiles.data?.usable ?? []).map((p) => (
                <li key={p.name} className="pp-item">
                  <div className="pp-place">{p.name}</div>
                  <div className="pp-reason">
                    {p.driver} / TTL {formatMs(p.ttlMs)}
                  </div>
                </li>
              ))}
            </ul>
            {/* 上限で弾かれたものを黙って隠さない。書いた人が直せるように理由ごと出す（I2） */}
            {(profiles.data?.rejected ?? []).map((r) => (
              <div key={r.name} className="pp-warn">
                <strong>{r.name}</strong> は使えません: {r.reason}
              </div>
            ))}
          </>
        )}
        <p className="fb-muted">
          環境を立てるのは番頭に頼んでください（env.verify なら畳むところまで機構がやります）。
          ブラウザで自分の目で見たいときは「expose にポートを渡して」と頼むと、ここに開くリンクが出ます
        </p>
      </section>
    </div>
  );
}

function formatMs(ms: number): string {
  const hours = ms / 3600_000;
  return hours >= 1 ? `${Number(hours.toFixed(1))}時間` : `${Math.round(ms / 60_000)}分`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP", { hour12: false });
}
