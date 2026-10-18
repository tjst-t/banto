"use client";

// 見本：Claude のアカウントを複数持つ（fork/multi-claude-accounts、仕様 v4-security.md §2「Claude のアカウントを複数持つ」）。
// 上の帯は見本だけの場面切り替え（本物には無い）。
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Clock,
  ExternalLink,
  GitFork,
  Inbox,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Scene = "accounts" | "add" | "project" | "thread" | "inbox";

interface Account {
  id: string;
  label: string;
  email: string;
  plan: string;
  /** 0〜100。undefined は「分からない」（リセットを過ぎた・まだ使っていない） */
  fiveHour?: number;
  fiveHourReset: string;
  week?: number;
  weekReset: string;
  hostCli?: boolean;
  usedBy: string[];
}

const ACCOUNTS: Account[] = [
  {
    id: "a",
    label: "このマシンの Claude Code のログイン",
    email: "takumi@example.com",
    plan: "Max 20x",
    fiveHour: 96,
    fiveHourReset: "あと 1時間12分（18:00）",
    week: 73,
    weekReset: "10月22日（水）9:00",
    hostCli: true,
    usedBy: [],
  },
  {
    id: "b",
    label: "仕事用",
    email: "t.tsujishita@work.example.jp",
    plan: "Max 5x",
    fiveHour: 41,
    fiveHourReset: "あと 3時間40分（20:28）",
    week: 58,
    weekReset: "10月21日（火）13:00",
    usedBy: ["banto開発", "ansible-nas", "kaggle"],
  },
  {
    id: "c",
    label: "予備",
    email: "takumi.sub@example.com",
    plan: "Pro",
    fiveHour: undefined,
    fiveHourReset: "まだ使っていません",
    week: 12,
    weekReset: "10月24日（金）2:00",
    usedBy: ["家計簿"],
  },
];

