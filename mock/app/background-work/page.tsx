"use client";

// 見本：裏の仕事の見え方（fork/bg-visibility、仕様 v4-architecture.md §4.1「仕事の画面で、いま何をしているかを分かるようにする」・
// §4.2「札の手がかりを Module があとから足す・結果で画面を名乗る」、v4-modules.md §2.3「人の画面——バックグラウンドのコマンド」・
// §4.2「人の画面——サービス」、v4-frontend.md §6.33）。上の帯は見本だけの場面切り替え（本物には無い）。
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Copy,
  FileText,
  GitFork,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  RotateCw,
  Search,
  Server,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Scene = "sidebar" | "subagent" | "shell" | "service";

export default function BackgroundWorkMockPage() {
  const [scene, setScene] = useState<Scene>("sidebar");
  // サイドバーの1件から開いたときは、狭い画面でも一覧でなくその1件の中身から見せる（本物は toolCallId で1件を選んで開く）
  const [fromSidebar, setFromSidebar] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-border bg-surface-2 px-4 py-2 text-xs text-ink-2">
        <span className="shrink-0 font-medium text-foreground">見本の場面：</span>
        {(
          [
            ["sidebar", "サイドバーのバックグラウンド"],
            ["subagent", "サブエージェントの仕事"],
            ["shell", "バックグラウンドのコマンド（Shell）"],
            ["service", "サービス（Service）"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => { setScene(id); setFromSidebar(false); }}
            className={cn("shrink-0 rounded-md px-2 py-1", scene === id ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-1 justify-center md:p-8">
        {scene === "sidebar" ? <SidebarScene open={(s) => { setScene(s); setFromSidebar(true); }} /> : null}
        {scene === "subagent" ? <SubagentScene initialDetail={fromSidebar} /> : null}
        {scene === "shell" ? <ShellScene initialDetail={fromSidebar} /> : null}
        {scene === "service" ? <ServiceScene /> : null}
      </div>
    </div>
  );
}

/* ───────── 共通：入口の画面の枠（左に一覧、右に1件） ───────── */

function LauncherFrame({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex w-full max-w-6xl flex-col overflow-hidden bg-background md:rounded-xl md:border md:border-border">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-md font-medium text-foreground">
        <span className="text-ink-3">{icon}</span>
        {title}
        <span className="ml-auto text-xs font-normal text-ink-3 max-md:hidden">会話の隣に開いた画面</span>
        <span className="ml-auto text-xs font-normal text-ink-3 md:hidden">画面いっぱいに開いた画面</span>
      </div>
      <div className="flex flex-1 flex-col md:min-h-[38rem] md:flex-row">{children}</div>
    </div>
  );
}

/** 狭い画面（md 未満）では一覧と中身のどちらか一方だけを出す。hidden は「いま中身を見ている」 */
function ListPane({ hidden, children }: { hidden?: boolean; children: React.ReactNode }) {
  return (
    <section className={cn("flex w-full shrink-0 flex-col gap-1 p-2 md:w-80 md:border-r md:border-border", hidden && "max-md:hidden")}>
      {children}
    </section>
  );
}

function BackToList({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 flex items-center gap-1 self-start rounded-md px-1 py-0.5 text-xs text-ink-2 hover:text-foreground md:hidden"
    >
      <ArrowLeft className="size-3.5" />
      一覧に戻る
    </button>
  );
}

function ListLabel({ label, count }: { label: string; count: number }) {
  return (
    <h2 className="flex items-center gap-2 px-2 pb-1 pt-2 text-xs text-ink-3">
      {label}
      <span className="rounded-full bg-surface-2 px-1.5 tabular-nums">{count}</span>
    </h2>
  );
}

function Row({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-surface-2" : "hover:bg-surface-2/60",
      )}
    >
      {children}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/* ───────── 1. サイドバー：バックグラウンドの一覧 ───────── */

function SidebarScene({ open }: { open: (s: Scene) => void }) {
  const [listOpen, setListOpen] = useState(true);
  return (
    <div className="flex w-full max-w-5xl overflow-hidden md:rounded-xl md:border md:border-border">
      <aside className="relative flex w-full shrink-0 flex-col gap-1 bg-sidebar p-3 text-sm md:w-64 md:border-r md:border-border">
        <span className="px-2 pb-1 text-xs text-ink-3">Project</span>
        <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-foreground">
          <MessageSquare className="size-3.5" />
          banto開発
        </div>
        <div className="flex flex-col pl-5">
          <div className="flex flex-col rounded-md px-2 py-1">
            <span className="flex items-center gap-2 text-foreground">
              <GitFork className="size-3.5 text-ink-3" />
              裏の仕事の見え方
            </span>
            <button
              type="button"
              onClick={() => setListOpen((v) => !v)}
              aria-expanded={listOpen}
              className="flex items-center gap-1 py-1 pl-5.5 text-left text-xs text-ink-3 hover:text-foreground"
            >
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
              バックグラウンドで 2 件
              <ChevronDown className={cn("size-3 transition-transform md:hidden", !listOpen && "-rotate-90")} />
            </button>
            {/* 広い画面：行の右に浮かぶ一覧（いまの Popover と同じ置き方）。狭い画面：行の下に開く（横に出す幅が無い） */}
            {listOpen ? (
              <div className="z-10 mt-1 -ml-5 rounded-lg border border-border bg-popover p-1.5 shadow-lg md:absolute md:left-[15.5rem] md:top-14 md:m-0 md:w-[26rem] md:p-2">
                <div className="px-2 pb-1.5 pt-1 text-xs text-ink-3">バックグラウンドで動いているもの（2）</div>
                <button type="button" onClick={() => open("subagent")} className="flex w-full gap-2.5 rounded-md px-2 py-2.5 text-left hover:bg-surface-2">
                  <Bot className="mt-0.5 size-4 shrink-0 text-ink-3" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm text-foreground">＃466 実装</span>
                    <span className="truncate text-xs text-ink-3">あなたは banto の実装者です。作業場所はこの worktree（ブランチ fork/remote-branch-sync）…</span>
                    <span className="line-clamp-3 rounded-sm bg-surface-2 px-1.5 py-1 text-xs leading-relaxed text-ink-2 md:line-clamp-2">
                      <Sparkles className="mr-1 inline size-3 align-[-2px] text-primary" />
                      要約：Repositories の git の中身を bundle で運ぶ口を書き終え、いまは単体試験を直しています。残りは E2E の1本です。（3分前）
                    </span>
                    <span className="text-xs text-ink-3">subagent・42分前に頼んだ</span>
                  </span>
                </button>
                <button type="button" onClick={() => open("shell")} className="flex w-full gap-2.5 rounded-md px-2 py-2.5 text-left hover:bg-surface-2">
                  <Terminal className="mt-0.5 size-4 shrink-0 text-ink-3" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm text-foreground">フル E2E</span>
                    <span className="truncate font-mono text-xs text-ink-3">cd banto && npm run e2e -- --workers 2</span>
                    <span className="text-xs text-ink-3">shell・18分前に頼んだ</span>
                  </span>
                </button>
                <p className="px-2 pt-1.5 text-xs text-ink-3">押すとその Thread へ移り、それぞれの画面が開きます。</p>
              </div>
            ) : null}
          </div>
          <span className="flex items-center gap-2 rounded-md px-2 py-1 text-ink-2">
            <GitFork className="size-3.5 text-ink-3" />
            毎晩のテスト
          </span>
        </div>
        <p className="mt-4 px-2 text-xs leading-relaxed text-ink-3 md:hidden">
          狭い画面では、一覧は Thread の行の下に開きます（行の右に浮かべる幅が無いため）。要約の1行は、人が「いまの様子を要約」を押したときだけ出ます。
        </p>
      </aside>
      <main className="flex min-h-[34rem] flex-1 flex-col max-md:hidden">
        <div className="border-b border-border px-5 py-3 text-sm font-medium text-foreground">裏の仕事の見え方</div>
        <div className="flex flex-1 flex-col gap-4 py-5 pl-[29rem] pr-5 text-sm text-foreground">
          <p className="leading-relaxed">
            ＃466 の実装をサブエージェントに頼み、フル E2E を待たずに流しました。終わったらこの会話に届きます。
          </p>
          <p className="text-xs leading-relaxed text-ink-3">
            要約の1行は、人がサブエージェントの仕事の画面で「いまの様子を要約」を押したときだけ出ます。Thread の行（「バックグラウンドで 2 件」）の高さは変わりません。
          </p>
        </div>
      </main>
    </div>
  );
}

/* ───────── 2. サブエージェントの仕事 ───────── */

type StepKind = "read" | "edit" | "execute" | "search" | "message";
interface Step {
  at: string;
  kind: StepKind;
  title: string;
  desc?: string;
  state?: "done" | "running" | "failed";
}

const STEPS: Step[] = [
  { at: "0:12", kind: "read", title: "CLAUDE.md" },
  { at: "0:14", kind: "read", title: "banto/CLAUDE.md" },
  { at: "0:20", kind: "read", title: "docs/specs/v4-modules.md" },
  { at: "0:31", kind: "message", title: "Core の実行場所の接続（remote-ssh.ts）を読んでいます。向こうで git を走らせる既存の口があるかを調べ、運び方を決めます。" },
  { at: "0:33", kind: "search", title: "\"runRemote\" を packages/core/src で検索" },
  { at: "0:40", kind: "read", title: "packages/core/src/runtime/remote-ssh.ts" },
  { at: "0:52", kind: "read", title: "packages/core/src/runtime/remote-ssh.test.ts" },
  { at: "1:05", kind: "read", title: "packages/modules/repositories/src/git.ts" },
  { at: "1:20", kind: "execute", title: "git bundle が標準出力に書けるか試す", desc: "cd /tmp/b && git bundle create - main | wc -c" },
  { at: "1:42", kind: "message", title: "共有の決まり（ブランチ名・中継の口の名前・bundle の上限）を @banto/module-contract に置くところから書き始めます。" },
  { at: "2:03", kind: "edit", title: "packages/module-contract/src/branch-sync.ts" },
  { at: "2:40", kind: "edit", title: "packages/modules/repositories/src/git.ts" },
  { at: "3:11", kind: "edit", title: "packages/modules/repositories/src/branch-sync.ts" },
  { at: "3:55", kind: "execute", title: "repositories をビルド", desc: "npm run build -w @banto/module-repositories", state: "failed" },
  { at: "4:02", kind: "message", title: "ビルドの失敗は、isSafeBranchName を移している途中の編集が原因です。続けます。" },
  { at: "4:30", kind: "edit", title: "packages/modules/repositories/src/publish.ts" },
  { at: "5:10", kind: "execute", title: "repositories をビルド", desc: "npm run build -w @banto/module-repositories" },
  { at: "5:40", kind: "execute", title: "branch-sync の単体試験を流す", desc: "npx vitest run src/branch-sync.test.ts", state: "running" },
];

const PLAN = [
  { text: "仕様と既存の接続の口を読む", state: "completed" },
  { text: "共有の決まりを module-contract に置く", state: "completed" },
  { text: "git の bundle の作り方・受け方を書く", state: "completed" },
  { text: "単体試験を足して通す", state: "in_progress" },
  { text: "E2E remote-runtime-ssh に1本足す", state: "pending" },
  { text: "docs/notes に経緯を書く", state: "pending" },
] as const;

const FILES = [
  { path: "packages/modules/repositories/src/branch-sync.ts", w: 4, r: 2 },
  { path: "packages/modules/repositories/src/git.ts", w: 3, r: 1 },
  { path: "packages/module-contract/src/branch-sync.ts", w: 2, r: 0 },
  { path: "packages/modules/repositories/src/publish.ts", w: 1, r: 1 },
  { path: "packages/core/src/runtime/remote-ssh.ts", w: 0, r: 2 },
  { path: "docs/specs/v4-modules.md", w: 0, r: 1 },
];

type SummaryState = "none" | "working" | "done" | "failed";

function SubagentScene({ initialDetail }: { initialDetail: boolean }) {
  const [selected, setSelected] = useState("a");
  const [summary, setSummary] = useState<SummaryState>("none");
  const [mobileDetail, setMobileDetail] = useState(initialDetail);

  const summarize = () => {
    setSummary("working");
    window.setTimeout(() => setSummary("done"), 1600);
  };

  return (
    <LauncherFrame title="サブエージェント" icon={<Bot className="size-4" />}>
      <ListPane hidden={mobileDetail}>
        <ListLabel label="実行中" count={2} />
        <Row selected={selected === "a"} onClick={() => { setSelected("a"); setMobileDetail(true); }}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
            ＃466 実装
            <span className="ml-auto text-xs tabular-nums text-ink-3">42分</span>
          </span>
          <span className="truncate pl-5.5 text-xs text-ink-2">branch-sync の単体試験を流す</span>
          <span className="pl-5.5 text-xs text-ink-3">やること 3 / 6・Claude Code</span>
        </Row>
        <Row selected={selected === "b"} onClick={() => { setSelected("b"); setMobileDetail(true); }}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
            仕様の下書きをレビュー
            <span className="ml-auto text-xs tabular-nums text-ink-3">6分</span>
          </span>
          <span className="truncate pl-5.5 text-xs text-ink-2">docs/specs/v4-architecture.md を読む</span>
          <span className="pl-5.5 text-xs text-ink-3">Claude Code</span>
        </Row>
        <ListLabel label="終わった仕事" count={37} />
        {[
          ["＃479 の原因を調べる", "1時間前・返答あり"],
          ["Haiku の版を調べる", "2時間前・返答あり"],
          ["フロントの lint を直す", "昨日・止めました"],
        ].map(([t, s]) => (
          <Row key={t} selected={false} onClick={() => {}}>
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <Check className="size-3.5 text-ok" />
              {t}
            </span>
            <span className="pl-5.5 text-xs text-ink-3">{s}</span>
          </Row>
        ))}
      </ListPane>

      <section className={cn("flex min-w-0 flex-1 flex-col", !mobileDetail && "max-md:hidden")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-5">
          <BackToList onClick={() => setMobileDetail(false)} />
          <div className="flex min-w-0 basis-full flex-col md:basis-auto">
            <span className="text-lg font-medium text-foreground">＃466 実装</span>
            <span className="text-xs text-ink-3">Claude Code・Opus 5.5・作業場所 .worktrees/remote-branch-sync・頼んだのは Factory</span>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs text-accent-foreground md:ml-auto">
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
            動いています 42分
          </span>
          <Button size="sm" variant="outline">
            <Square className="size-3" />
            止める
          </Button>
        </div>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 md:px-5 md:py-5">
          {/* いまの状況 */}
          <section aria-label="いまの状況" className="flex flex-col gap-4 rounded-lg border border-border bg-surface-2/50 p-3 md:p-4">
            <div className="flex items-start gap-3">
              <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
              <div className="flex min-w-0 flex-col">
                <span className="text-xs text-ink-3">いまやっていること（20秒前から）</span>
                <span className="text-lg text-foreground">branch-sync の単体試験を流す</span>
                <span className="break-all font-mono text-xs text-ink-3">npx vitest run src/branch-sync.test.ts</span>
              </div>
            </div>

            <SummaryBox state={summary} onSummarize={summarize} onRetry={summarize} onFail={() => setSummary("failed")} />

            <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
                <h3 className="flex items-baseline gap-2 text-sm font-medium text-foreground">
                  やること
                  <span className="text-xs font-normal tabular-nums text-ink-3">3 / 6 済み</span>
                </h3>
                <div className="flex h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <span className="bg-ok" style={{ width: "50%" }} />
                </div>
                <ol className="flex flex-col gap-1 text-sm">
                  {PLAN.map((p) => (
                    <li key={p.text} className={cn("flex items-start gap-2", p.state === "completed" ? "text-ink-3" : p.state === "in_progress" ? "font-medium text-foreground" : "text-ink-2")}>
                      {p.state === "completed" ? (
                        <Check className="mt-1 size-3.5 shrink-0 text-ok" />
                      ) : p.state === "in_progress" ? (
                        <Loader2 className="mt-1 size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
                      ) : (
                        <Circle className="mt-1 size-3.5 shrink-0 text-ink-3" />
                      )}
                      <span className={cn(p.state === "completed" && "line-through decoration-ink-3/40")}>{p.text}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-medium text-foreground">最後の発言<span className="ml-2 text-xs font-normal text-ink-3">1分前</span></h3>
                  <p className="border-l-2 border-border pl-3 text-sm leading-relaxed text-ink-2">
                    ビルドの失敗は、isSafeBranchName を移している途中の編集が原因です。続けます。
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-medium text-foreground">触ったファイル<span className="ml-2 text-xs font-normal text-ink-3">書いた 4・読んだ 9</span></h3>
                  <ul className="flex flex-col gap-0.5">
                    {FILES.map((f) => (
                      <li key={f.path} className="flex items-center gap-2 text-xs">
                        {f.w > 0 ? <Pencil className="size-3 shrink-0 text-warn" aria-label="書いた" /> : <FileText className="size-3 shrink-0 text-ink-3" aria-label="読んだ" />}
                        <span className="truncate font-mono text-ink-2" title={f.path}>{f.path}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-ink-3">{f.w > 0 ? `書いた ${f.w}` : `読んだ ${f.r}`}</span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="self-start text-xs text-primary hover:underline">ほか 7 件を見る</button>
                </div>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-foreground">頼んだ内容</h2>
            <p className="line-clamp-2 text-sm text-ink-2">
              あなたは banto（Claude を使う仕事の道具。TypeScript のモノレポ）の実装者です。作業場所はこの worktree（ブランチ fork/remote-branch-sync）。最初に CLAUDE.md を読み、その規則に従ってください。## 頼むこと：Backlog ＃466 を直す…
            </p>
            <button type="button" className="self-start text-xs text-primary hover:underline">全文を読む</button>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="flex items-baseline gap-2 text-sm font-medium text-foreground">
              経過
              <span className="text-xs font-normal text-ink-3">ツール 15 回・発言 3</span>
            </h2>
            <Trace steps={STEPS} />
          </section>
        </div>
      </section>
    </LauncherFrame>
  );
}

function SummaryBox({ state, onSummarize, onRetry, onFail }: { state: SummaryState; onSummarize: () => void; onRetry: () => void; onFail: () => void }) {
  if (state === "none")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={onSummarize}>
          <Sparkles className="size-3.5" />
          いまの様子を要約
        </Button>
        <span className="text-xs text-ink-3">押したときだけ、小さいモデル（Haiku）で2文にまとめます。本体の Claude の使用量に数えます。</span>
        <button type="button" onClick={onFail} className="text-xs md:ml-auto text-ink-3 underline decoration-dotted">見本：失敗の表示</button>
      </div>
    );
  if (state === "working")
    return (
      <div className="flex items-center gap-2 text-sm text-ink-2">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
        要約しています…
      </div>
    );
  if (state === "failed")
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-foreground">
        <CircleAlert className="size-3.5 shrink-0 text-warn" />
        要約を作れませんでした：本体の Claude ログインが期限切れです。banto 本体で Claude にログインし直してから押してください。
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onRetry}>もう一度</Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-background px-3 py-2.5 ring-1 ring-border">
      <span className="flex items-center gap-1.5 text-xs text-ink-3">
        <Sparkles className="size-3 text-primary" />
        要約（たったいま・Haiku）
        <button type="button" onClick={onRetry} className="ml-auto flex items-center gap-1 text-primary hover:underline">
          <RotateCw className="size-3" />
          作り直す
        </button>
      </span>
      <p className="text-md leading-relaxed text-foreground">
        Repositories の git の中身を bundle で運ぶ口を書き終え、いまは単体試験を流して直しています。やること 6 件のうち 3 件が済み、残りは試験の通しと E2E の1本、メモの3つです。
      </p>
      <span className="text-xs text-ink-3">サイドバーのバックグラウンドの一覧にも出ています。AI には渡しません。</span>
    </div>
  );
}

const KIND_ICON: Record<Exclude<StepKind, "message">, React.ReactNode> = {
  read: <FileText className="size-3.5" />,
  edit: <Pencil className="size-3.5" />,
  execute: <Terminal className="size-3.5" />,
  search: <Search className="size-3.5" />,
};
const KIND_GROUP: Record<Exclude<StepKind, "message">, string> = {
  read: "ファイルを {n} 個読んだ",
  edit: "ファイルを {n} 個書いた",
  execute: "コマンドを {n} 回流した",
  search: "{n} 回検索した",
};

/** 同じ種類の tool が3つ以上続いたら1行に畳む。発言は吹き出しで挟む */
function Trace({ steps }: { steps: Step[] }) {
  const groups: Step[][] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && s.kind !== "message" && last[0].kind === s.kind && !s.state && !last.some((x) => x.state)) last.push(s);
    else groups.push([s]);
  }
  return (
    <ol className="flex flex-col">
      {groups.map((g, i) => (
        <TraceGroup key={i} steps={g} last={i === groups.length - 1} />
      ))}
    </ol>
  );
}

function TraceGroup({ steps, last }: { steps: Step[]; last: boolean }) {
  const [open, setOpen] = useState(false);
  const first = steps[0];
  if (first.kind === "message")
    return (
      <li className="relative flex gap-3 pb-3 pl-7">
        <Rail last={last} />
        <span className="absolute left-0 top-0.5 flex size-5 items-center justify-center rounded-full bg-surface-2 text-ink-3">
          <Bot className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="w-fit max-w-[44rem] rounded-lg rounded-tl-sm bg-surface-2 px-3 py-2 text-sm leading-relaxed text-foreground">{first.title}</p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">{first.at}</span>
      </li>
    );
  const kind = first.kind as Exclude<StepKind, "message">;
  if (steps.length >= 3 && !open)
    return (
      <li className="relative pb-3 pl-7">
        <Rail last={last} />
        <span className="absolute left-0 top-0 flex size-5 items-center justify-center text-ink-3">{KIND_ICON[kind]}</span>
        <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-1.5 text-left text-sm text-ink-2 hover:text-foreground">
          <ChevronRight className="size-3.5" />
          <span className="shrink-0">{KIND_GROUP[kind].replace("{n}", String(steps.length))}</span>
          <span className="min-w-0 truncate text-xs text-ink-3 max-sm:hidden">{steps.map((s) => s.title.split("/").pop()).join("、")}</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-3">{first.at}〜{steps[steps.length - 1].at}</span>
        </button>
      </li>
    );
  return (
    <>
      {steps.length >= 3 ? (
        <li className="pb-1 pl-7">
          <button type="button" onClick={() => setOpen(false)} className="flex items-center gap-1 text-xs text-ink-3 hover:text-foreground">
            <ChevronDown className="size-3" />
            畳む
          </button>
        </li>
      ) : null}
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-3 pb-3 pl-7">
          <Rail last={last && i === steps.length - 1} />
          <span className={cn("absolute left-0 top-0 flex size-5 items-center justify-center", s.state === "failed" ? "text-turn" : s.state === "running" ? "text-primary" : "text-ink-3")}>
            {s.state === "running" ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : KIND_ICON[kind]}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={cn("text-sm", s.state === "running" ? "font-medium text-foreground" : "text-foreground", kind !== "execute" && kind !== "search" && "font-mono text-xs")}>
              {s.title}
              {s.state === "failed" ? <span className="ml-2 text-xs text-turn">失敗</span> : null}
            </span>
            {s.desc ? <span className="truncate font-mono text-xs text-ink-3">{s.desc}</span> : null}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-ink-3">{s.at}</span>
        </li>
      ))}
    </>
  );
}

function Rail({ last }: { last: boolean }) {
  return last ? null : <span className="absolute bottom-0 left-2.5 top-5 w-px bg-border" aria-hidden />;
}

/* ───────── 3. Shell：バックグラウンドのコマンド ───────── */

const E2E_LINES = [
  "> banto-e2e@0.0.0 e2e",
  "> playwright test --workers 2",
  "",
  "Running 315 tests using 2 workers",
  "  ✓  1 [chromium] › specs/background-work.spec.ts:27 (21.3s)",
  "  ✓  2 [chromium] › specs/backlog.spec.ts:14 (12.8s)",
  "  ✓  3 [chromium] › specs/browser-tabs.spec.ts:40 (33.1s)",
  "  ✘  4 [chromium] › specs/browser-video.spec.ts:428 (41.0s)",
  "  ✓  5 [chromium] › specs/canvas-resize.spec.ts:9 (8.4s)",
  "  ✓  6 [chromium] › specs/claude-accounts.spec.ts:22 (17.9s)",
];
const MORE_LINES = [
  "  ✓  7 [chromium] › specs/factory.spec.ts:61 (52.6s)",
  "  ✓  8 [chromium] › specs/filesystem-browser.spec.ts:18 (14.0s)",
  "  ✓  9 [chromium] › specs/inbox.spec.ts:33 (11.2s)",
  "  ✓ 10 [chromium] › specs/missions.spec.ts:12 (29.7s)",
  "  ✓ 11 [chromium] › specs/patrol.spec.ts:8 (24.4s)",
  "  ✓ 12 [chromium] › specs/publish.spec.ts:45 (19.1s)",
];

interface Cmd {
  id: string;
  label: string;
  command: string;
  status: "running" | "exited" | "failed" | "cancelled" | "lost";
  time: string;
  sub: string;
}
const CMDS: Cmd[] = [
  { id: "e2e", label: "フル E2E", command: "cd banto && npm run e2e -- --workers 2", status: "running", time: "18分", sub: "315 件中 6 件" },
  { id: "build", label: "本番のビルド", command: "cd banto && npm run build", status: "running", time: "2分", sub: "" },
  { id: "unit", label: "core の単体を3回", command: "for i in 1 2 3; do npm test -w @banto/core || break; done", status: "exited", time: "4分", sub: "12分前に終わりました" },
  { id: "flaky", label: "patrol.spec を20回", command: "cd banto && npx playwright test patrol --repeat-each 20", status: "failed", time: "31分", sub: "1時間前に終わりました" },
  { id: "old", label: "npm ci", command: "cd banto && npm ci", status: "lost", time: "—", sub: "昨日・途中で終わりました" },
];

function CmdStatus({ c, stopped }: { c: Cmd; stopped?: boolean }) {
  if (stopped) return <span className="flex items-center gap-1 text-xs text-stop"><Square className="size-3" />止めました</span>;
  switch (c.status) {
    case "running":
      return <span className="flex items-center gap-1 text-xs text-primary"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />動いています</span>;
    case "exited":
      return <span className="flex items-center gap-1 text-xs text-ok"><Check className="size-3" />終わりました（0）</span>;
    case "failed":
      return <span className="flex items-center gap-1 text-xs text-turn"><CircleAlert className="size-3" />終わりました（1）</span>;
    case "lost":
      return <span className="flex items-center gap-1 text-xs text-warn"><CircleAlert className="size-3" />途中で終わりました</span>;
    default:
      return <span className="text-xs text-stop">止めました</span>;
  }
}

function ShellScene({ initialDetail }: { initialDetail: boolean }) {
  const [selected, setSelected] = useState("e2e");
  const [lines, setLines] = useState(E2E_LINES);
  const [stopped, setStopped] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [follow, setFollow] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(initialDetail);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (stopped) return;
    const t = window.setInterval(() => {
      setLines((l) => {
        const next = MORE_LINES[(l.length - E2E_LINES.length) % MORE_LINES.length];
        return [...l, next.replace(/ (\d+) \[/, () => ` ${String(l.length - 3).padStart(2)} [`)];
      });
    }, 1800);
    return () => window.clearInterval(t);
  }, [stopped]);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, follow]);

  const c = CMDS.find((x) => x.id === selected)!;
  const running = CMDS.filter((x) => x.status === "running");
  const ended = CMDS.filter((x) => x.status !== "running");

  return (
    <LauncherFrame title="バックグラウンドのコマンド" icon={<Terminal className="size-4" />}>
      <ListPane hidden={mobileDetail}>
        <ListLabel label="動いている" count={stopped ? running.length - 1 : running.length} />
        {running.map((x) => (
          <Row key={x.id} selected={selected === x.id} onClick={() => { setSelected(x.id); setMobileDetail(true); }}>
            <span className="flex items-center gap-2 text-sm text-foreground">
              {x.label}
              <span className="ml-auto text-xs tabular-nums text-ink-3">{x.time}</span>
            </span>
            <CmdStatus c={x} stopped={x.id === "e2e" && stopped} />
          </Row>
        ))}
        <ListLabel label="終わった" count={ended.length} />
        {ended.map((x) => (
          <Row key={x.id} selected={selected === x.id} onClick={() => { setSelected(x.id); setMobileDetail(true); }}>
            <span className="flex items-center gap-2 text-sm text-ink-2">
              {x.label}
              <span className="ml-auto text-xs tabular-nums text-ink-3">{x.time}</span>
            </span>
            <span className="flex items-center gap-2">
              <CmdStatus c={x} />
              <span className="text-xs text-ink-3">{x.sub}</span>
            </span>
          </Row>
        ))}
      </ListPane>

      <section className={cn("flex min-w-0 flex-1 flex-col", !mobileDetail && "max-md:hidden")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-5">
          <BackToList onClick={() => setMobileDetail(false)} />
          <div className="flex min-w-0 basis-full flex-col md:flex-1 md:basis-auto">
            <span className="text-lg font-medium text-foreground">{c.label}</span>
            <code className="line-clamp-2 break-all font-mono text-xs text-ink-2 md:truncate">{c.command}</code>
          </div>
          <CmdStatus c={c} stopped={c.id === "e2e" && stopped} />
          {c.status === "running" && !(c.id === "e2e" && stopped) ? (
            confirmStop ? (
              <span className="flex basis-full flex-wrap items-center gap-2 text-xs text-ink-2 md:basis-auto">
                <span className="max-md:basis-full">止めると、頼んだ会話に「止めました」が届きます。</span>
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="destructive" onClick={() => { setStopped(true); setConfirmStop(false); }}>止める</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>やめる</Button>
                </span>
              </span>
            ) : (
              <Button size="sm" variant="outline" className="max-md:ml-auto" onClick={() => setConfirmStop(true)}>
                <Square className="size-3" />
                止める
              </Button>
            )
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-border px-4 py-3 sm:grid-cols-4 md:px-5">
          <Fact label="始めた時刻">10月21日 10:12</Fact>
          <Fact label="経った時間"><span className="tabular-nums">{c.time}</span></Fact>
          <Fact label="作業場所">.worktrees/bg-visibility</Fact>
          <Fact label="秘密">なし</Fact>
        </dl>

        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3 md:px-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            <span>出力（stdout と stderr を出た順に。2秒ごとに読み足す）</span>
            <button type="button" className="text-primary hover:underline">もっと前を読む</button>
            <label className="flex items-center gap-1.5 md:ml-auto">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-primary" />
              新しい行を追いかける
            </label>
          </div>
          <pre
            ref={logRef}
            className="h-[55dvh] overflow-auto max-md:whitespace-pre-wrap max-md:[overflow-wrap:anywhere] rounded-md bg-surface-3 px-3 py-2 font-mono text-xs leading-relaxed text-foreground md:h-auto md:min-h-[18rem] md:flex-1"
          >
            {c.id === "e2e"
              ? lines.map((l, i) => (
                  <div key={i} className={cn(l.includes("✘") && "text-turn")}>{l || " "}</div>
                ))
              : <span className="text-ink-3">（見本では「フル E2E」だけ出力があります）</span>}
            {c.id === "e2e" && stopped ? <div className="text-stop">— 止めました（SIGTERM）—</div> : null}
          </pre>
          <div className="flex min-w-0 items-center gap-2 text-xs text-ink-3">
            <span className="min-w-0 truncate font-mono">~/.banto-modules/shell/commands/c-7f3a/output.log</span>
            <button type="button" className="flex shrink-0 items-center gap-1 text-primary hover:underline"><Copy className="size-3" />パスをコピー</button>
            <span className="ml-auto shrink-0 tabular-nums">{(lines.length * 0.06).toFixed(1)} KB</span>
          </div>
        </div>
      </section>
    </LauncherFrame>
  );
}

/* ───────── 4. Service：サービス ───────── */

interface Svc {
  name: string;
  state: "running" | "crashed" | "stopped" | "external" | "exited";
  command: string;
  ports: { port: number; listening: boolean }[];
  uptime: string;
  restarts: number;
}
const SVCS: Svc[] = [
  { name: "api", state: "crashed", command: "node dist/server.js", ports: [{ port: 8080, listening: false }], uptime: "—", restarts: 5 },
  { name: "mock", state: "running", command: "npx next dev -H 0.0.0.0 -p 4173", ports: [{ port: 4173, listening: true }], uptime: "3時間12分", restarts: 0 },
  { name: "watcher", state: "running", command: "npm run watch", ports: [], uptime: "3時間12分", restarts: 1 },
  { name: "demo-web", state: "stopped", command: "python3 -m http.server 8766 --bind 0.0.0.0", ports: [{ port: 8766, listening: false }], uptime: "—", restarts: 0 },
];

const API_LOG = [
  "10:31:02.114  > node dist/server.js",
  "10:31:02.580  listening on 0.0.0.0:8080",
  "10:31:03.002  Error: connect ECONNREFUSED 127.0.0.1:5432",
  "10:31:03.003      at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1606:16)",
  "10:31:03.010  process exited with code 1",
  "10:31:03.120  > node dist/server.js",
  "10:31:03.590  listening on 0.0.0.0:8080",
  "10:31:04.001  Error: connect ECONNREFUSED 127.0.0.1:5432",
  "10:31:04.012  process exited with code 1",
  "10:31:04.020  落ち続けたので起こし直しを止めました（10秒に5回）",
];

function SvcState({ s }: { s: Svc["state"] }) {
  const map = {
    running: ["動いています", "text-ok", <Circle key="i" className="size-2.5 fill-current" />],
    crashed: ["落ちました（上限に当たった）", "text-turn", <CircleAlert key="i" className="size-3" />],
    stopped: ["止めました", "text-ink-3", <Square key="i" className="size-2.5" />],
    external: ["外から止められました", "text-warn", <Square key="i" className="size-2.5" />],
    exited: ["自分で終わりました", "text-ink-3", <Check key="i" className="size-3" />],
  } as const;
  const [label, color, icon] = map[s];
  return <span className={cn("flex items-center gap-1.5 text-xs", color)}>{icon}{label}</span>;
}

function ServiceScene() {
  const [selected, setSelected] = useState("api");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const s = SVCS.find((x) => x.name === selected)!;
  return (
    <LauncherFrame title="サービス" icon={<Server className="size-4" />}>
      <ListPane hidden={mobileDetail}>
        <ListLabel label="この Project のサービス" count={SVCS.length} />
        {SVCS.map((x) => (
          <Row key={x.name} selected={selected === x.name} onClick={() => { setSelected(x.name); setConfirmRemove(false); setMobileDetail(true); }}>
            <span className="flex items-center gap-2 font-mono text-sm text-foreground">
              {x.name}
              <span className="ml-auto font-sans text-xs tabular-nums text-ink-3">{x.uptime}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <SvcState s={x.state} />
              {x.ports.map((p) => (
                <span key={p.port} className={cn("text-xs tabular-nums", p.listening ? "text-ink-2" : "text-ink-3 line-through")}>:{p.port}</span>
              ))}
            </span>
          </Row>
        ))}
        <p className="mt-auto px-2 pt-3 text-xs leading-relaxed text-ink-3">
          新しいサービスは AI に頼んで登録します（例「開発サーバを Service で動かして」）。公開の URL は「公開」の画面にあります。
        </p>
      </ListPane>

      <section className={cn("flex min-w-0 flex-1 flex-col", !mobileDetail && "max-md:hidden")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-5">
          <BackToList onClick={() => setMobileDetail(false)} />
          <div className="flex min-w-0 basis-full flex-col md:flex-1 md:basis-auto">
            <span className="font-mono text-lg font-medium text-foreground">{s.name}</span>
            <code className="line-clamp-2 break-all font-mono text-xs text-ink-2 md:truncate">{s.command}</code>
          </div>
          <SvcState s={s.state} />
          <div className="flex flex-wrap gap-2 max-md:ml-auto">
            {s.state === "running" ? (
              <>
                <Button size="sm" variant="outline"><RotateCw className="size-3" />起こし直す</Button>
                <Button size="sm" variant="outline"><Square className="size-3" />止める</Button>
              </>
            ) : (
              <Button size="sm" variant="outline"><Play className="size-3" />起動</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}><Trash2 className="size-3" />消す</Button>
          </div>
        </div>

        {confirmRemove ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-warn-soft px-4 py-3 text-sm text-foreground md:px-5">
            <CircleAlert className="size-4 shrink-0 text-warn" />
            「{s.name}」を止めて登録を消します。公開していれば、その公開もやめます。
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => setConfirmRemove(false)}>消す</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>やめる</Button>
            </span>
          </div>
        ) : null}

        {s.state === "crashed" ? (
          <div className="mx-4 mt-4 flex items-start md:mx-5 gap-2 rounded-md border border-turn/40 bg-turn-soft px-3 py-2 text-sm text-foreground">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-turn" />
            起動してすぐ落ちるのを 5 回繰り返したので、起こし直しを止めました。ログの最後を見て直してから「起動」を押してください。
          </div>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-border px-4 py-3 sm:grid-cols-4 md:px-5">
          <Fact label="ポート">
            {s.ports.length === 0 ? "なし" : s.ports.map((p) => (
              <span key={p.port} className="mr-2 tabular-nums">{p.port}<span className="ml-1 text-xs text-ink-3">{p.listening ? "待ち受けています" : "待ち受けていません"}</span></span>
            ))}
          </Fact>
          <Fact label="動いている時間">{s.uptime}</Fact>
          <Fact label="起こし直した回数"><span className="tabular-nums">{s.restarts}</span></Fact>
          <Fact label="最後の終了コード">{s.state === "crashed" ? "1（10:31:04）" : "—"}</Fact>
          <Fact label="作業場所">banto</Fact>
          <Fact label="秘密">DATABASE_URL ← db-url</Fact>
        </dl>

        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3 md:px-5">
          <div className="flex items-center gap-3 text-xs text-ink-3">
            <span>ログ（時刻つき）</span>
            <button type="button" className="text-primary hover:underline">もっと前を読む</button>
          </div>
          <pre className="h-[50dvh] overflow-auto max-md:whitespace-pre-wrap max-md:[overflow-wrap:anywhere] md:h-auto md:min-h-[16rem] md:flex-1 rounded-md bg-surface-3 px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
            {s.name === "api"
              ? API_LOG.map((l, i) => (
                  <div key={i} className={cn(/Error|exited|止めました/.test(l) && "text-turn")}>{l}</div>
                ))
              : <span className="text-ink-3">（見本では「api」だけログがあります）</span>}
          </pre>
        </div>
      </section>
    </LauncherFrame>
  );
}
