"use client";

// Factory の入口（launcher「Factory」、`banto.factory:runs`）の画面（v4-modules.md §4.5「人の画面」）。
// 人は基本、終わったら知ればよい。この画面は**長引いたとき・止まったときに覗く場所**（決定・2026-10-03、ユーザー）。
//   - 一覧は「あなたの答えを待っている」→「動いている」→「終わったもの（畳む）」。実行（runFactory の1回）ではなく
//     1件ずつ並べる——覗きたいのは件で、実行は束ねただけのもの。どの実行かは詳細に出す
//   - 1行の左に段の5目盛り（始める・実装・テスト・レビュー・マージ）。いまの段に居る時間が目安を越えたら「長引いています」
//   - 行を押すと右に詳細（Backlog と同じ Peek。Canvas が狭ければ入れ替わる）。止まっていれば答える欄が一番上
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Hand,
  Settings2,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  answerFactoryItem,
  cancelFactoryItem,
  FACTORY_STAGES,
  getFactoryRuns,
  getFactorySettings,
  LONG_STAGE_MIN,
  type FactoryItem,
  type FactoryRun,
  type FactoryStage,
} from "@/lib/mock/factory";

interface Row {
  run: FactoryRun;
  item: FactoryItem;
}

const minutes = (m: number) => (m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`);

function isLong(item: FactoryItem): boolean {
  return (item.status === "running" || item.status === "merging") && item.stageMin >= LONG_STAGE_MIN;
}

/** 段の位置（0〜4）。終わった・やめたは段を持たない */
function stageIndex(stage: FactoryStage): number {
  if (stage === "順番待ち") return -1;
  if (stage === "マージ待ち") return 4;
  if (stage === "終わった") return 5;
  return FACTORY_STAGES.indexOf(stage as (typeof FACTORY_STAGES)[number]);
}

export function FactoryView() {
  useMockStoreVersion();
  const params = useParams<{ projectId?: string }>();
  const projectId = params.projectId ?? "banto";
  const runs = getFactoryRuns(projectId);
  const settings = getFactorySettings(projectId);
  const [selected, setSelected] = useState<string | undefined>();
  const [showDone, setShowDone] = useState(false);

  const rows: Row[] = useMemo(() => runs.flatMap((run) => run.items.map((item) => ({ run, item }))), [runs]);
  const waiting = rows.filter((r) => r.item.status === "stopped");
  const active = rows.filter((r) => ["running", "merging", "queued"].includes(r.item.status));
  const closed = rows.filter((r) => r.item.status === "done" || r.item.status === "dropped");
  const current = rows.find((r) => `${r.run.id}/${r.item.taskId}` === selected);

  if (!settings.testCommand && rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-md text-ink-2">テストのコマンドを決めると、Backlog のタスクを流せます</p>
        <p className="max-w-sm text-sm text-ink-3">
          Factory はテストを通ったものだけを main に取り込みます。Project の設定の「Factory」で、この Project のテストの
          コマンドを入れてください。流すのは会話の AI に頼みます（「#42 を Factory に流して」）。
        </p>
        <SettingsButton />
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0">
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", current && "hidden @3xl:flex @3xl:max-w-md @3xl:border-r @3xl:border-border")}>
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
          <h2 className="text-md font-semibold text-foreground">Factory</h2>
          <span className="text-sm text-ink-3">
            {active.length} 件が動いている
            {waiting.length ? `・${waiting.length} 件があなたの答えを待っている` : ""}
          </span>
          <span className="ml-auto" />
          <SettingsButton compact />
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
          {waiting.length > 0 && (
            <Section title="あなたの答えを待っている" tone="turn">
              {waiting.map((r) => (
                <ItemRow key={`${r.run.id}/${r.item.taskId}`} row={r} selected={r === current} onSelect={setSelected} />
              ))}
            </Section>
          )}
          <Section title="動いている">
            {active.length === 0 ? (
              <p className="px-2 py-2 text-sm text-ink-3">いま動いているものはありません</p>
            ) : (
              active.map((r) => <ItemRow key={`${r.run.id}/${r.item.taskId}`} row={r} selected={r === current} onSelect={setSelected} />)
            )}
          </Section>
          {closed.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-ink-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {showDone ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                終わったもの
                <span className="font-normal text-ink-3">{closed.length}</span>
              </button>
              {showDone && closed.map((r) => <ItemRow key={`${r.run.id}/${r.item.taskId}`} row={r} selected={r === current} onSelect={setSelected} />)}
            </div>
          )}
        </div>
      </div>
      {current && (
        <div className="min-h-0 min-w-0 flex-1 @3xl:flex-[1.4]">
          <ItemDetail key={selected} row={current} onClose={() => setSelected(undefined)} />
        </div>
      )}
    </div>
  );
}

function SettingsButton({ compact }: { compact?: boolean }) {
  // 本物は Project の設定の Factory の節を開く（core の設定を重ねる口）。見本は見た目だけ
  return (
    <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2" title="Project の設定の「Factory」を開く">
      <Settings2 className="size-4" />
      {compact ? "設定" : "Factory の設定を開く"}
    </Button>
  );
}

function Section({ title, tone, children }: { title: string; tone?: "turn"; children: React.ReactNode }) {
  return (
    <section className="mt-3">
      <h3 className={cn("flex items-center gap-1.5 px-2 py-1.5 text-sm font-semibold", tone === "turn" ? "text-turn" : "text-ink-2")}>
        {tone === "turn" && <Hand className="size-4" />}
        {title}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** 段の5目盛り。済んだ段は緑の線、いまの段は太く（止まっていれば人の番の色）、まだの段は薄い線 */
function StageTicks({ item, size = "sm" }: { item: FactoryItem; size?: "sm" | "lg" }) {
  const at = stageIndex(item.stage);
  const dropped = item.status === "dropped";
  return (
    <span className={cn("flex shrink-0 items-center", size === "sm" ? "w-16 gap-0.5" : "w-full gap-1")} aria-hidden>
      {FACTORY_STAGES.map((s, i) => (
        <span
          key={s}
          // 塗りではなく線で描く（「塗ってよいのは turn だけ」、check-tokens）
          className={cn(
            "flex-1 rounded-full",
            size === "sm" ? "border-t-4" : "border-t-6",
            dropped
              ? "border-surface-3"
              : i < at
                ? "border-ok"
                : i === at
                  ? item.status === "stopped"
                    ? "border-turn"
                    : isLong(item)
                      ? "border-warn"
                      : "border-primary"
                  : "border-surface-3",
          )}
        />
      ))}
    </span>
  );
}

function ItemRow({ row, selected, onSelect }: { row: Row; selected: boolean; onSelect: (id: string) => void }) {
  const { item } = row;
  const long = isLong(item);
  const second =
    item.status === "stopped"
      ? item.stopped?.reason
      : item.subagent
        ? `${item.subagent.role}：${item.subagent.lastStep}`
        : item.status === "merging"
          ? "マージの列に並んでいる"
          : item.result;
  return (
    <button
      type="button"
      onClick={() => onSelect(`${row.run.id}/${item.taskId}`)}
      aria-current={selected || undefined}
      className={cn(
        "group flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring",
        selected && "bg-surface-2",
      )}
    >
      <span className="mt-2">
        <StageTicks item={item} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 text-sm text-ink-3">#{item.number}</span>
          <span className={cn("truncate text-md", item.status === "dropped" ? "text-ink-3 line-through" : "text-foreground")}>{item.title}</span>
        </span>
        {second && <span className={cn("mt-0.5 block truncate text-sm", item.status === "stopped" ? "text-turn" : "text-ink-3")}>{second}</span>}
      </span>
      <span className="mt-0.5 flex shrink-0 flex-col items-end">
        <span className={cn("text-sm", item.status === "stopped" ? "text-turn" : "text-ink-2")}>{item.stage}</span>
        {(item.status === "running" || item.status === "merging" || item.status === "stopped") && (
          <span className={cn("text-xs", long ? "text-warn" : "text-ink-3")}>
            {long ? `長引いています・${minutes(item.stageMin)}` : minutes(item.stageMin)}
          </span>
        )}
      </span>
    </button>
  );
}

// ---- 詳細 ----------------------------------------------------------------------------------------------

function ItemDetail({ row, onClose }: { row: Row; onClose: () => void }) {
  const { run, item } = row;
  const settings = getFactorySettings("banto");
  const activeItem = item.status === "running" || item.status === "merging" || item.status === "stopped" || item.status === "queued";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="一覧に戻る">
          <ChevronLeft className="size-4" />
        </Button>
        <span className="truncate text-sm text-ink-3">
          {item.story ? `${item.story} の中の` : ""}#{item.number}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pt-4 pb-6">
        <h2 className="text-lg font-semibold text-foreground">{item.title}</h2>
        <p className="mt-1 text-sm text-ink-3">
          {run.finishedMinAgo !== undefined ? `${minutes(run.finishedMinAgo)}前に終わった実行` : `${minutes(run.startedMinAgo)}前に「${run.requestedBy}」の会話から流した`}
          {activeItem ? `・始めてから ${minutes(item.totalMin)}` : ""}
        </p>

        <StageTrack item={item} limits={settings.limits} />

        {item.status === "stopped" && item.stopped && <AnswerBox row={row} />}

        {item.subagent && (
          <div className="mt-4 flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-ink-3">
                いま：{item.subagent.role}（{item.subagent.agent}）
                {isLong(item) ? <span className="text-warn">・この段に {minutes(item.stageMin)}</span> : null}
              </span>
              <span className="block truncate text-md text-foreground">{item.subagent.lastStep}</span>
            </span>
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" title="Subagent の画面でこの仕事の経過を開く">
              経過を見る
              <ExternalLink className="size-3.5" />
            </Button>
          </div>
        )}

        {item.result && <p className={cn("mt-4 text-md", item.status === "done" ? "text-ok" : "text-ink-2")}>{item.result}</p>}

        {item.lastTest && (
          <DetailSection title={item.lastTest.ok ? "最後のテスト：通った" : `最後のテスト：落ちた（終了コード ${item.lastTest.code}）`} tone={item.lastTest.ok ? "ok" : "stop"}>
            <p className="mb-1.5 text-xs text-ink-3">
              <code>{settings.testCommand}</code>
            </p>
            <pre className="max-h-48 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{item.lastTest.tail}</pre>
          </DetailSection>
        )}

        {item.lastReview && (
          <DetailSection title={item.lastReview.verdict === "pass" ? "レビュー：このまま取り込んでよい" : `レビュー：直すことが ${item.lastReview.items.length} つ`} tone={item.lastReview.verdict === "pass" ? "ok" : undefined}>
            {item.lastReview.items.length > 0 && (
              <ul className="flex flex-col gap-2">
                {item.lastReview.items.map((r, i) => (
                  <li key={i} className="text-md">
                    <span className="text-foreground">{r.what}</span>
                    {r.where && <span className="ml-1.5 text-sm text-ink-3">{r.where}</span>}
                    <span className="block text-sm text-ink-3">{r.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
        )}

        {item.diff && (
          <DetailSection title={`変更：コミット ${item.diff.commits}・ファイル ${item.diff.files.length}`}>
            <ul className="flex flex-col gap-1">
              {item.diff.files.map((f) => (
                <li key={f.path} className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 text-xs text-ok">+{f.add}</span>
                  <span className="shrink-0 text-xs text-stop">−{f.del}</span>
                </li>
              ))}
            </ul>
          </DetailSection>
        )}

        {item.journal.length > 0 && (
          <DetailSection title="何が起きたか">
            <ol className="flex flex-col">
              {item.journal.map((j, i) => (
                <li key={i} className="flex gap-3 py-1 text-sm">
                  <span className="w-12 shrink-0 text-right text-xs text-ink-3 tabular-nums">+{minutes(j.atMin)}</span>
                  <span className="w-16 shrink-0 text-xs text-ink-3">{j.stage}</span>
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      j.kind === "test-fail" || j.kind === "review-changes"
                        ? "text-stop"
                        : j.kind === "ask"
                          ? "text-turn"
                          : j.kind === "answer"
                            ? "text-foreground"
                            : "text-ink-2",
                    )}
                  >
                    {j.text}
                  </span>
                </li>
              ))}
            </ol>
          </DetailSection>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
        <GitBranch className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3" title={item.worktree}>
          {item.worktree}
        </span>
        {activeItem && item.status !== "stopped" && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 text-stop"
            onClick={() => cancelFactoryItem(run.id, item.taskId)}
            title="サブエージェントとテストも止め、Backlog を「準備できた」に戻します。worktree は残します"
          >
            <Square className="size-3.5" />
            止める
          </Button>
        )}
      </footer>
    </div>
  );
}

/** 段の流れ。回数がある段（テスト・レビュー）は上限と並べる */
function StageTrack({ item, limits }: { item: FactoryItem; limits: { testRetries: number; reviewRounds: number } }) {
  const at = stageIndex(item.stage);
  return (
    <div className="mt-4">
      <StageTicks item={item} size="lg" />
      <ol className="mt-1.5 grid grid-cols-5 gap-1">
        {FACTORY_STAGES.map((s, i) => {
          const here = i === at && item.status !== "done";
          const count =
            s === "テスト" && item.counts.test > 0
              ? `${item.counts.test}回／上限${limits.testRetries}`
              : s === "レビュー" && item.counts.review > 0
                ? `${item.counts.review}回／上限${limits.reviewRounds}`
                : undefined;
          return (
            <li key={s} className="min-w-0">
              <span
                className={cn(
                  "flex items-center gap-1 text-sm",
                  here ? (item.status === "stopped" ? "font-semibold text-turn" : "font-semibold text-foreground") : i < at ? "text-ink-2" : "text-ink-3",
                )}
              >
                {i < at && <Check className="size-3.5 shrink-0 text-ok" />}
                <span className="truncate">{s}</span>
              </span>
              {count && <span className="block truncate text-xs text-ink-3">{count}</span>}
              {here && (item.status === "running" || item.status === "stopped") && (
                <span className={cn("block text-xs", isLong(item) ? "text-warn" : "text-ink-3")}>{minutes(item.stageMin)}</span>
              )}
            </li>
          );
        })}
      </ol>
      {item.stage === "マージ待ち" && <p className="mt-2 text-sm text-ink-3">マージの列に並んでいます——前の件が main に入ったら、rebase してテストし直してから入ります</p>}
    </div>
  );
}

function DetailSection({ title, tone, children }: { title: string; tone?: "ok" | "stop"; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className={cn("mb-2 text-sm font-semibold", tone === "ok" ? "text-ok" : tone === "stop" ? "text-stop" : "text-ink-2")}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * **答える欄**。止まった理由を先に、答え方を下に。いちばんよく使う「指示を足して続ける」を塗り（人の番の色）にし、
 * ほかは枠だけ。答えは AI の answerFactory と同じ4つ
 */
function AnswerBox({ row }: { row: Row }) {
  const { run, item } = row;
  const [instruction, setInstruction] = useState("");
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState("");
  const offers = item.stopped!.offers;
  const doneStages = FACTORY_STAGES.filter((_, i) => i > 0 && i <= stageIndex(item.stage));
  return (
    <div className="mt-5 rounded-md border border-turn/40 bg-turn-soft p-3">
      <p className="flex items-center gap-1.5 text-md font-semibold text-turn">
        <Hand className="size-4" />
        {item.stopped!.reason}
      </p>
      {item.stopped!.detail && <p className="mt-1 text-sm text-ink-2">{item.stopped!.detail}</p>}
      <p className="mt-1 text-xs text-ink-3">頼んだ会話にも知らせてあります。そちらで AI に答えさせても同じです</p>

      {!dropping ? (
        <>
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="実装役への指示を足す（任意）——例：60 秒の上限を延ばすのではなく、待ち方を直して"
            className="mt-3 min-h-16 bg-card text-md"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {offers.includes("continue") && (
              <Button size="sm" className="bg-turn text-on-color hover:bg-turn/90" onClick={() => answerFactoryItem(run.id, item.taskId, { action: "continue", instruction })}>
                {instruction.trim() ? "指示を足して続ける" : "このまま続ける"}
              </Button>
            )}
            {offers.includes("accept") && (
              <Button size="sm" variant="outline" onClick={() => answerFactoryItem(run.id, item.taskId, { action: "accept" })}>
                指摘を承知で取り込む
              </Button>
            )}
            {offers.includes("retry") && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="gap-1">
                    やり直す
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {doneStages.map((s) => (
                    <DropdownMenuItem key={s} onSelect={() => answerFactoryItem(run.id, item.taskId, { action: "retry", stage: s })}>
                      {s}からやり直す
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <span className="ml-auto" />
            {offers.includes("drop") && (
              <Button size="sm" variant="ghost" className="text-ink-2" onClick={() => setDropping(true)}>
                やめる
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-ink-2">やめると Backlog は「準備できた」に戻ります。worktree とブランチは残します。</p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="やめる理由（任意）"
            className="mt-2 min-h-12 bg-card text-md"
            autoFocus
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" className="text-stop" onClick={() => answerFactoryItem(run.id, item.taskId, { action: "drop", reason })}>
              やめる
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDropping(false)}>
              戻る
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
