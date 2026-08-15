/**
 * レビュー面（ADR-0013 決定57・59、task-0049・0147）。
 *
 * **判断するための面。** 監査を通ったタスクが並び、経緯・変更の範囲・受け入れ基準・
 * 監査の判定が1つの画面に揃う。**触れる環境があれば開ける**（決定59）——見るだけでなく
 * 触って決める。
 *
 * 3段のレビュー（決定57）がそのまま出る：
 *   - `po` と判定されたものは**番頭には通せない**。判定は工場が機械的に行い、
 *     この画面は結果を描くだけ（D5）——「気づいた人が上げる」形にしない。
 *     **PO 自身は押すだけで通せる**（task-0147、ADR-0023 決定113）——番頭の口
 *     （`kobo.approve`）ではなく PO 専用の HTTP の口を叩く。合言葉は要求せず、
 *     どこから通したか（`via`）を帳簿に残す
 *   - それ以外は通せる。ただし**通しても関所は飛ばない**（マージ前ゲートが後に回る）
 *   - どちらの段でも**差し戻せる**（段2）。通すか差し戻すかが判断で、通すしか押せない面は
 *     判断の片側しか受け取れない
 *
 * データも操作も kobo モジュールの口を通す（決定25）。番頭の Tool は呼ばない。
 */

import { useEffect, useMemo, useState } from "react";
import "./kobo.css";
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
  MetaList,
  Note,
  Scroll,
  SplitView,
  TextInput,
  ViewBar,
  ViewShell,
  formatRelative,
} from "./ui.js";

interface TaskRow {
  taskId: string;
  projectTag: string;
  status: string;
  title: string;
}

interface HistoryRow {
  type: string;
  at: string;
  detail: string;
}

interface TaskDetail {
  task: Record<string, unknown>;
  reviewStage?: string;
  envUrl?: string;
  history: HistoryRow[];
}

/** 判断待ちの状態（決定57 の一次受けが効く範囲）。 */
const WAITING = ["review-ready", "in-review"];

/**
 * PO 専用の承認口（`http-server.ts` の `POST {baseUrl}/projects/:proj/tasks/:id/approve`）。
 *
 * **番頭の Tool 経路ではない**（task-0147 の縛り3）。`kobo.approve` は決定57 により
 * `po` 段のタスクを通せず、この口だけが `approvedBy: "po"` を帳簿に書く。
 *
 * **合言葉は要求しない**（ADR-0023 決定113）。この画面はもともと PO のものなのに
 * 毎回名乗らされるのは「OK を出せない」のと同じだった（imp-0034）。代わりに
 * **どこから通したか**（`via`）を帳簿へ残す——監査可能性は名乗りではなく記録が担う。
 *
 * I2: 断られた理由はそのまま出す。「失敗しました」に潰すと PO は何を直せばよいか分からない。
 */
async function approveAsPo(
  endpoint: string,
  projectTag: string,
  taskId: string,
  note?: string
): Promise<void> {
  const url =
    `${endpoint.replace(/\/$/, "")}/projects/${encodeURIComponent(projectTag)}` +
    `/tasks/${encodeURIComponent(taskId)}/approve`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ via: "ui:kobo.review", ...(note ? { note } : {}) }),
  });
  if (res.ok) return;

  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new Error(body.message ?? body.error ?? res.statusText);
}

