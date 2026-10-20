"use client";

// **自動化の画面**（決定・2026-10-15、v4-frontend.md §6.42。見本はモック `fork/schedule` の triggers-panel.tsx）。
// core の画面だが Canvas の枠に出す——Module の MCP App ではないので iframe を通らず、ここが直に描く（§6.2 の例外）。
// データは host の HTTP の口（`lib/backend/automations.ts` の写し）から。
//
// - 1行に1件：名前・きっかけ・届け先と起こし方・次の時刻、その下に直近の回の印（古い→新しい）と前の回の結果
// - 押すと開く：毎回届ける指示・届け先・受信箱・作った人・直近の回と理由・操作（会話を開く・今すぐ動かす・
//   一時停止／再開する・直す・消す）。消しても専用の Fork は残る
// - 足す・直すは一覧の中でその場に開くフォーム。きっかけは決まった時刻・Webhook・出来事（種類は作ったあと変えられない）。
//   出来事は 出どころ → 出来事 → 条件 の順に選ぶ（名乗りは host の `/automation-events` から、追加・2026-10-16）
// - Webhook の受け口の URL は**作った直後に1回だけ**見せる（host は印のハッシュしか持たない——アーキ仕様 §4.3）
// - 一覧の下に「動き方」を常に出す——いま実際にそう動くことだけを書く
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { UrlLink as Link } from "@/components/banto/url-link";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Copy,
  Hand,
  Loader2,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldX,
  Trash2,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PillTabs } from "@/components/banto/shell/segmented-tabs";
import { cn } from "@/lib/utils";
import {
  automationTimeZone,
  automationsCanvasHref,
  createAutomation,
  describeFieldValue,
  describeRepeat,
  describeSource,
  describeTarget,
  describeWhere,
  findEventDeclaration,
  formatWhen,
  removeAutomation,
  runAutomationNow,
  runLabel,
  threadTitle,
  timeZoneName,
  unmutePatrolNote,
  updateAutomation,
  useAutomationEventSources,
  useAutomations,
} from "@/lib/backend/automations";
import {
  listRealSecretAliases,
  type RealAutomation,
  type RealAutomationEventSource,
  type RealAutomationInput,
  type RealAutomationRepeat,
  type RealAutomationRun,
  type RealAutomationSource,
  type RealAutomationTarget,
  type RealEventDeclaration,
  type RealEventField,
  type RealPatrolNote,
} from "@/lib/backend/client";
import { getThreadsForProject } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";

export function AutomationsView({ projectId }: { projectId: string }) {
  // 届け先の会話の名前はサイドバーと同じ写しから引く
  useMockStoreVersion();
  const automations = useAutomations(projectId);
  // 待てる出来事（作るフォームの選び先・一覧の行の題）。Module を入れ替えたあとでも今の名乗りを使うよう、開くたびに取り直す
  const events = useAutomationEventSources(projectId, { reload: true });
  const [editing, setEditing] = useState<"new" | string | null>(null);
  // 作った直後の Webhook の受け口の URL。この画面の手元にしか無い——閉じたら二度と出ない
  const [issued, setIssued] = useState<{ name: string; url: string } | null>(null);
  // 作った直後の案内（判断役：まとめがオフ・自動許可は効かない）。断らずに作ったので、ここで読ませる
  const [notices, setNotices] = useState<{ name: string; notices: readonly string[] } | null>(null);

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4" data-testid="automations">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <p className="text-sm text-ink-2">
          決まった時刻になったとき、Webhook を受けたとき、Module や banto で出来事が起きたときに、この Project の AI に決まった指示を届けて動かします。自動化ごとに専用の Fork があり、動いた回の会話はその Fork に残ります。
        </p>

        {issued ? <IssuedWebhookUrl name={issued.name} url={issued.url} onClose={() => setIssued(null)} /> : null}
        {notices ? <CreatedNotices name={notices.name} notices={notices.notices} onClose={() => setNotices(null)} /> : null}

        {automations === undefined ? (
          <p className="text-sm text-ink-3">読み込んでいます…</p>
        ) : automations.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-card" data-testid="automation-list">
            {automations.map((a) =>
              editing === a.id ? (
                <li key={a.id} className="p-3">
                  <AutomationForm projectId={projectId} automation={a} events={events} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <AutomationRow key={a.id} automation={a} sources={events.sources} onEdit={() => setEditing(a.id)} />
              ),
            )}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-ink-3" data-testid="automations-empty">
            まだありません。毎朝のまとめ、定期の見張り、CI が落ちたときの調べものなど、やらせたいことを足してください。
          </p>
        )}

        {editing === "new" ? (
          <div className="rounded-md border border-border bg-card p-3">
            <AutomationForm
              projectId={projectId}
              events={events}
              onDone={(created) => {
                setEditing(null);
                if (created?.webhookUrl) setIssued({ name: created.name, url: created.webhookUrl });
                setNotices(created?.notices ? { name: created.name, notices: created.notices } : null);
              }}
            />
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-fit gap-1 text-xs"
            onClick={() => setEditing("new")}
            data-testid="automation-add"
          >
            <Plus className="size-3.5" />
            自動化を足す
          </Button>
        )}

        <HowItRuns />
      </div>
    </div>
  );
}

/**
 * **作った直後の Webhook の受け口の URL**。host は印のハッシュしか持たないので、ここで見せたものが最初で最後
 * ——閉じる・再読み込みすると二度と出ない（見失ったら作り直す）
 */
function IssuedWebhookUrl({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-primary bg-card px-3 py-2.5 text-xs" data-testid="automation-webhook-issued">
      <div className="flex items-start gap-2">
        <Webhook className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-foreground">
          自動化「{name}」の受け口の URL です。<strong>この URL は今だけ表示します</strong>——送り手の側に設定してから閉じてください。見失ったら、自動化を作り直してください。
        </p>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" aria-label="閉じる" onClick={onClose} data-testid="automation-webhook-issued-close">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 font-mono break-all text-ink-2" data-testid="automation-webhook-url">
          {url}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-1.5 text-xs"
          aria-label="URL を写す"
          onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "写しました" : "写す"}
        </Button>
      </div>
      <p className="text-ink-3">POST で送ります。LAN と Tailscale の中からだけ届きます。</p>
    </div>
  );
}