export default function ClaudeAccountsMockPage() {
  const [scene, setScene] = useState<Scene>("accounts");
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-xs text-ink-2">
        <span className="font-medium text-foreground">見本の場面：</span>
        {(
          [
            ["accounts", "設定：Claude のアカウント"],
            ["add", "アカウントを足す"],
            ["project", "Project 設定"],
            ["thread", "会話（切り替え・上限の待ち）"],
            ["inbox", "受信箱"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setScene(id)}
            className={cn(
              "rounded-md px-2 py-1",
              scene === id ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-1 justify-center p-4 sm:p-8">
        {scene === "accounts" ? <AccountsSettings /> : null}
        {scene === "add" ? <AddAccount /> : null}
        {scene === "project" ? <ProjectSettings /> : null}
        {scene === "thread" ? <ThreadScene /> : null}
        {scene === "inbox" ? <InboxScene /> : null}
      </div>
    </div>
  );
}

/* ───────── 使用率のメーター（閾値の印つき） ───────── */

function Meter({ label, value, threshold, reset }: { label: string; value?: number; threshold: number; reset: string }) {
  const over = value !== undefined && value >= threshold;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">{label}</span>
        <span className={cn("tabular-nums", over ? "font-semibold text-warn" : "text-foreground")}>
          {value === undefined ? "—" : `${value}%`}
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-3">
        {value !== undefined ? (
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-warn" : "bg-[var(--banto-accent)]")}
            style={{ width: `${value}%` }}
          />
        ) : null}
        <div
          className="absolute -top-1 h-3.5 w-px bg-foreground/60"
          style={{ left: `${threshold}%` }}
          title={`閾値 ${threshold}%`}
        />
      </div>
      <span className="text-xs text-ink-3">
        {value === undefined ? reset : `リセット：${reset}`}
      </span>
    </div>
  );
}

/* ───────── 1. banto 全体の設定「Claude のアカウント」 ───────── */

function AccountsSettings() {
  const [fiveHour, setFiveHour] = useState(95);
  const [week, setWeek] = useState(95);
  const [order, setOrder] = useState(["a", "b"]);
  const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const n = [...o];
      [n[i], n[i + d]] = [n[i + d]!, n[i]!];
      return n;
    });

  return (
    <div className="flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Claude のアカウント</h1>
        <p className="text-sm text-ink-2">
          会話と、コンテナの中の Claude（サブエージェント・Factory など）が使うアカウントです。使用量が閾値を越えると、並びの次のアカウントに切り替えます。
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">アカウント</h2>
          <Button size="sm" variant="outline">
            <Plus className="size-3.5" />
            アカウントを足す
          </Button>
        </div>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {ACCOUNTS.map((a) => (
            <li key={a.id} className="grid gap-4 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_8.5rem] sm:items-start">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">{a.label}</span>
                <span className="truncate text-xs text-ink-2">
                  {a.email}（{a.plan}）
                </span>
                <span className="text-xs text-ink-3">
                  {a.hostCli
                    ? "host の ~/.claude。人の claude コマンドと共有しています"
                    : a.usedBy.length > 0
                      ? `いま使っている Project：${a.usedBy.join("、")}`
                      : "いま使っている Project はありません"}
                </span>
              </div>
              <Meter label="5時間" value={a.fiveHour} threshold={fiveHour} reset={a.fiveHourReset} />
              <Meter label="週" value={a.week} threshold={week} reset={a.weekReset} />
              <div className="flex gap-1 sm:flex-col sm:items-end">
                {a.hostCli ? null : (
                  <>
                    <Button size="sm" variant="ghost" className="text-xs">
                      ログインし直す
                    </Button>
                    <Button size="sm" variant="ghost" className="text-xs text-stop">
                      外す
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        <button type="button" className="flex items-center gap-1 self-start text-xs text-ink-3 hover:text-ink-2">
          <RefreshCw className="size-3" />
          使用率を読み直す（3分前に読みました）
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">切り替える閾値</h2>
        <p className="text-xs text-ink-2">
          どちらかを越えたアカウントは使わず、並びの次へ移ります。リセットされたら元のアカウントに戻ります。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Threshold label="5時間の使用量" value={fiveHour} onChange={setFiveHour} />
          <Threshold label="週の使用量" value={week} onChange={setWeek} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">既定の並び</h2>
        <p className="text-xs text-ink-2">
          Project で並びを決めていなければ、この順で使います。上ほど先に使います。
        </p>
        <ol className="flex flex-col rounded-lg border border-border">
          {order.map((id, i) => {
            const a = byId.get(id)!;
            return (
              <li key={id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                <span className="w-4 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                <span className="flex-1 text-sm text-foreground">
                  {a.label}
                  <span className="ml-2 text-xs text-ink-3">{a.email}</span>
                </span>
                <IconButton label="上へ" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton label="下へ" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton label="並びから外す" disabled={order.length === 1} onClick={() => setOrder((o) => o.filter((x) => x !== id))}>
                  <X className="size-3.5" />
                </IconButton>
              </li>
            );
          })}
        </ol>
        {ACCOUNTS.some((a) => !order.includes(a.id)) ? (
          <div className="flex flex-wrap gap-2">
            {ACCOUNTS.filter((a) => !order.includes(a.id)).map((a) => (
              <Button key={a.id} size="sm" variant="ghost" className="text-xs" onClick={() => setOrder((o) => [...o, a.id])}>
                <Plus className="size-3" />
                {a.label}を並びに足す
              </Button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Threshold({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3">
      <span className="flex items-baseline justify-between text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="text-sm font-semibold tabular-nums text-foreground">{value}%</span>
      </span>
      <input
        type="range"
        min={50}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[var(--banto-accent)]"
      />
      <span className="text-xs text-ink-3">100% にすると、上限に当たるまで切り替えません</span>
    </label>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/* ───────── 2. アカウントを足す ───────── */

type AddStep = "open" | "paste" | "exchanging" | "done" | "mismatch" | "expired";

function AddAccount() {
  const [step, setStep] = useState<AddStep>("open");
  const [code, setCode] = useState("");
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex flex-wrap gap-1 text-xs text-ink-3">
        <span>この場面の中：</span>
        {(
          [
            ["open", "最初"],
            ["paste", "貼る"],
            ["done", "足せた"],
            ["mismatch", "state が合わない"],
            ["expired", "期限切れ"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setStep(id)} className={cn("rounded px-1.5 py-0.5", step === id ? "bg-surface-2 text-foreground" : "hover:text-ink-2")}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex w-full max-w-lg flex-col gap-5 rounded-xl border border-border bg-background p-5 shadow-xl">
        <h2 className="text-md font-semibold text-foreground">Claude のアカウントを足す</h2>

        {step === "done" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              takumi.sub@example.com（Pro）を足しました。
            </p>
            <p className="text-xs text-ink-2">
              並びにはまだ入っていません。既定の並びか、Project の設定で並びに足すと使われます。
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost">閉じる</Button>
              <Button size="sm">既定の並びの最後に足す</Button>
            </div>
          </div>
        ) : (
          <>
            <ol className="flex flex-col gap-4">
              <li className="flex gap-3">
                <StepMark n={1} done={step !== "open"} />
                <div className="flex flex-1 flex-col gap-2">
                  <p className="text-sm text-foreground">claude.ai のログインの画面を開いて、足したいアカウントでログインします。</p>
                  <p className="text-xs text-ink-2">
                    いま claude.ai にほかのアカウントでログインしていると、そのアカウントが返ってきます。開いたタブで一度ログアウトしてから入ってください。
                  </p>
                  <Button size="sm" variant="outline" className="self-start" onClick={() => setStep("paste")}>
                    <ExternalLink className="size-3.5" />
                    ログインの画面を開く
                  </Button>
                </div>
              </li>
              <li className="flex gap-3">
                <StepMark n={2} done={false} />
                <div className="flex flex-1 flex-col gap-2">
                  <p className={cn("text-sm", step === "open" ? "text-ink-3" : "text-foreground")}>
                    ログインのあとに出るコードをコピーして、ここに貼ります。
                  </p>
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={step === "open"}
                    placeholder="例：AbC123…#xyz789…"
                    className="font-mono text-xs"
                  />
                  {step === "mismatch" ? (
                    <ErrorLine text="このコードは、いま開いたログインの画面のものではありません。もう一度「ログインの画面を開く」からやり直してください。" />
                  ) : null}
                  {step === "expired" ? (
                    <ErrorLine text="ログインの画面を開いてから10分を過ぎました。もう一度「ログインの画面を開く」から始めてください。" />
                  ) : null}
                </div>
              </li>
            </ol>
            <p className="text-xs text-ink-3">
              banto が受け取るのは推論とプロフィール（メールアドレス・契約の種類）の権限だけです。トークンはこの機械の banto の中に置き、コンテナや AI には渡しません。
            </p>
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button size="sm" variant="ghost">キャンセル</Button>
              <Button
                size="sm"
                disabled={step === "open" || step === "exchanging"}
                onClick={() => {
                  setStep("exchanging");
                  setTimeout(() => setStep("done"), 1100);
                }}
              >
                {step === "exchanging" ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    確かめています…
                  </>
                ) : (
                  "アカウントを足す"
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepMark({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
        done ? "bg-ok-soft text-ok" : "bg-surface-3 text-ink-2",
      )}
    >
      {n}
    </span>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-stop">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  );
}

/* ───────── 3. Project 設定「Claude のアカウント」 ───────── */

function ProjectSettings() {
  const [mode, setMode] = useState<"default" | "own">("own");
  const [order, setOrder] = useState(["b", "c"]);
  const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-xs text-ink-3">Project の設定 ／ banto開発</span>
        <h1 className="text-lg font-semibold text-foreground">Claude のアカウント</h1>
      </header>

      <div className="flex flex-col gap-2">
        {(
          [
            ["default", "既定の並びを使う", "このマシンの Claude Code のログイン → 仕事用"],
            ["own", "この Project の並びを決める", "1つだけ選ぶと、そのアカウントだけを使います"],
          ] as const
        ).map(([id, title, note]) => (
          <label
            key={id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3",
              mode === id ? "border-[var(--banto-accent)] bg-surface-2/50" : "border-border",
            )}
          >
            <input type="radio" name="mode" checked={mode === id} onChange={() => setMode(id)} className="mt-1 accent-[var(--banto-accent)]" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm text-foreground">{title}</span>
              <span className="text-xs text-ink-3">{note}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "own" ? (
        <section className="flex flex-col gap-2">
          <ol className="flex flex-col rounded-lg border border-border">
            {order.map((id, i) => {
              const a = byId.get(id)!;
              return (
                <li key={id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <span className="w-4 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                  <span className="flex flex-1 flex-col">
                    <span className="text-sm text-foreground">{a.label}</span>
                    <span className="text-xs text-ink-3">
                      5時間 {a.fiveHour === undefined ? "—" : `${a.fiveHour}%`}、週 {a.week}%
                    </span>
                  </span>
                  {i === 0 ? <span className="rounded bg-ok-soft px-1.5 py-0.5 text-xs text-ok">いま使っています</span> : null}
                  <IconButton label="並びから外す" disabled={order.length === 1} onClick={() => setOrder((o) => o.filter((x) => x !== id))}>
                    <X className="size-3.5" />
                  </IconButton>
                </li>
              );
            })}
          </ol>
          {ACCOUNTS.filter((a) => !order.includes(a.id)).map((a) => (
            <Button key={a.id} size="sm" variant="ghost" className="self-start text-xs" onClick={() => setOrder((o) => [...o, a.id])}>
              <Plus className="size-3" />
              {a.label}を並びに足す
            </Button>
          ))}
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            並びに契約の違うアカウント（Max 5x と Pro）が入っています。切り替えると、既定のモデルや文脈の長さが変わることがあります。
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-1 border-t border-border pt-4 text-xs text-ink-2">
        <span className="font-medium text-foreground">最近の切り替え</span>
        <span>今日 16:42　このマシンの Claude Code のログイン → 仕事用（5時間 96%）</span>
        <span>昨日 23:10　予備 → 仕事用（リセットで戻りました）</span>
      </section>
    </div>
  );
}

/* ───────── 4. 会話：切り替えの1行・上限の待ち ───────── */

function ThreadScene() {
  const [waiting, setWaiting] = useState(true);
  return (
    <div className="flex w-full max-w-5xl overflow-hidden rounded-xl border border-border">
      <aside className="hidden w-60 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3 text-sm sm:flex">
        <span className="px-2 pb-1 text-xs text-ink-3">Project</span>
        <div className="flex flex-col rounded-md bg-sidebar-accent px-2 py-1.5">
          <span className="flex items-center gap-2 text-foreground">
            <MessageSquare className="size-3.5" />
            banto開発
          </span>
        </div>
        <div className="flex flex-col pl-5">
          <span className="flex items-center gap-2 rounded-md px-2 py-1 text-foreground">
            <GitFork className="size-3.5 text-ink-3" />
            毎晩のテスト
          </span>
          {waiting ? (
            <span className="flex items-center gap-1 px-2 pl-7 text-xs text-ink-3">
              <Clock className="size-3" />
              上限が戻るのを待っています（18:01）
            </span>
          ) : null}
          <span className="flex items-center gap-2 rounded-md px-2 py-1 text-ink-2">
            <GitFork className="size-3.5 text-ink-3" />
            複数の Claude 認証情報
          </span>
        </div>
      </aside>

      <main className="flex min-h-[34rem] flex-1 flex-col">
        <div className="border-b border-border px-5 py-3 text-sm font-medium text-foreground">毎晩のテスト</div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 text-sm">
          <Bubble who="ai">フル E2E を流しています。315 件のうち 120 件まで終わりました。</Bubble>
          <SwitchLine text="Claude のアカウントを「仕事用」に切り替えました（このマシンの Claude Code のログインの5時間 96%）" />
          <Bubble who="ai">落ちた 2 件を調べています。browser-video:428 はページの高さが 40px 足りないようです…</Bubble>
          <SwitchLine text="並びのアカウントがどれも閾値を越えています。一番早くリセットされる「このマシンの Claude Code のログイン」で続けます" warn />
          <div className="flex items-start gap-2 rounded-md border border-stop/40 bg-stop-soft px-3 py-2 text-xs text-foreground">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-stop" />
            Claude の使用量の上限に当たったので、このターンは途中で止まりました。
          </div>
        </div>

        {waiting ? (
          <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
            <Clock className="size-4" style={{ color: "var(--banto-accent)" }} />
            <div className="flex flex-1 flex-col">
              <span className="text-sm text-foreground">18:01 に自動で続けます（あと 1時間13分）</span>
              <span className="text-xs text-ink-3">上限が戻ったら、止まったところから続けます。何か送ると、待たずにその発言で始めます。</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setWaiting(false)}>今すぐ続ける</Button>
            <Button size="sm" variant="ghost" onClick={() => setWaiting(false)}>待つのをやめる</Button>
          </div>
        ) : null}
        <div className="border-t border-border px-5 py-3">
          <div className="rounded-lg border border-border px-3 py-2 text-sm text-ink-3">メッセージを送る…</div>
        </div>
      </main>
    </div>
  );
}

function Bubble({ who, children }: { who: "ai" | "human"; children: React.ReactNode }) {
  return <p className={cn("max-w-[80%] leading-relaxed", who === "human" ? "self-end rounded-lg bg-surface-2 px-3 py-2" : "text-foreground")}>{children}</p>;
}

function SwitchLine({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 text-xs", warn ? "text-warn" : "text-ink-3")}>
      <span className="h-px flex-1 bg-border" />
      <RefreshCw className="size-3 shrink-0" />
      <span className="text-center">{text}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/* ───────── 5. 受信箱：全部が閾値を越えた ───────── */

function InboxScene() {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <Inbox className="size-5" />
        受信箱
      </h1>
      <article className="flex flex-col gap-3 rounded-lg border border-border border-l-4 border-l-warn bg-background px-4 py-4">
        <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
          <span>banto開発　Claude のアカウント</span>
          <span>16:48</span>
        </div>
        <h2 className="text-sm font-semibold text-foreground">Claude のアカウントが全部、閾値を越えました</h2>
        <p className="text-sm text-ink-2">
          この Project の並び（このマシンの Claude Code のログイン・仕事用）はどちらも閾値を越えています。一番早く 18:00 にリセットされる「このマシンの Claude Code のログイン」で続けています。上限に当たると会話は止まり、リセットのあと自動で続けます。
        </p>
        <div className="grid gap-3 rounded-md bg-surface-2 px-3 py-3 sm:grid-cols-2">
          <Meter label="このマシンの…　5時間" value={97} threshold={95} reset="18:00" />
          <Meter label="仕事用　5時間" value={95} threshold={95} reset="20:28" />
        </div>
        <p className="text-xs text-ink-3">どれかが閾値の下に戻ったら、このカードは自動で閉じます。</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost">Project の設定を開く</Button>
          <Button size="sm">アカウントを足す</Button>
        </div>
      </article>
    </div>
  );
}