export function KoboReview({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialProject = typeof params["projectTag"] === "string" ? params["projectTag"] : undefined;
  const initialTask = typeof params["taskId"] === "string" ? params["taskId"] : undefined;

  const [selected, setSelected] = useState<{ projectTag: string; taskId: string } | undefined>(
    initialProject && initialTask ? { projectTag: initialProject, taskId: initialTask } : undefined
  );
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  /** 片が付いたもの（通した／差し戻した）。どちらを押したかで出す言葉が違う */
  const [done, setDone] = useState<{ taskId: string; kind: "approved" | "sent_back" } | undefined>(
    undefined
  );

  // **判断待ちを探す面なので、既定のまま引く**（prop-0001 第1段）。
  // 片が付いたタスクで 100 件の枠を埋めると、判断待ちが押し出される
  const list = useModuleTool<{ tasks: TaskRow[] }>(endpoint, "kobo.list", {
    limit: 100,
    ...(initialProject ? { projectTag: initialProject } : {}),
  });
  const detail = useModuleTool<TaskDetail>(
    endpoint,
    "kobo.task",
    selected ? { projectTag: selected.projectTag, taskId: selected.taskId } : undefined
  );

  // 判断待ちは待っている間に増える。**開きっぱなしで気づける**ように取り直す
  const reloadList = list.reload;
  useEffect(() => {
    const timer = setInterval(() => reloadList(), 8000);
    return () => clearInterval(timer);
  }, [reloadList]);

  const waiting = useMemo(
    () => (list.data?.tasks ?? []).filter((t) => WAITING.includes(t.status)),
    [list.data]
  );

  /**
   * **先頭を自動で開く**（PO報告 2026-08-07）。
   *
   * ここは決めるために来る面で、着いた先が「選んでください」の空白では一往復無駄になる。
   * 判断待ちが1件でもあれば、その1件を開いた状態で差し出す。
   * **選び直しは自由**——選んだものが列から消えたら（通した・取次へ上げた）また先頭へ。
   */
  useEffect(() => {
    if (waiting.length === 0) return;
    const stillThere =
      selected &&
      waiting.some((t) => t.taskId === selected.taskId && t.projectTag === selected.projectTag);
    if (stillThere) return;
    const head = waiting[0]!;
    setSelected({ projectTag: head.projectTag, taskId: head.taskId });
  }, [waiting, selected]);

  /** 押したあとの後始末。どの操作でも同じ（一覧と詳細を取り直す） */
  const finish = (taskId: string, kind: "approved" | "sent_back"): void => {
    setDone({ taskId, kind });
    setNote("");
    setReason("");
    list.reload();
    detail.reload();
  };

  const approve = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await callModuleTool(endpoint, "kobo.approve", {
        projectTag: selected.projectTag,
        taskId: selected.taskId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      finish(selected.taskId, "approved");
    } catch (err) {
      // I2: 押したのに何も起きなかったように見せない。理由をそのまま出す
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * PO 自身が通す（task-0147）。**番頭の口とは別の口**——決定57 により
   * `kobo.approve` は `po` 段のタスクを通せない。押せるのはこの面を見ている人だけで、
   * 番頭のモデルからは呼べない（Tool ではないので在庫に載らない）。
   */
  const approveAsPoAction = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await approveAsPo(endpoint, selected.projectTag, selected.taskId, note.trim() || undefined);
      finish(selected.taskId, "approved");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 実装へ差し戻す（段2）。**契約は変えない**——スコープや受け入れ基準を直すのは
   * `kobo.amend` の領分で、ここは同じ契約のまま次の試行を起こすだけ。
   * 理由は職人にそのまま渡るので、空では押せない。
   */
  const sendBack = async (): Promise<void> => {
    if (!selected || !reason.trim()) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await callModuleTool(endpoint, "kobo.send_back", {
        projectTag: selected.projectTag,
        taskId: selected.taskId,
        reason: reason.trim(),
      });
      finish(selected.taskId, "sent_back");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const listPane = (
    <ViewShell>
      <ViewBar>
        <strong>判断待ち</strong>
        <Badge tone={waiting.length > 0 ? "warn" : "neutral"}>{waiting.length}</Badge>
      </ViewBar>
      {list.loading && !list.data ? (
        <Loading label="工場に聞いています…" />
      ) : list.error ? (
        <ErrorNote title="工場に届きません" onRetry={list.reload}>
          {list.error}
        </ErrorNote>
      ) : waiting.length === 0 ? (
        <EmptyState icon="check" title="判断待ちはありません">
          監査を通ったものがここに並びます。
        </EmptyState>
      ) : (
        <Scroll>
          {waiting.map((task) => (
            <Card
              key={`${task.projectTag}/${task.taskId}`}
              tone="warn"
              selected={selected?.taskId === task.taskId && selected?.projectTag === task.projectTag}
              onClick={() => {
                setSelected({ projectTag: task.projectTag, taskId: task.taskId });
                setActionError(undefined);
                setDone(undefined);
              }}
            >
              <div className="kb-card-title">{task.title || task.taskId}</div>
              <div className="kb-card-meta">
                <span className="is-mono">{task.taskId}</span>
                <span>{task.projectTag}</span>
              </div>
            </Card>
          ))}
        </Scroll>
      )}
    </ViewShell>
  );

  const task = detail.data?.task as Record<string, unknown> | undefined;
  const scope = (task?.["scope"] as { paths?: string[] } | undefined)?.paths ?? [];
  const acceptance = Array.isArray(task?.["acceptance"])
    ? (task["acceptance"] as Array<{ id?: string; text?: string; verify?: string }>)
    : [];
  const verdicts = (detail.data?.history ?? []).filter((h) => h.type === "audit_verdict");
  const forPo = detail.data?.reviewStage === "po";
  const stillWaiting = WAITING.includes(String(task?.["status"] ?? ""));

  const detailPane = !selected ? (
    <EmptyState icon="canvas" title="判断するものを選ぶ">
      経緯・変更の範囲・監査の結果が並びます。
    </EmptyState>
  ) : detail.loading && !detail.data ? (
    <Loading label="読み込んでいます…" />
  ) : detail.error ? (
    <ErrorNote title="読めません" onRetry={detail.reload}>
      {detail.error}
    </ErrorNote>
  ) : (
    <ViewShell>
      <ViewBar>
        <strong>{String(task?.["title"] ?? selected.taskId)}</strong>
        <Badge tone={forPo ? "danger" : "warn"}>{forPo ? "PO の判断が要る" : "あなたが一次受け"}</Badge>
      </ViewBar>
      <Scroll>
        {typeof task?.["originRef"] === "string" && (
          <section>
            <h3 className="kb-h">経緯</h3>
            <p className="kb-para">{String(task["originRef"])}</p>
          </section>
        )}

        <section>
          <h3 className="kb-h">起きたこと</h3>
          <p className="kb-para">
            実装が終わり、<strong>別セッションの監査を通りました</strong>
            （実装者とは別の目で見ています）。
          </p>
          {verdicts.length > 0 && (
            <Disclosure summary={`監査の記録（${verdicts.length}件）`}>
              <ol className="kb-history">
                {verdicts.map((v, index) => (
                  <li key={`${v.at}-${index}`}>
                    <span className="kb-history-at">{formatRelative(v.at)}</span>
                    <span className="kb-history-detail">{v.detail}</span>
                  </li>
                ))}
              </ol>
            </Disclosure>
          )}
        </section>

        <MetaList
          items={[
            { label: "ID", value: selected.taskId, mono: true },
            { label: "状態", value: String(task?.["status"] ?? "—") },
            { label: "変更の範囲", value: scope.join(", ") || "—", mono: true },
            ...(detail.data?.envUrl
              ? [
                  {
                    label: "触れる場所",
                    value: (
                      // 決定59: 見るだけでなく触れる状態で差し出す
                      <a href={detail.data.envUrl} target="_blank" rel="noreferrer">
                        開く（判断が付くと畳まれます）
                      </a>
                    ),
                  },
                ]
              : []),
          ]}
        />

        {acceptance.length > 0 && (
          <section>
            <h3 className="kb-h">受け入れ基準</h3>
            <ul className="kb-acceptance">
              {acceptance.map((a, index) => (
                <li key={a.id ?? index}>
                  <span>{a.text}</span>
                  {a.verify && <code className="kb-verify">{a.verify}</code>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="kb-h">求める判断</h3>
          {forPo ? (
            <Note tone="warn">
              これは <strong>PO の判断が要る</strong>もの（統治コード、または PO 必須の面に
              触る）です。番頭は通せません——番頭は経緯・変更点・懸念をまとめて取次へ上げ、
              <strong>PO は合言葉を入れてここから通せます</strong>。
            </Note>
          ) : (
            <Note tone="neutral">
              良ければ通してください。<strong>通しても関所は飛びません</strong>——この後
              マージ前ゲート（スコープ違反の検査と検証コマンド）が回ります。
            </Note>
          )}

          {done?.taskId === selected.taskId ? (
            <Note tone="ok">
              {done.kind === "approved"
                ? "通しました。マージキューへ入りました。"
                : "差し戻しました。契約はそのままで、職人がもう一度直します。"}
            </Note>
          ) : (
            stillWaiting && (
              <>
                <div className="kb-actions">
                  <TextInput
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="何を見て良しとしたか（帳簿に残ります）"
                  />
                  {forPo ? (
                    /* 決定113: 合言葉は要らない。押した事実が `via` として帳簿に残る */
                    <Button
                      variant="primary"
                      onClick={() => void approveAsPoAction()}
                      disabled={busy}
                    >
                      {busy ? "通しています…" : "PO として通す"}
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => void approve()} disabled={busy}>
                      {busy ? "通しています…" : "通す"}
                    </Button>
                  )}
                </div>

                {/* 段2: 判断の片側（通さない方）。契約は変えずに実装へ戻す */}
                <div className="kb-actions">
                  <TextInput
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="何が駄目で、どう直すのか（職人にそのまま渡ります）"
                  />
                  <Button
                    variant="default"
                    onClick={() => void sendBack()}
                    disabled={busy || reason.trim().length === 0}
                  >
                    {busy ? "戻しています…" : "差し戻す"}
                  </Button>
                </div>
              </>
            )
          )}
          {actionError && <ErrorNote title="押せませんでした">{actionError}</ErrorNote>}
        </section>
      </Scroll>
    </ViewShell>
  );

  const split = (
    <SplitView
      size="md"
      list={listPane}
      detail={detailPane}
      showDetail={selected !== undefined}
      onBack={() => setSelected(undefined)}
      backLabel="一覧へ"
    />
  );

  // **判断待ちが無いときに2枚は要らない**（PO報告 2026-08-07）。
  // 「ありません」と「選んでください」が並んで、面の全部が空白になっていた
  if (!list.loading && !list.error && waiting.length === 0) {
    return (
      <ViewShell>
        <ViewBar>
          <strong>判断待ち</strong>
          <Badge tone="neutral">0</Badge>
        </ViewBar>
        <EmptyState icon="check" title="判断待ちはありません">
          監査を通ったものがここに並びます。工場のボードで流れ全体が見られます。
        </EmptyState>
      </ViewShell>
    );
  }

  return split;
}