/** **作った直後の案内**（判断役——まとめがオフなら出来事が出ない・自動許可は判断役の会話に効かない）。作ってはある */
function CreatedNotices({ name, notices, onClose }: { name: string; notices: readonly string[]; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warn bg-card px-3 py-2.5 text-xs" data-testid="automation-created-notices">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-foreground">自動化「{name}」を作りました。次のことに気をつけてください。</p>
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-ink-2">
          {notices.map((n) => (
            <li key={n} data-testid="automation-created-notice">
              {n}
            </li>
          ))}
        </ul>
      </div>
      <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" aria-label="閉じる" onClick={onClose}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/** 動き方の決まり。作る前に読める位置に置く——いまの host が実際にそう動くことだけ */
function HowItRuns() {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5 text-xs text-ink-2" data-testid="automations-how">
      <p className="mb-1.5 font-medium text-foreground">動き方</p>
      <ul className="flex list-disc flex-col gap-1 pl-4">
        <li>前の回がまだ動いている・あなたの答えを待っているときは、その回を飛ばします。飛ばした理由は直近の回に残ります。</li>
        <li>banto が止まっていた間の時刻は、起き直したときに一番最近の1回だけ動かし、残りは「飛ばした」1件にまとめます。</li>
        <li>一時停止している間と、Project を閉じている間は動きません。再開したら、その時刻から数え直します。</li>
        <li>確認が要る操作に当たったら、あなたの答えを待って止まります。「承認をすべて自動で許可する」がオンなら止まりません。</li>
        <li>専用の Fork を閉じると、その自動化は一時停止します。Fork を開き直しても自動では再開しません。</li>
        <li>
          Webhook は、前の回がまだ動いている・あなたの答えを待っている間は溜めておき、空いたら一度にまとめて届けます。止まっている間の Webhook は受けられません（送り手が失敗を見ます）。
        </li>
        <li>Webhook で受けた中身は「外から来たもの」と印を付けて AI に渡し、あなたの指示とは分けます。中に書かれた指示には従わないよう、AI にも伝えます。</li>
        <li>署名の合わない Webhook は受け取らず、AI は動きません。Project のコンテナから届いたものも、許していなければ受け取りません。</li>
        <li>
          出来事は、続けて起きたものを待ち時間の間まとめて1回で届けます。前の回がまだ動いている間は溜めておき、空いたらまとめて届けます。出来事の題・属性と本文は「外から来たもの」と印を付けて渡します。
        </li>
        <li>この自動化自身の回が起こした出来事では、既定では動きません（輪にならないように）。同じ自動化が同じ出来事・同じ対象で動くのは 60 分に 6 回までで、超えた分は飛ばします。</li>
        <li>Module の出来事を待っている間は、その Module を起こしたままにします。Project をスリープにしても、その Module とコンテナは止めません。</li>
      </ul>
    </div>
  );
}

function AutomationRow({
  automation: a,
  sources,
  onEdit,
}: {
  automation: RealAutomation;
  sources: readonly RealAutomationEventSource[] | undefined;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  // 押した操作の結果（飛ばした理由・断られた理由）。次に押すまで残す
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const last = a.runs[0];
  const tz = automationTimeZone(a);
  const SourceIcon = a.source.kind === "webhook" ? Webhook : a.source.kind === "event" ? Zap : Clock;
  const threadId = a.target.threadId;

  async function act(fn: () => Promise<string | undefined | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const note = await fn();
      if (note) setMessage({ tone: "info", text: note });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="automation-row" data-automation-id={a.id}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <SourceIcon className={cn("mt-0.5 size-4 shrink-0", a.paused ? "text-ink-3" : "text-primary")} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span data-testid="automation-name" className={cn("font-medium", a.paused ? "text-ink-2" : "text-foreground")}>
              {a.name}
            </span>
            {a.mode === "patrol" ? (
              <span data-testid="automation-patrol-badge" className="rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">
                見回り
              </span>
            ) : null}
            {a.paused ? (
              <span className="text-xs text-ink-3" data-testid="automation-paused">
                一時停止中
              </span>
            ) : null}
          </p>
          <p className="text-xs text-ink-2" data-testid="automation-summary">
            {describeSource(a, sources)}
            <span className="mx-1.5 text-ink-3">/</span>
            {describeTarget(a.target)}
            {a.nextFireAt ? (
              <>
                <span className="mx-1.5 text-ink-3">/</span>
                <span data-testid="automation-next">次は {formatWhen(a.nextFireAt, tz)}</span>
              </>
            ) : null}
          </p>
          {last ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <RunStrip runs={a.runs} timeZone={tz} />
              <span className={cn("text-xs", last.result === "waiting" ? "text-turn" : "text-ink-3")} data-testid="automation-last-run">
                前の回（{formatWhen(last.at, tz)}）：{runLabel(last)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-ink-3" data-testid="automation-last-run">
              まだ動いていません
            </p>
          )}
        </div>
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-3 pb-3 pl-10" data-testid="automation-details">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-ink-3">毎回届ける指示</p>
            <blockquote className="rounded-md bg-surface-2 px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-2" data-testid="automation-instruction">
              {a.instruction}
            </blockquote>
          </div>

          {a.source.kind === "webhook" ? <WebhookDetails source={a.source} pending={a.received?.length ?? 0} /> : null}
          {a.source.kind === "event" ? <EventDetails source={a.source} sources={sources} pending={a.received?.length ?? 0} /> : null}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">届け先</dt>
            <dd className="text-ink-2">{targetSentence(a.target)}</dd>
            <dt className="text-ink-3">受信箱</dt>
            <dd className="text-ink-2" data-testid="automation-review-policy">
              {a.mode === "patrol"
                ? `見回りの回は出しません。気づいたことを「気づき」として出します（1日 ${a.dailyFindingLimit ?? 10} 件まで）。失敗した回は出します。`
                : a.reviewOnDone
                  ? "終わった回を出します。"
                  : "終わった回は出しません。あなたの答えを待つ回・決めることがある回・失敗した回だけ出します。"}
            </dd>
            <dt className="text-ink-3">作った人</dt>
            <dd className="text-ink-2">
              {a.createdBy.kind === "human" ? "あなた" : `AI（「${threadTitle(a.createdBy.threadId)}」で頼まれ、あなたが許可しました）`}
            </dd>
            {a.paused && a.pausedReason ? (
              <>
                <dt className="text-ink-3">一時停止</dt>
                <dd className="text-ink-2">{a.pausedReason}</dd>
              </>
            ) : null}
          </dl>

          {a.mode === "patrol" ? <PatrolNotebook automation={a} /> : null}

          {a.runs.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-ink-3">直近の回</p>
              <ul className="flex flex-col gap-1" data-testid="automation-runs">
                {a.runs.map((r) => (
                  <li key={r.runId} className="flex items-start gap-2 text-xs" data-testid="automation-run" data-result={r.result}>
                    <RunIcon run={r} className="mt-px size-3.5 shrink-0" />
                    <span className="w-24 shrink-0 text-ink-3">{formatWhen(r.at, tz)}</span>
                    <span className={cn(r.result === "waiting" ? "text-turn" : "text-ink-2")}>
                      {runLabel(r)}
                      {r.cause === "manual" ? <span className="text-ink-3">（今すぐ動かした回）</span> : null}
                      {r.received ? (
                        <span className="text-ink-3" data-testid="automation-run-received">
                          （{r.cause === "event" ? "出来事" : "Webhook"} {r.received} 件{r.received > 1 ? "をまとめて" : ""}）
                        </span>
                      ) : null}
                      {r.reason ? <span className="text-ink-3">——{r.reason}</span> : null}
                      {r.delayed ? <span className="text-ink-3">——{r.delayed}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {confirmRemove ? (
            <div className="flex flex-col gap-2 rounded-md bg-stop-soft px-3 py-2.5 text-xs">
              <p className="text-foreground">自動化「{a.name}」を消します。</p>
              <p className="text-ink-2">
                {a.target.kind === "dedicated" ? "専用の Fork とその会話は残ります。要らなければ Fork を閉じてください。" : "届け先の会話はそのまま残ります。"}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void act(() => removeAutomation(a.projectId, a.id))}
                  data-testid="automation-remove-confirm"
                >
                  消す
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmRemove(false)}>
                  やめる
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {threadId ? (
                <Button asChild variant="outline" size="sm" className="h-7 gap-1 text-xs">
                  {/* 会話は Canvas の隣に開く——一覧を閉じずに、その回の会話を読める */}
                  <Link
                    href={automationsCanvasHref(a.projectId, threadId === baseThreadIdOf(a.projectId) ? null : threadId)}
                    data-testid="automation-open-thread"
                  >
                    <MessageSquare className="size-3.5" />
                    会話を開く
                  </Link>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={busy}
                title={a.source.kind === "webhook" ? "中身の無い Webhook を受けたのと同じに動かします" : undefined}
                onClick={() => void act(() => runAutomationNow(a.projectId, a.id).then((skipped) => (skipped ? `動かしませんでした：${skipped}` : undefined)))}
                data-testid="automation-run-now"
              >
                <Play className="size-3.5" />
                今すぐ動かす
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={busy}
                onClick={() => void act(() => updateAutomation(a.projectId, a.id, { paused: !a.paused }))}
                data-testid="automation-pause"
              >
                {a.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {a.paused ? "再開する" : "一時停止"}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={onEdit} data-testid="automation-edit">
                <Pencil className="size-3.5" />
                直す
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-ink-3 hover:text-stop"
                onClick={() => setConfirmRemove(true)}
                data-testid="automation-remove"
              >
                <Trash2 className="size-3.5" />
                消す
              </Button>
            </div>
          )}
          {message ? (
            <p
              role={message.tone === "error" ? "alert" : "status"}
              className={cn("text-xs", message.tone === "error" ? "text-stop" : "text-ink-2")}
              data-testid="automation-message"
            >
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Webhook の受け口の決まり。URL は作ったときに1回だけ見せたので、ここには出さない */
const NOTE_STATUS: Record<RealPatrolNote["status"], string> = { notified: "知らせた", muted: "知らせない", dismissed: "片づけた" };

/**
 * **見回りの手帳**（v4-frontend.md §6.47「自動化の画面」）：`key`・題・状態・最後に見た時刻。「知らせない」を外せる
 */
function PatrolNotebook({ automation: a }: { automation: RealAutomation }) {
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const notes = a.notebook ?? [];
  const tz = automationTimeZone(a);
  return (
    <div className="flex flex-col gap-1.5" data-testid="patrol-notebook">
      <p className="text-xs text-ink-3">手帳（知らせたもの。同じ key は 7日の間は出し直しません）</p>
      {notes.length === 0 ? (
        <p className="text-xs text-ink-3" data-testid="patrol-notebook-empty">
          まだ何も知らせていません
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {notes.map((n) => (
            <li key={n.key} className="flex items-baseline gap-2 text-xs" data-testid="patrol-note" data-key={n.key} data-status={n.status}>
              <code className="shrink-0 text-ink-3">{n.key}</code>
              <span className="min-w-0 flex-1 truncate text-ink-2">{n.title}</span>
              <span className={cn("shrink-0", n.status === "muted" ? "text-warn" : "text-ink-3")} data-testid="patrol-note-status">
                {NOTE_STATUS[n.status]}
              </span>
              <span className="w-24 shrink-0 text-right text-ink-3">{formatWhen(n.lastSeenAt, tz)}</span>
              {n.status === "muted" ? (
                <button
                  type="button"
                  disabled={busyKey !== null}
                  data-testid="patrol-note-unmute"
                  onClick={() => {
                    setBusyKey(n.key);
                    setError(null);
                    unmutePatrolNote(a.projectId, a.id, n.key)
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                      .finally(() => setBusyKey(null));
                  }}
                  className="shrink-0 rounded px-1.5 text-ink-2 hover:bg-accent disabled:opacity-50"
                >
                  外す
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-xs text-stop">
          「知らせない」を外せませんでした：{error}
        </p>
      ) : null}
    </div>
  );
}

function WebhookDetails({ source: s, pending }: { source: Extract<RealAutomationSource, { kind: "webhook" }>; pending: number }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="webhook-details">
      <dt className="text-ink-3">受け口</dt>
      <dd className="text-ink-2">URL は作ったときに一度だけ見せました。見失ったら、作り直してください。</dd>
      <dt className="text-ink-3">署名</dt>
      <dd className="text-ink-2" data-testid="webhook-signature">
        {s.signature ? (
          <>
            <code className="font-mono">{s.signature.header}</code> を HMAC-SHA256 で確かめます（鍵は Vault の{" "}
            <code className="font-mono">{s.signature.alias}</code>）。合わないものは受け取りません。
          </>
        ) : (
          "確かめません。URL を知っている人なら誰でも動かせます。"
        )}
      </dd>
      <dt className="text-ink-3">中身</dt>
      <dd className="text-ink-2">
        先頭の 64 KB まで AI に渡します。
        {s.batchSeconds > 0 ? `${s.batchSeconds} 秒の間に続けて届いたものは1回にまとめます。` : "1件ずつ届けます。"}
      </dd>
      <dt className="text-ink-3">届く範囲</dt>
      <dd className="text-ink-2">
        LAN と Tailscale の中からだけ届きます。GitHub など外のサービスからは届きません。
        {s.allowProjectContainer ? "この Project のコンテナからも受けます。" : "Project のコンテナからは受けません。"}
      </dd>
      {pending > 0 ? (
        <>
          <dt className="text-ink-3">溜めている</dt>
          <dd className="text-ink-2" data-testid="webhook-pending">
            受けて、まだ届けていないものが {pending} 件あります。前の回が終わったら、まとめて届けます。
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** 出来事のきっかけの決まり（何を待つか・条件・自分の回・まとめ方） */
function EventDetails({
  source: s,
  sources,
  pending,
}: {
  source: Extract<RealAutomationSource, { kind: "event" }>;
  sources: readonly RealAutomationEventSource[] | undefined;
  pending: number;
}) {
  const declared = findEventDeclaration(sources, s.event);
  const moduleName = eventSourceOf(s.event);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="event-details">
      <dt className="text-ink-3">出来事</dt>
      <dd className="text-ink-2">
        {declared ? `${declared.title}（` : ""}
        <code className="font-mono">{s.event}</code>
        {declared ? "）" : "——この Project では今、名乗っている Module がありません"}
      </dd>
      <dt className="text-ink-3">条件</dt>
      <dd className="text-ink-2" data-testid="event-details-where">
        {s.where && Object.keys(s.where).length > 0 ? describeWhere(s.where, declared) : "なし（起きるたびに動きます）"}
      </dd>
      <dt className="text-ink-3">自分の回</dt>
      <dd className="text-ink-2" data-testid="event-details-self">
        {s.allowSelfTriggered ? "この自動化自身の回が起こした出来事でも動きます。" : "この自動化自身の回が起こした出来事では動きません。"}
      </dd>
      <dt className="text-ink-3">まとめ方</dt>
      <dd className="text-ink-2">
        {s.batchSeconds > 0 ? `${s.batchSeconds} 秒の間に続けて起きたものは1回にまとめます。` : "1件ずつ届けます。"}
        {moduleName !== "banto" ? `待つ間、${moduleName} を起こしたままにします。スリープしても止めません。` : null}
      </dd>
      {pending > 0 ? (
        <>
          <dt className="text-ink-3">溜めている</dt>
          <dd className="text-ink-2">受けて、まだ届けていない出来事が {pending} 件あります。前の回が終わったら、まとめて届けます。</dd>
        </>
      ) : null}
    </dl>
  );
}

/** 出来事の名前の頭（`service.crashed` → `service`） */
function eventSourceOf(event: string): string {
  return event.split(".")[0] ?? event;
}

function baseThreadIdOf(projectId: string): string | undefined {
  return getThreadsForProject(projectId).find((t) => t.kind === "base")?.id;
}

function targetSentence(t: RealAutomationTarget): string {
  if (t.kind === "thread") return `「${threadTitle(t.threadId)}」に届けます。その会話は Clear しません。`;
  return t.mode === "fresh"
    ? "専用の Fork に、毎回まっさらな会話で届けます。届ける前に Clear し、前の回の会話は横線の上に残ります。"
    : "専用の Fork に、前の回の会話を引き継いで届けます。";
}

function RunIcon({ run, className }: { run: Pick<RealAutomationRun, "result">; className?: string }) {
  switch (run.result) {
    case "done":
      return <CircleCheck className={cn(className, "text-ok")} />;
    case "skipped":
      return <CircleDashed className={cn(className, "text-ink-3")} />;
    case "rejected":
      return <ShieldX className={cn(className, "text-warn")} />;
    case "waiting":
      return <Hand className={cn(className, "text-turn")} />;
    case "failed":
      return <CircleX className={cn(className, "text-stop")} />;
    case "running":
      return <Loader2 className={cn(className, "animate-spin text-primary motion-reduce:animate-none")} />;
  }
}

/** 直近の回の印を古い→新しいの順に1列で。色だけに頼らず形も変える（飛ばした回は点線の枠） */
function RunStrip({ runs, timeZone }: { runs: readonly RealAutomationRun[]; timeZone: string }) {
  const shown = runs.slice(0, 8).reverse();
  return (
    <span className="flex items-center gap-1" aria-label={`直近の ${shown.length} 回`} data-testid="automation-run-strip">
      {shown.map((r) => (
        <span
          key={r.runId}
          title={`${formatWhen(r.at, timeZone)}：${runLabel(r)}`}
          data-result={r.result}
          className={cn(
            "block size-2 rounded-xs border",
            r.result === "done" && "border-ok bg-ok-soft",
            r.result === "skipped" && "border-dashed border-ink-3",
            r.result === "rejected" && "border-dashed border-warn",
            r.result === "waiting" && "border-turn bg-turn",
            r.result === "failed" && "border-stop bg-stop-soft",
            r.result === "running" && "animate-pulse border-primary motion-reduce:animate-none",
          )}
        />
      ))}
    </span>
  );
}

type RepeatKind = RealAutomationRepeat["kind"];

const REPEAT_TABS: readonly { id: RepeatKind; label: string }[] = [
  { id: "daily", label: "毎日" },
  { id: "weekdays", label: "平日" },
  { id: "weekly", label: "毎週" },
  { id: "interval", label: "時間ごと" },
  { id: "cron", label: "cron の式" },
];

type SourceKind = RealAutomationSource["kind"];

const SOURCE_TABS: readonly { id: SourceKind; label: string }[] = [
  { id: "time", label: "決まった時刻" },
  { id: "webhook", label: "Webhook を受けたとき" },
  { id: "event", label: "出来事" },
];

const MODE_TABS: readonly { id: "normal" | "patrol"; label: string }[] = [
  { id: "normal", label: "ふつう" },
  { id: "patrol", label: "見回り" },
];

/** 判断役（AI の「決めること」を AI が決める）を待つ出来事——届け先は専用の Fork だけ（アーキ仕様 §4.3） */
const TURN_DECISIONS_EVENT = "banto.turn-decisions";

/** 続けて届いた Webhook をまとめる待ち時間の選び先（秒。0 はまとめない） */
const BATCH_SECONDS = [0, 10, 30, 60, 300] as const;
const DEFAULT_SIGNATURE_HEADER = "X-Hub-Signature-256";

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
/** タイムゾーンの選び先。作った人のブラウザのもの（既定）といまの値を先頭に足す */
const COMMON_TIME_ZONES = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "America/New_York", "Europe/London"] as const;

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** "9:00" → "09:00"（`<input type="time">` の値の形） */
function padTime(t: string): string {
  const [h = "0", m = "00"] = t.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

function AutomationForm({
  projectId,
  automation,
  events,
  onDone,
}: {
  projectId: string;
  automation?: RealAutomation;
  /** 待てる出来事（出来事のきっかけの選び先） */
  events: { sources: readonly RealAutomationEventSource[] | undefined; error: string | null };
  /** 作ったときは作ったもの（Webhook なら受け口の URL、判断役なら案内つき）を渡す */
  onDone: (created?: RealAutomation & { webhookUrl?: string; notices?: string[] }) => void;
}) {
  const source0 = automation?.source;
  const time0 = source0?.kind === "time" ? source0 : undefined;
  const hook0 = source0?.kind === "webhook" ? source0 : undefined;
  const event0 = source0?.kind === "event" ? source0 : undefined;
  // きっかけの種類は作ったあと変えられない（Webhook の受け口の URL は作ったときにしか出せない）
  const [sourceKind, setSourceKind] = useState<SourceKind>(source0?.kind ?? "time");
  const repeat0 = time0?.repeat;
  const [name, setName] = useState(automation?.name ?? "");
  const [instruction, setInstruction] = useState(automation?.instruction ?? "");
  const [kind, setKind] = useState<RepeatKind>(repeat0?.kind ?? "daily");
  const [clock, setClock] = useState(repeat0 && "time" in repeat0 ? padTime(repeat0.time) : "09:00");
  const [day, setDay] = useState(repeat0?.kind === "weekly" ? repeat0.day : 1);
  const [hours, setHours] = useState(repeat0?.kind === "interval" ? repeat0.hours : 1);
  const [cron, setCron] = useState(repeat0?.kind === "cron" ? repeat0.expr : "0 9 * * 1-5");
  // 既定は作った人のブラウザのタイムゾーン（banto の機械の時計は UTC のことがある）
  const [timeZone, setTimeZone] = useState(time0?.timeZone ?? browserTimeZone());
  // Webhook：署名は既定で確かめる
  const [signed, setSigned] = useState(hook0 ? hook0.signature !== undefined : true);
  const [sigHeader, setSigHeader] = useState(hook0?.signature?.header ?? DEFAULT_SIGNATURE_HEADER);
  const [sigAlias, setSigAlias] = useState(hook0?.signature?.alias ?? "");
  const [batchSeconds, setBatchSeconds] = useState<number>(hook0?.batchSeconds ?? event0?.batchSeconds ?? 30);
  const [allowContainer, setAllowContainer] = useState(hook0?.allowProjectContainer ?? false);
  const [aliases, setAliases] = useState<readonly string[] | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  useEffect(() => {
    if (sourceKind !== "webhook" || aliases !== null) return;
    listRealSecretAliases(projectId)
      .then((list) => setAliases(list))
      .catch((err: unknown) => {
        setAliases([]);
        setAliasError(err instanceof Error ? err.message : String(err));
      });
  }, [sourceKind, aliases, projectId]);
  const target0 = automation?.target;
  const [targetKind, setTargetKind] = useState<RealAutomationTarget["kind"]>(target0?.kind ?? "dedicated");
  const [mode, setMode] = useState<"fresh" | "continue">(target0?.kind === "dedicated" ? target0.mode : "fresh");
  const threads = getThreadsForProject(projectId).filter((t) => t.status !== "closed");
  const [threadId, setThreadId] = useState(
    target0?.kind === "thread" ? target0.threadId : (threads.find((t) => t.kind === "base")?.id ?? ""),
  );
  const [reviewOnDone, setReviewOnDone] = useState(automation?.reviewOnDone ?? true);
  // **種類**（ふつう／見回り、§6.47）。作ったあと変えない
  const [patrol, setPatrol] = useState(automation?.mode === "patrol");
  const [dailyFindingLimit, setDailyFindingLimit] = useState<number>(automation?.dailyFindingLimit ?? 10);
  // 出来事：出どころ → 出来事 → 条件。条件は属性ごとの値の並び（空＝どれでも）
  const [eventName, setEventName] = useState(event0?.event ?? "");
  const [eventOrigin, setEventOrigin] = useState(event0 ? (event0.event.split(".")[0] ?? "") : "");
  const [where, setWhere] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(Object.entries(event0?.where ?? {}).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(String)])),
  );
  // 「この自動化自身の回が起こした出来事では動かない」（既定オン＝allowSelfTriggered: false）
  const [ignoreSelf, setIgnoreSelf] = useState(event0 ? !event0.allowSelfTriggered : true);
  const declared = findEventDeclaration(events.sources, eventName);
  const isJudge = !patrol && sourceKind === "event" && eventName === TURN_DECISIONS_EVENT;
  const whereProblem = declared ? eventWhereInputProblem(declared, where) : undefined;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = Array.from(new Set([timeZone, browserTimeZone(), ...COMMON_TIME_ZONES]));

  const time = clock.replace(/^0(\d)/, "$1");
  const repeat: RealAutomationRepeat =
    kind === "daily" || kind === "weekdays"
      ? { kind, time }
      : kind === "weekly"
        ? { kind, day, time }
        : kind === "interval"
          ? { kind, hours }
          : { kind, expr: cron };
  // 判断役の届け先は専用の Fork だけ（いまある会話は選べない）
  // 見回りの届け先は専用の Fork・毎回まっさらに決まっている
  const target: RealAutomationTarget = patrol
    ? { kind: "dedicated", mode: "fresh" }
    : targetKind === "dedicated" || isJudge
      ? { kind: "dedicated", mode }
      : { kind: "thread", threadId };
  const signatureFilled = !signed || (sigHeader.trim() !== "" && sigAlias.trim() !== "");
  const eventFilled = declared !== undefined && whereProblem === undefined;
  const filled =
    name.trim() !== "" &&
    instruction.trim() !== "" &&
    (sourceKind === "time" || (sourceKind === "webhook" && signatureFilled) || (sourceKind === "event" && eventFilled));

  function pickEvent(next: string) {
    setEventName(next);
    setWhere({});
    // 判断役は前の回を引き継ぐ Fork で動かす（判断の続きを覚えていられる）——作るときだけ寄せる
    if (next === TURN_DECISIONS_EVENT && !automation) {
      setTargetKind("dedicated");
      setMode("continue");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!filled || saving) return;
    const fields: RealAutomationInput = {
      name: name.trim(),
      instruction: instruction.trim(),
      source:
        sourceKind === "time"
          ? { kind: "time", repeat, timeZone }
          : sourceKind === "event" && declared
            ? {
                kind: "event",
                event: eventName,
                ...(Object.keys(whereValue(declared, where)).length > 0 ? { where: whereValue(declared, where) } : {}),
                batchSeconds,
                allowSelfTriggered: !ignoreSelf,
              }
            : {
                kind: "webhook",
                signature: signed ? { header: sigHeader.trim(), alias: sigAlias.trim() } : false,
                batchSeconds,
                allowProjectContainer: allowContainer,
              },
      target,
      reviewOnDone: patrol ? false : reviewOnDone,
      ...(patrol ? { mode: "patrol" as const, dailyFindingLimit } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      if (automation) {
        await updateAutomation(projectId, automation.id, fields);
        onDone();
      } else {
        onDone(await createAutomation(projectId, fields));
      }
    } catch (err) {
      // 断られた理由（cron の式が読めない・間隔が短い等）は host の言葉のまま出し、フォームは開いたまま（規則2）
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" data-testid="automation-form">
      <p className="text-sm font-medium text-foreground">{automation ? `「${automation.name}」を直す` : "自動化を足す"}</p>

      <div className="flex flex-col gap-1.5">
        <Label>種類</Label>
        {automation ? (
          <p className="text-sm text-ink-2" data-testid="automation-mode-fixed">
            {patrol ? "見回り" : "ふつう"}
            <span className="ml-1.5 text-xs text-ink-3">（種類は変えられません）</span>
          </p>
        ) : (
          <PillTabs
            tabs={MODE_TABS}
            value={patrol ? "patrol" : "normal"}
            onChange={(v) => setPatrol(v === "patrol")}
            label="種類"
            testId="automation-mode"
          />
        )}
        {patrol ? (
          <p className="text-xs text-ink-3" data-testid="automation-patrol-hint">
            見回りは読むだけの tool で決めた対象を見て、気づいたことを受信箱の「気づき」に出します。ファイルを書く・コマンドを走らせる・人に聞くことはしません。
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>何が起きたら</Label>
        {automation ? (
          <p className="flex items-center gap-1.5 text-sm text-ink-2" data-testid="automation-source-fixed">
            {sourceKind === "webhook" ? <Webhook className="size-3.5" /> : sourceKind === "event" ? <Zap className="size-3.5" /> : <Clock className="size-3.5" />}
            {sourceKind === "webhook" ? "Webhook を受けたとき" : sourceKind === "event" ? "出来事" : "決まった時刻"}
            <span className="text-xs text-ink-3">（種類は変えられません。変えるなら作り直してください）</span>
          </p>
        ) : (
          <PillTabs
            tabs={SOURCE_TABS}
            value={sourceKind}
            onChange={(v) => setSourceKind(v as SourceKind)}
            label="何が起きたら"
            testId="automation-source"
          />
        )}
      </div>

      {sourceKind === "webhook" ? (
        <div className="flex flex-col gap-3" data-testid="automation-webhook-form">
          <div className="flex flex-col gap-1.5">
            <Label>受け口の URL</Label>
            <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
              {automation
                ? "URL は作ったときに一度だけ見せました。見失ったら、作り直してください。"
                : "足したときに、この自動化だけの URL を発行して一度だけ見せます。URL は推測できない印を含み、知っていれば POST で動かせます。"}
            </p>
            <p className="text-xs text-ink-3">LAN と Tailscale の中からだけ届きます。GitHub など外のサービスからは届きません。</p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Switch id="automation-signed" checked={signed} onCheckedChange={setSigned} data-testid="automation-signed" />
              <Label htmlFor="automation-signed">署名を確かめる（HMAC-SHA256）</Label>
            </div>
            {signed ? (
              <div className="flex flex-wrap items-center gap-2 pl-11 text-xs">
                <Input
                  value={sigHeader}
                  onChange={(e) => setSigHeader(e.target.value)}
                  aria-label="署名の入るヘッダ"
                  className="h-8 w-56 font-mono text-xs"
                  data-testid="automation-signature-header"
                />
                <span className="text-ink-3">の値を、Vault の</span>
                <Input
                  value={sigAlias}
                  onChange={(e) => setSigAlias(e.target.value)}
                  list="automation-signature-aliases"
                  aria-label="署名の鍵"
                  placeholder={aliases === null ? "読み込んでいます…" : aliases.length > 0 ? "alias を選ぶ" : "alias の名前"}
                  className="h-8 w-56 font-mono text-xs"
                  data-testid="automation-signature-alias"
                />
                <datalist id="automation-signature-aliases">
                  {(aliases ?? []).map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
                <span className="text-ink-3">で確かめます。</span>
                {aliasError ? (
                  <p className="w-full text-ink-3" data-testid="automation-signature-aliases-error">
                    Vault の alias の一覧を読めませんでした（{aliasError}）。名前を直に書けます。
                  </p>
                ) : aliases !== null && aliases.length === 0 ? (
                  <p className="w-full text-ink-3">この Project から使える秘密の alias がまだありません。Vault に鍵を置いてから選んでください。</p>
                ) : null}
              </div>
            ) : (
              <p className="flex items-start gap-1.5 pl-11 text-xs text-warn">
                <CircleAlert className="mt-px size-3.5 shrink-0" />
                URL を知っている人なら誰でも AI を動かせます。送り手が署名を付けられるなら、確かめるようにしてください。
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <Label htmlFor="automation-batch" className="text-xs font-normal text-ink-2">
              続けて届いたものを
            </Label>
            <Select value={String(batchSeconds)} onValueChange={(v) => setBatchSeconds(Number(v))}>
              <SelectTrigger id="automation-batch" className="h-8 w-24 text-xs" data-testid="automation-batch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BATCH_SECONDS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n === 0 ? "まとめない" : n < 60 ? `${n} 秒` : `${n / 60} 分`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span>{batchSeconds === 0 ? "（1件ずつ届けます）" : "待って、1回にまとめて届けます"}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Switch id="automation-allow-container" checked={allowContainer} onCheckedChange={setAllowContainer} />
              <Label htmlFor="automation-allow-container">この Project のコンテナから届いたものも受ける</Label>
            </div>
            <p className="pl-11 text-xs text-ink-3">
              既定では、Project のコンテナから届いたものは受けません（どの Project のコンテナからも banto に届くため）。この Project の中で動かすものから送るときだけ入れてください。
            </p>
          </div>
        </div>
      ) : null}

      {sourceKind === "event" ? (
        <EventSourceFields
          sources={events.sources}
          error={events.error}
          origin={eventOrigin}
          onOrigin={(o) => {
            setEventOrigin(o);
            pickEvent("");
          }}
          eventName={eventName}
          onEvent={pickEvent}
          declared={declared}
          where={where}
          onWhere={setWhere}
          whereProblem={whereProblem}
          ignoreSelf={ignoreSelf}
          onIgnoreSelf={setIgnoreSelf}
          batchSeconds={batchSeconds}
          onBatchSeconds={setBatchSeconds}
        />
      ) : null}

      {sourceKind === "time" ? (
        <div className="flex flex-col gap-1.5">
          <Label>いつ</Label>
          <PillTabs tabs={REPEAT_TABS} value={kind} onChange={(v) => setKind(v as RepeatKind)} label="いつ" testId="automation-when" />
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            {kind === "weekly" ? (
              <Select value={String(day)} onValueChange={(v) => setDay(Number(v))}>
                <SelectTrigger className="h-8 w-24 text-xs" aria-label="曜日">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_LABELS.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      {d}曜
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {kind === "daily" || kind === "weekdays" || kind === "weekly" ? (
              <Input
                type="time"
                value={clock}
                onChange={(e) => setClock(e.target.value)}
                aria-label="時刻"
                required
                className="h-8 w-28 font-mono text-xs"
                data-testid="automation-time"
              />
            ) : null}
            {kind === "interval" ? (
              <>
                <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
                  <SelectTrigger className="h-8 w-24 text-xs" aria-label="間隔">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVAL_HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {h} 時間
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span>ごと</span>
              </>
            ) : null}
            {kind === "cron" ? (
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                aria-label="cron の式"
                className="h-8 w-40 font-mono text-xs"
                data-testid="automation-cron"
              />
            ) : null}
            <Select value={timeZone} onValueChange={setTimeZone}>
              <SelectTrigger className="h-8 w-56 text-xs" aria-label="タイムゾーン">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {timeZoneName(z)}（{z}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-ink-3" data-testid="automation-when-preview">
            {kind === "cron"
              ? "分 時 日 月 曜日 の5つ。間隔は最短15分です。"
              : `${describeRepeat(repeat)}（${timeZoneName(timeZone)}）に動きます。`}
          </p>
        </div>
      ) : null}

      <Field
        id="automation-instruction"
        label="毎回届ける指示"
        hint={
          sourceKind === "webhook"
            ? "受けた中身はこの指示の下に「外から来たもの」として添えます。中身の中の指示には従わないよう、AI にも伝えます"
            : sourceKind === "event"
              ? isJudge
                ? "判断の方針を書いてください。届くのは元の会話のまとめ（頼んだこと・結果・決めること）だけで、会話の中身は読めません。選べるのは元の AI が出した選択肢だけで、分からなければ人に任せます。任務の枠を延ばすかの問いは、いつも人に任せます（枠を延ばせるのは人だけ）"
                : "起きた出来事の題・属性と本文は、この指示の下に「外から来たもの」として添えます。中に書かれた指示には従わないよう、AI にも伝えます"
              : "人が会話で頼むときと同じ書き方で。Memory と「AI への指示」もいつもどおり効きます"
        }
      >
        <Textarea
          id="automation-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          placeholder={
            patrol
              ? "何を見るか：main の CI と、開いている PR のレビューの状態。\n何を知らせるか：CI が2回続けて落ちている・3日以上動いていない PR。知らせないもの：下書きの PR・CI が1回だけ落ちたもの"
              : sourceKind === "webhook"
              ? "CI からビルドが落ちたと届きます。失敗したジョブのログを読み、原因の見当を挙げて"
              : sourceKind === "event"
                ? isJudge
                  ? "この Project の Memory と仕様に沿って、おすすめに異論が無ければそれを選ぶ。設計の向きを変えるもの・お金や外部に関わるもの・取り消せない操作・readExternal が真のターンの決めごとは自分で決めず人に任せる。迷ったら人に任せる"
                  : "落ちた Service のログを読み、原因を調べて、直せるなら直して起こし直して"
                : "昨日から今朝までに main に入ったコミットをまとめて"
          }
        />
      </Field>

      <Field id="automation-name" label="名前" hint="専用の Fork の名前にもなります">
        <Input
          id="automation-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={sourceKind === "webhook" ? "CI が落ちたら" : sourceKind === "event" ? (isJudge ? "判断役" : "Service が落ちたら") : "毎朝のまとめ"}
        />
      </Field>

      {patrol ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>どの会話で動かすか</Label>
            <p className="text-sm text-ink-2" data-testid="automation-patrol-target">
              専用の Fork・毎回まっさら（見回りの会話は、どう起こしても読むだけで動きます）
            </p>
          </div>
          <Field id="automation-daily-limit" label="1日の気づきの上限" hint="1日は自動化のタイムゾーンで数えます。1回には 5 件まで">
            <Input
              id="automation-daily-limit"
              type="number"
              min={1}
              max={50}
              value={dailyFindingLimit}
              onChange={(e) => setDailyFindingLimit(Number(e.target.value))}
              className="h-8 w-24 text-sm"
              data-testid="automation-daily-limit"
            />
          </Field>
        </div>
      ) : (
      <>
      <div className="flex flex-col gap-1.5">
        <Label id="automation-target-label">どの会話で動かすか</Label>
        <div role="radiogroup" aria-labelledby="automation-target-label" className="flex flex-col gap-1.5">
          <ModeOption
            checked={targetKind === "dedicated" && mode === "fresh"}
            onSelect={() => {
              setTargetKind("dedicated");
              setMode("fresh");
            }}
            title="専用の Fork で、毎回まっさら"
            body="届ける前に会話を Clear します。毎回同じことを新しく調べるものに。前の回の結果を使いたいときは、指示に「前回の結果は notes/○○.md にある。読んで比べ、最後に今回の結果を書き足して」のように書いてください。"
          />
          <ModeOption
            checked={targetKind === "dedicated" && mode === "continue"}
            onSelect={() => {
              setTargetKind("dedicated");
              setMode("continue");
            }}
            title="専用の Fork で、前の回を引き継ぐ"
            body="同じ会話に積みます。前の回のやり取りをそのまま覚えていてほしいものに。回を重ねるほど会話が長くなり、そのぶん毎回の読み直しが重くなります。"
          />
          {/* 判断役の届け先は専用の Fork だけ——いまある会話の承認を「必ず聞く」に固定することになるため（アーキ仕様 §4.3） */}
          {isJudge ? (
            <p className="text-xs text-ink-3" data-testid="automation-judge-target">
              判断役は専用の Fork でだけ動きます。判断役の会話の承認は、「承認をすべて自動で許可する」がオンでも必ず聞きます。
            </p>
          ) : (
          <ModeOption
            checked={targetKind === "thread"}
            onSelect={() => setTargetKind("thread")}
            title="いまある会話に届ける"
            body="選んだ会話に、人の発言と同じように積みます。Clear しません。その会話で進めている話の続きとして動かしたいときに。"
          >
            {targetKind === "thread" ? (
              <Select value={threadId} onValueChange={setThreadId}>
                <SelectTrigger className="mt-1.5 h-8 w-64 text-xs" aria-label="届ける会話">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {threads.map((th) => (
                    <SelectItem key={th.id} value={th.id}>
                      {th.kind === "base" ? "Base Thread" : th.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </ModeOption>
          )}
        </div>
      </div>

      {targetKind === "dedicated" && mode === "continue" && sourceKind === "time" && kind === "interval" ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          時間ごとの自動化で引き継ぐと、1日で会話が長くなります。比べたいだけなら、まっさらにしてファイルに残させるほうが軽く済みます。
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Switch id="automation-review" checked={reviewOnDone} onCheckedChange={setReviewOnDone} />
          <Label htmlFor="automation-review">終わったら受信箱に出す</Label>
        </div>
        <p className="pl-11 text-xs text-ink-3">切っても、あなたの答えを待つ回・決めることがある回・失敗した回は受信箱に出します。</p>
      </div>
      </>
      )}

      {error ? (
        <p role="alert" className="text-xs text-stop" data-testid="automation-form-error">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!filled || saving} data-testid="automation-submit">
          {automation ? "直す" : "足す"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onDone()}>
          やめる
        </Button>
      </div>
    </form>
  );
}

/**
 * **出来事のきっかけ**：出どころ（この Project の Module のうち出来事を名乗るもの＋banto）→ 出来事（題と説明）→ 条件（属性ごと。
 * `enum` があれば選ぶだけ、無ければ打つ。複数の値は「どれか」）。「この自動化自身の回が起こした出来事では動かない」（既定オン）
 */
function EventSourceFields({
  sources,
  error,
  origin,
  onOrigin,
  eventName,
  onEvent,
  declared,
  where,
  onWhere,
  whereProblem,
  ignoreSelf,
  onIgnoreSelf,
  batchSeconds,
  onBatchSeconds,
}: {
  sources: readonly RealAutomationEventSource[] | undefined;
  error: string | null;
  origin: string;
  onOrigin: (origin: string) => void;
  eventName: string;
  onEvent: (name: string) => void;
  declared: RealEventDeclaration | undefined;
  where: Record<string, string[]>;
  onWhere: (where: Record<string, string[]>) => void;
  whereProblem: string | undefined;
  ignoreSelf: boolean;
  onIgnoreSelf: (on: boolean) => void;
  batchSeconds: number;
  onBatchSeconds: (n: number) => void;
}) {
  if (error && !sources) {
    return (
      <p role="alert" className="text-xs text-stop" data-testid="automation-event-sources-error">
        待てる出来事を読み込めませんでした：{error}
      </p>
    );
  }
  if (!sources) return <p className="text-xs text-ink-3">待てる出来事を読み込んでいます…</p>;
  const events = sources.find((s) => s.source === origin)?.events ?? [];
  // 直す前の出来事が今は名乗られていない（Module を外した）——選び直すまで作れない
  const missing = eventName !== "" && !declared;
  return (
    <div className="flex flex-col gap-3" data-testid="automation-event-form">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <Label htmlFor="automation-event-origin" className="text-xs font-normal text-ink-2">
          出どころ
        </Label>
        <Select value={origin} onValueChange={onOrigin}>
          <SelectTrigger id="automation-event-origin" className="h-8 w-48 text-xs" data-testid="automation-event-origin">
            <SelectValue placeholder="選ぶ" />
          </SelectTrigger>
          <SelectContent>
            {sources.map((s) => (
              <SelectItem key={s.source} value={s.source}>
                {s.source === "banto" ? "banto 自身" : s.source}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {origin !== "" ? (
          <>
            <Label htmlFor="automation-event-name" className="text-xs font-normal text-ink-2">
              出来事
            </Label>
            <Select value={eventName} onValueChange={onEvent}>
              <SelectTrigger id="automation-event-name" className="h-8 w-72 text-xs" data-testid="automation-event-name">
                <SelectValue placeholder="選ぶ" />
              </SelectTrigger>
              <SelectContent>
                {events.map((e) => (
                  <SelectItem key={e.name} value={e.name}>
                    {e.title}（{e.name}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}
      </div>
      {sources.length === 1 ? (
        <p className="text-xs text-ink-3">この Project の Module は出来事を名乗っていません。待てるのは banto 自身の出来事だけです。</p>
      ) : null}
      {missing ? (
        <p role="alert" className="text-xs text-stop" data-testid="automation-event-missing">
          出来事 {eventName} は、いまこの Project のどの Module も名乗っていません。選び直してください。
        </p>
      ) : null}

      {declared ? (
        <>
          <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2" data-testid="automation-event-description">
            {declared.description}
          </p>
          {origin !== "banto" ? (
            <p className="text-xs text-ink-3" data-testid="automation-event-keep-awake">
              待つ間、{origin} を起こしたままにします。スリープしても止めません。
            </p>
          ) : null}
          <WhereFields declared={declared} where={where} onWhere={onWhere} problem={whereProblem} />
        </>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Switch id="automation-ignore-self" checked={ignoreSelf} onCheckedChange={onIgnoreSelf} data-testid="automation-ignore-self" />
          <Label htmlFor="automation-ignore-self">この自動化自身の回が起こした出来事では動かない</Label>
        </div>
        <p className="pl-11 text-xs text-ink-3">
          {ignoreSelf
            ? "自分の回で直した・起こしたことがまた出来事になっても、それでは動きません（輪にならないように）。"
            : "自分の回が起こした出来事でも動きます。同じ出来事・同じ対象で動くのは 60 分に 6 回までです。"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <Label htmlFor="automation-event-batch" className="text-xs font-normal text-ink-2">
          続けて起きたものを
        </Label>
        <Select value={String(batchSeconds)} onValueChange={(v) => onBatchSeconds(Number(v))}>
          <SelectTrigger id="automation-event-batch" className="h-8 w-24 text-xs" data-testid="automation-event-batch">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BATCH_SECONDS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 0 ? "まとめない" : n < 60 ? `${n} 秒` : `${n / 60} 分`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>{batchSeconds === 0 ? "（1件ずつ届けます）" : "待って、1回にまとめて届けます"}</span>
      </div>
    </div>
  );
}

/** 条件：属性ごとの選択欄。`enum` は押して選ぶ（複数は「どれか」）、真偽は選ぶ、ほかは打つ（「,」か「、」で区切ると「どれか」） */
function WhereFields({
  declared,
  where,
  onWhere,
  problem,
}: {
  declared: RealEventDeclaration;
  where: Record<string, string[]>;
  onWhere: (where: Record<string, string[]>) => void;
  problem: string | undefined;
}) {
  const fields = Object.entries(declared.fields);
  if (fields.length === 0) return null;
  const set = (field: string, values: string[]) => {
    const next = { ...where };
    if (values.length === 0) delete next[field];
    else next[field] = values;
    onWhere(next);
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="automation-event-where">
      <Label>条件</Label>
      <p className="text-xs text-ink-3">空のままの属性は問いません。全部空なら、この出来事が起きるたびに動きます。</p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
        {fields.map(([field, f]) => (
          <WhereField key={`${declared.name}:${field}`} field={field} declared={f} values={where[field] ?? []} onChange={(v) => set(field, v)} />
        ))}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-stop" data-testid="automation-event-where-error">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function WhereField({
  field,
  declared: f,
  values,
  onChange,
}: {
  field: string;
  declared: RealEventField;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const id = `automation-where-${field}`;
  return (
    <>
      <Label htmlFor={id} className="text-xs font-normal text-ink-2">
        {f.title}
        <code className="ml-1 font-mono text-ink-3">{field}</code>
      </Label>
      {f.enum ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={f.title} data-testid="automation-where-field" data-field={field}>
          {f.enum.map((v) => {
            const on = values.includes(String(v));
            return (
              <button
                key={String(v)}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? values.filter((x) => x !== String(v)) : [...values, String(v)])}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-full border px-3 text-xs",
                  on ? "border-primary bg-surface-2 text-foreground" : "border-border bg-card text-ink-2 hover:bg-surface-2/60",
                )}
              >
                {on ? <Check className="size-3" /> : null}
                {String(v)}
              </button>
            );
          })}
        </div>
      ) : f.type === "boolean" ? (
        <Select value={values[0] ?? "any"} onValueChange={(v) => onChange(v === "any" ? [] : [v])}>
          <SelectTrigger id={id} className="h-8 w-32 text-xs" data-testid="automation-where-field" data-field={field}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">問わない</SelectItem>
            <SelectItem value="true">{describeFieldValue(true)}</SelectItem>
            <SelectItem value="false">{describeFieldValue(false)}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          defaultValue={values.join(", ")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/[,、]/)
                .map((x) => x.trim())
                .filter((x) => x !== ""),
            )
          }
          placeholder={f.type === "number" ? "数（, で区切ると「どれか」）" : "値（, で区切ると「どれか」）"}
          className="h-8 w-64 font-mono text-xs"
          data-testid="automation-where-field"
          data-field={field}
        />
      )}
    </>
  );
}

/** 打った条件が名乗りの型に合うか（数の属性に数でないもの）。合わなければ理由 */
function eventWhereInputProblem(declared: RealEventDeclaration, where: Record<string, string[]>): string | undefined {
  for (const [field, values] of Object.entries(where)) {
    const f = declared.fields[field];
    if (f?.type === "number" && values.some((v) => !Number.isFinite(Number(v)))) return `${f.title}は数で書いてください`;
  }
  return undefined;
}

/** 画面の欄の値（文字）を、名乗りの型の値にして host に渡す形へ。値が1つなら配列にしない */
function whereValue(
  declared: RealEventDeclaration,
  where: Record<string, string[]>,
): Record<string, string | number | boolean | Array<string | number | boolean>> {
  const out: Record<string, string | number | boolean | Array<string | number | boolean>> = {};
  for (const [field, raw] of Object.entries(where)) {
    const f = declared.fields[field];
    if (!f || raw.length === 0) continue;
    const typed = raw.map((v) => (f.type === "number" ? Number(v) : f.type === "boolean" ? v === "true" : v));
    out[field] = typed.length === 1 ? typed[0]! : typed;
  }
  return out;
}

function ModeOption({
  checked,
  onSelect,
  title,
  body,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("rounded-md border px-3 py-2 transition-colors", checked ? "border-primary bg-surface-2" : "border-border hover:bg-surface-2/60")}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        onClick={onSelect}
        className="flex w-full items-start gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className={cn("mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border", checked ? "border-primary" : "border-ink-3")}>
          {checked ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <span className="text-xs text-ink-2">{body}</span>
        </span>
      </button>
      {children ? <div className="pl-6">{children}</div> : null}
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}
