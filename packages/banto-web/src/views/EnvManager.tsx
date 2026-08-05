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
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  Note,
  Scroll,
  SectionHead,
  TextInput,
  Toggle,
  ViewBar,
  ViewShell,
  ViewTitle,
  formatTime,
  useAction,
  useTicker,
  type Tone,
} from "./ui.js";

interface EnvSummary {
  envId: string;
  profile: string;
  driver: string;
  taskId: string;
  projectTag: string;
  workdir?: string;
  url?: string;
  exposedPort?: number;
  exposer?: string;
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

const STATE: Record<EnvSummary["state"], { label: string; tone: Tone }> = {
  live: { label: "動いている", tone: "ok" },
  "torn-down": { label: "畳み済み", tone: "neutral" },
  "teardown-failed": { label: "畳み損ね", tone: "danger" },
};

/** 期限までの残り。**過ぎているものは過ぎたと言う**（I1：黙って0にしない）。 */
function ttlOf(deadline: string, now: number): { text: string; className: string } {
  const at = new Date(deadline).getTime();
  if (Number.isNaN(at)) return { text: deadline, className: "" };
  const left = at - now;
  if (left <= 0) return { text: "期限切れ", className: "is-over" };
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return { text: `あと${minutes}分`, className: minutes <= 15 ? "is-soon" : "" };
  const hours = left / 3_600_000;
  return { text: `あと${hours < 10 ? hours.toFixed(1) : Math.round(hours)}時間`, className: "" };
}

function formatMs(ms: number): string {
  const hours = ms / 3600_000;
  return hours >= 1 ? `${Number(hours.toFixed(1))}時間` : `${Math.round(ms / 60_000)}分`;
}

export function EnvManager({ endpoint, endpointOf }: CanvasViewProps): React.ReactElement {
  const [includeTornDown, setIncludeTornDown] = useState(false);
  const list = useModuleTool<EnvList>(endpoint, "env.list", { includeTornDown });
  const action = useAction();
  const now = useTicker(15_000);
  /** 環境ごとの健康状態（押したときだけ確かめる。一覧の表示で毎回叩かない）。 */
  const [health, setHealth] = useState<Record<string, { ok: boolean; detail?: string }>>({});
  /** 環境ごとに走らせたコマンドと、その結果のログ。 */
  const [command, setCommand] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<
    Record<string, { exit: number; logTail: string; truncated: boolean }>
  >({});

  // 場所の一覧は workspace が持っている（決定25：URLは直書きしない）
  const workspace = endpointOf("workspace");
  const selection = usePlaceSelection(workspace ?? endpoint);
  const chosen = selection.current;
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

  const checkHealth = (envId: string): void => {
    void action.run(
      `health:${envId}`,
      () => callModuleTool<{ ok: boolean; detail?: string }>(endpoint, "env.healthcheck", { envId }),
      (result) => {
        setHealth((prev) => ({ ...prev, [envId]: result as { ok: boolean; detail?: string } }));
      }
    );
  };

  const run = (envId: string): void => {
    const cmd = (command[envId] ?? "").trim();
    if (cmd.length === 0) return;
    void action.run(
      `run:${envId}`,
      () =>
        callModuleTool<{ exit: number; logTail: string; truncated: boolean }>(endpoint, "env.run", {
          envId,
          cmd,
        }),
      (result) => {
        setOutput((prev) => ({
          ...prev,
          [envId]: result as { exit: number; logTail: string; truncated: boolean },
        }));
      }
    );
  };

  const teardown = (envId: string): void => {
    void action.run(
      envId,
      async () => {
        await callModuleTool(endpoint, "env.teardown", { envId });
        list.reload();
      },
      () => "畳みました。"
    );
  };

  return (
    <ViewShell className="em">
      <ViewBar>
        <ViewTitle icon="🧫" count={live.length}>
          検証環境
        </ViewTitle>
        <span className="cv-spacer" />
        <Toggle
          checked={includeTornDown}
          onChange={setIncludeTornDown}
          title="畳み終わった環境も一覧に出す"
        >
          畳んだ環境も表示
        </Toggle>
        <Button small variant="ghost" onClick={() => list.reload()} title="取り直す">
          ⟳
        </Button>
      </ViewBar>

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}
      {action.error && <ErrorNote onRetry={action.clearError}>{action.error}</ErrorNote>}

      <Scroll>
        {/* 畳み損ねは一番上に出す。放っておくと費用がかかり続ける（I3） */}
        {stuck.length > 0 && (
          <Note tone="danger" icon="⚠">
            畳めなかった環境が {stuck.length} 件あります。外にリソースが残っている可能性が
            あるので、畳み直すか手元で確認してください。
          </Note>
        )}

        <SectionHead count={environments.length}>いま立っている環境</SectionHead>
        {list.loading && !list.data ? (
          <Loading rows={3} />
        ) : environments.length === 0 ? (
          <EmptyState icon="🧫" title="立っている環境はありません">
            番頭に「テストが通るか確かめて」と頼むと、機構が立てて走らせ、必ず畳みます。
          </EmptyState>
        ) : (
          <div className="cv-cards">
            {environments.map((e) => {
              const state = STATE[e.state];
              const ttl = ttlOf(e.ttlDeadline, now);
              const isLive = e.state !== "torn-down";
              return (
                <Card key={e.envId} tone={e.state === "teardown-failed" ? "danger" : undefined}>
                  <div className="em-head">
                    <span className="em-profile">{e.profile}</span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <Badge>{e.driver}</Badge>
                    <span className="cv-spacer" />
                    {isLive && (
                      <span className={`em-ttl ${ttl.className}`} title={`期限 ${formatTime(e.ttlDeadline)}`}>
                        ⏱ {ttl.text}
                      </span>
                    )}
                  </div>
                  <div className="cv-muted">
                    {e.taskId} · {e.projectTag} · <code className="cv-mono">{e.envId}</code>
                  </div>
                  {e.workdir && <div className="rm-path">{e.workdir}</div>}

                  {e.url && e.state === "live" && (
                    <div className="em-url">
                      <a href={e.url} target="_blank" rel="noreferrer">
                        ↗ ブラウザで開く
                      </a>
                      <span className="cv-muted">
                        {e.url}
                        {e.exposer ? `（${e.exposer === "caddy" ? "caddy" : "proxy"}）` : ""}
                      </span>
                    </div>
                  )}

                  {isLive && (
                    <>
                      <div className="em-actions">
                        <Button
                          small
                          disabled={action.busy === `health:${e.envId}`}
                          onClick={() => checkHealth(e.envId)}
                        >
                          {action.busy === `health:${e.envId}` ? "確認中…" : "状態を確かめる"}
                        </Button>
                        {health[e.envId] && (
                          <Badge tone={health[e.envId]!.ok ? "ok" : "danger"}>
                            {health[e.envId]!.ok ? "使えます" : "使えません"}
                            {health[e.envId]!.detail ? `（${health[e.envId]!.detail}）` : ""}
                          </Badge>
                        )}
                        <span className="cv-spacer" />
                        <Button
                          small
                          variant="danger"
                          disabled={action.busy === e.envId}
                          onClick={() => teardown(e.envId)}
                        >
                          {action.busy === e.envId ? "畳んでいます…" : "畳む"}
                        </Button>
                      </div>

                      {/* この環境の中でコマンドを走らせて、その出力を見る（spec §6） */}
                      <div className="em-run">
                        <TextInput
                          placeholder="この環境で走らせるコマンド（例: npm test）"
                          value={command[e.envId] ?? ""}
                          onChange={(ev) =>
                            setCommand((prev) => ({ ...prev, [e.envId]: ev.target.value }))
                          }
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" && !ev.nativeEvent.isComposing) run(e.envId);
                          }}
                        />
                        <Button
                          disabled={
                            action.busy === `run:${e.envId}` || (command[e.envId] ?? "").trim() === ""
                          }
                          onClick={() => run(e.envId)}
                        >
                          {action.busy === `run:${e.envId}` ? "実行中…" : "走らせる"}
                        </Button>
                      </div>
                      {output[e.envId] && (
                        <div className="em-output">
                          <Badge tone={output[e.envId]!.exit === 0 ? "ok" : "danger"}>
                            終了コード {output[e.envId]!.exit}
                            {output[e.envId]!.truncated ? "（ログは末尾のみ）" : ""}
                          </Badge>
                          <pre className="cv-pre" style={{ marginTop: 6 }}>
                            {output[e.envId]!.logTail || "（出力なし）"}
                          </pre>
                        </div>
                      )}
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {limits && (
          <p className="cv-muted" style={{ marginTop: 10, lineHeight: 1.8 }}>
            同時上限: 全体 {limits.maxInstancesTotal} / プロファイルごと {limits.maxInstancesPerProfile}
            ・ 既定TTL {formatMs(limits.defaultTtlMs)}（最大 {formatMs(limits.maxTtlMs)}）
            ・ アドホック: {limits.adhocDrivers}
          </p>
        )}

        <SectionHead
          count={profiles.data?.usable.length}
          actions={workspace ? <PlacePicker selection={selection} title="どのリポジトリの定義を見るか" /> : undefined}
        >
          プロファイル
        </SectionHead>
        {!workspace ? (
          <p className="cv-muted">場所の一覧を出せません（workspace モジュールが居ません）。</p>
        ) : profiles.error ? (
          <ErrorNote onRetry={profiles.reload}>{profiles.error}</ErrorNote>
        ) : (
          <>
            {(profiles.data?.usable ?? []).length === 0 ? (
              <p className="cv-muted">
                この場所には検証環境の定義がありません（<code className="cv-mono">meta/environments.yaml</code>）。
              </p>
            ) : (
              <div className="cv-cards">
                {(profiles.data?.usable ?? []).map((p) => (
                  <Card key={p.name}>
                    <div className="em-head">
                      <span className="em-profile">{p.name}</span>
                      <Badge>{p.driver}</Badge>
                      <span className="cv-spacer" />
                      <span className="cv-muted">TTL {formatMs(p.ttlMs)}</span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            {/* 上限で弾かれたものを黙って隠さない。書いた人が直せるように理由ごと出す（I2） */}
            {(profiles.data?.rejected ?? []).map((r) => (
              <Note key={r.name} tone="warn" icon="⚠">
                <strong>{r.name}</strong> は使えません: {r.reason}
              </Note>
            ))}
          </>
        )}

        <p className="cv-muted" style={{ marginTop: 14, lineHeight: 1.8 }}>
          環境を立てるのは番頭に頼んでください（<code className="cv-mono">env.verify</code> なら畳むところまで
          機構がやります）。ブラウザで自分の目で見たいときは「expose にポートを渡して」と頼むと、
          ここに開くリンクが出ます。
        </p>
      </Scroll>
    </ViewShell>
  );
}
