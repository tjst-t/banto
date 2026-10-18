"use client";

// **受信箱は会話と同じ前面の1枚。1件ずつのカードで、読んで・決めて・返信する**（決定・2026-10-15、ユーザー。
// v4-frontend.md §6.41・アーキ仕様 §2.4「受信箱は『あなたの番になったもの』だけ」。見本はモック
// `mock/components/banto/inbox/inbox-page.tsx`）。
//
// 左から出る Sheet をやめ、`?overlay=inbox` のときサイドバーの右の面を全部使って出す（下の会話は捨てずに隠す——
// app-shell.tsx）。並びは「あなたの判断を待っています → 決めることがあります → 返ってきた会話 → 直してほしいこと」、
// 中は新しい順：
// - 判断待ち：何を承認するのか（tool の引数）を見せ、その場で答える。答え方は会話のカードと同じ部品
//   （`ElicitationFormView`）、送る道も同じ（`answerRealJudgment`）——答えれば会話のカードも答え済みになる
// - 返ってきた会話（レビュー待ち）：host が添えたそのターンの中身（`turn`）を読み、決めることの選択肢を押すと返信の欄に
//   入る。送ると会話の入力欄と同じ口でその Thread にターンを始め、そのレビュー待ちは「見た」にする
// - 判断役（AI の「決めること」を AI が決める自動化、アーキ仕様 §4.3）：見ている間は「判断役が見ています」、決めたら
//   「判断役が決めました」（そこから別の選択肢を押すと「もう進めています。変えますか」を確かめる）、人に任せたら
//   「人に任せました」、答えが揃わなければ「n 問中 m 問しか答えずに終わりました」。決めて進んだ次のカードには
//   「判断役が〈選択肢〉を選んで進めました」を引き継ぐ
// - 直してほしいこと（お知らせ）：「見た」と、押せるものは「続ける」
// 行き先の口はカードの右上に出す（詳しく見たいとき）——どのカードにも（改訂・2026-10-15、ユーザー）。Thread が分かれば
// その会話、Project だけ分かればその Project の Base Thread、banto 全体のお知らせは直す場所の設定（`destinationOf`）。
//
// キー操作（パソコン）：j / k で次・前のカード、r で返信の欄へ、e で「見た」、o で行き先を開く、Esc で閉じる。
import { ToolInputDetails } from "@/components/banto/thread/tool-input-details";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { TextMessagePartProvider } from "@assistant-ui/react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  CornerDownLeft,
  ExternalLink,
  GitFork,
  Hand,
  Loader2,
  MessageSquareReply,
  Package,
  Wrench,
  X,
} from "lucide-react";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Button } from "@/components/ui/button";
import { MobileNavButton } from "@/components/banto/shell/mobile-nav-drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTouchKeyboard } from "@/hooks/use-touch-keyboard";
import { answerRealJudgment } from "@/lib/backend/adapter";
import {
  acknowledgeRealNotice,
  moveRealRuntimeKey,
  resumeRealNoticeTurn,
  sendRealThreadMessage,
  type RealInboxJudgment,
  type RealInboxNotice,
  type RealInboxReview,
  type RealReviewJudge,
} from "@/lib/backend/client";
import {
  getRealJudgments,
  getRealNotices,
  getRealReviews,
  refreshRealInbox,
  reviewSummaryOf,
  useRealInboxVersion,
} from "@/lib/backend/real-inbox";
import { getProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getThread } from "@/lib/mock/threads";
import { isOverlayOpen } from "@/lib/overlay-open";
import { safeLinkUrl, type TurnSummary } from "@/lib/turn-summary";
import { cn } from "@/lib/utils";
import { splitTargets } from "@/lib/relay-targets";
import { RelayTargetsTable } from "@/components/banto/thread/relay-targets-table";
import { ElicitationFormView } from "./elicitation-form";
import { RealInboxAcknowledgeAll } from "./inbox-acknowledge-all";

type Section = "judgment" | "decide" | "returned" | "fix";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "judgment", label: "あなたの判断を待っています" },
  { key: "decide", label: "決めることがあります" },
  { key: "returned", label: "返ってきた会話" },
  { key: "fix", label: "直してほしいこと" },
];

/** 送った・答えたあと、カードを畳んで一覧から外すまでの間 */
const LEAVE_AFTER_MS = 2600;

type Card =
  | { kind: "judgment"; id: string; createdAt: string; item: RealInboxJudgment }
  | { kind: "returned"; id: string; createdAt: string; item: RealInboxReview }
  | { kind: "fix"; id: string; createdAt: string; item: RealInboxNotice };

type Outcome = { kind: "sent"; text: string } | { kind: "answered"; choice: string } | { kind: "seen" };

function sectionOf(card: Card): Section {
  if (card.kind === "judgment") return "judgment";
  if (card.kind === "fix") return "fix";
  return (reviewSummaryOf(card.item)?.decisions.length ?? 0) > 0 ? "decide" : "returned";
}

/** 「3分前」のような相対表記。厳密さより読みやすさ——どれくらい待たせているかだけ分かればよい */
function age(createdAt: string, now: number): string {
  const diffSec = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 1000));
  if (diffSec < 60) return "たった今";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.round(hour / 24)}日前`;
}

type Destination = { href: string; label: string; target: "thread" | "project" | "settings" };

/**
 * **カードから移る先**（改訂・2026-10-15、ユーザー「全部のカードから関係する会話へ」、v4-frontend.md §6.41）。
 * 1. Thread が分かればその会話（Fork は `?fork=`。閉じた Fork も同じ道——開くと「閉じました」の帯つきで出る）。
 *    画面が Thread を手元に持っていなければ、host が添えた Project と種類から組む
 * 2. Project だけ分かれば、その Project（Base Thread）
 * 3. banto 全体のお知らせは、直す場所の設定。直す場所が banto の中に無いもの（本体の Claude ログインの期限切れ——
 *    直すのは banto を動かしている端末）は口を出さない——行き先を偽らない（規則13）
 */
function destinationOf(card: Card): Destination | null {
  const item = card.item;
  const threadId = item.kind === "notice" ? (item.threadId ?? item.resume?.threadId) : item.threadId;
  const thread = threadId ? getThread(threadId) : undefined;
  const projectId = thread?.projectId ?? item.projectId;
  const threadKind = thread?.kind ?? item.threadKind;
  if (threadId && projectId && threadKind) {
    const href = threadKind === "fork" ? `/p/${projectId}?fork=${threadId}` : `/p/${projectId}`;
    return { href, label: "会話を開く", target: "thread" };
  }
  if (projectId) return { href: `/p/${projectId}`, label: "Project を開く", target: "project" };
  if (item.kind === "notice" && (item.dedupeKey.startsWith("module-connect:") || item.dedupeKey.startsWith("module:"))) {
    // banto 全体の Module を繋げなかった・Module が出した知らせ——Module の一覧（繋がっているかと理由が出る）
    return { href: "/settings?section=roles", label: "Module の設定を開く", target: "settings" };
  }
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function InboxPage({ onClose }: { onClose: () => void }) {
  useRealInboxVersion();
  // Thread/Project の名前は mock ストア側の登録から引く（hydrateRealProjects が実 Thread を登録している）
  useMockStoreVersion();
  const isMobile = useIsMobile();

  // 開いたときに取り直す（別のブラウザが走らせたターンの分もここで入る）
  useEffect(() => {
    void refreshRealInbox();
  }, []);

  // 「いま」はレンダー中に読まない（React の純粋性）。表示のためだけの値なので、一定間隔で取り込む
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const live: Card[] = [
    ...getRealJudgments().map((item): Card => ({ kind: "judgment", id: item.id, createdAt: item.createdAt, item })),
    ...getRealReviews().map((item): Card => ({ kind: "returned", id: item.id, createdAt: item.createdAt, item })),
    ...getRealNotices().map((item): Card => ({ kind: "fix", id: item.id, createdAt: item.createdAt, item })),
  ];
  /**
   * **片づけたカード**。host から消えたあとも少しの間だけ「送りました」等を出してから外す——押した結果が見えないまま
   * 消えると、何が起きたか分からない
   */
  const [leaving, setLeaving] = useState<Record<string, { card: Card; outcome: Outcome }>>({});
  const liveIds = new Set(live.map((c) => c.id));
  const cards = [...live, ...Object.values(leaving).map((l) => l.card).filter((c) => !liveIds.has(c.id))].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  );
  const ordered = SECTIONS.flatMap((s) => cards.filter((c) => sectionOf(c) === s.key));

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused = ordered.some((c) => c.id === focusedId) ? focusedId : (ordered.find((c) => !leaving[c.id])?.id ?? null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  function focus(id: string, scroll = true) {
    setFocusedId(id);
    if (scroll) cardRefs.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /** 片づけた——次のカードへ進み（上から順に片づけられるように）、少ししてから一覧から外す */
  function settle(card: Card, outcome: Outcome) {
    setLeaving((prev) => ({ ...prev, [card.id]: { card, outcome } }));
    const at = ordered.findIndex((c) => c.id === card.id);
    const open = (c: Card) => c.id !== card.id && !leaving[c.id];
    const next = ordered.slice(at + 1).find(open) ?? ordered.slice(0, Math.max(0, at)).find(open);
    if (next) focus(next.id);
    window.setTimeout(
      () =>
        setLeaving((prev) => {
          const { [card.id]: _gone, ...rest } = prev;
          void _gone;
          return rest;
        }),
      outcome.kind === "seen" ? 300 : LEAVE_AFTER_MS,
    );
  }

  /** 「見た」にする（レビュー待ち・お知らせ）。失敗したら投げる——カードは残る */
  async function markSeen(card: Card): Promise<void> {
    await acknowledgeRealNotice(card.id);
    settle(card, { kind: "seen" });
    void refreshRealInbox();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // **上にほかの何か（Palette 等）が開いていたら、キーはそちらのもの**（`lib/overlay-open.ts`）
      if (isOverlayOpen({ exceptInbox: true })) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (e.key === "Escape") {
        if (typing) target.blur();
        else onClose();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = ordered.findIndex((c) => c.id === focused);
      const card = at >= 0 ? ordered[at] : undefined;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))];
        if (next) focus(next.id);
      } else if (e.key === "r" && card) {
        const input = cardRefs.current.get(card.id)?.querySelector<HTMLTextAreaElement>("textarea");
        if (input) {
          e.preventDefault();
          input.focus();
        }
      } else if (e.key === "e" && card && card.kind !== "judgment" && !leaving[card.id]) {
        e.preventDefault();
        void markSeen(card).catch(() => void refreshRealInbox());
      } else if (e.key === "o" && card) {
        cardRefs.current.get(card.id)?.querySelector<HTMLAnchorElement>("a[data-open-target]")?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const remaining = ordered.filter((c) => !leaving[c.id]).length;

  return (
    // Escape を聞く側（panel-stack.tsx・設定の面）が「上に何か開いている」と分かるよう、Dialog と同じ印を付ける
    // （`lib/overlay-open.ts`）。下の会話は app-shell が inert にしている
    <div
      role="dialog"
      aria-label="受信箱"
      data-state="open"
      data-banto-inbox=""
      data-testid="inbox-page"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
        {isMobile ? <MobileNavButton /> : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          受信箱
          <span data-testid="inbox-remaining" className="ml-2 text-xs font-normal tabular-nums text-ink-3">
            {remaining} 件
          </span>
        </p>
        <span className="hidden items-center gap-2 text-xs text-ink-3 lg:flex">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>移る
          <Kbd>r</Kbd>返信
          <Kbd>e</Kbd>見た
          <Kbd>o</Kbd>開く
        </span>
        <RealInboxAcknowledgeAll />
        <button
          type="button"
          onClick={onClose}
          aria-label="受信箱を閉じる"
          data-testid="inbox-close"
          className="ml-1 flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-8"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-2 pt-3 pb-24 md:px-6 md:pt-6">
          {ordered.length === 0 ? (
            <div data-testid="inbox-empty" className="flex flex-col items-center gap-2 py-24 text-center">
              <CircleCheck className="size-8 text-ok" />
              <p className="text-sm text-foreground">あなたの番のものはありません</p>
              <p className="text-xs text-ink-3">AI が返してきたら、ここに出ます</p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const rows = ordered.filter((c) => sectionOf(c) === section.key);
              if (rows.length === 0) return null;
              const urgent = section.key === "judgment" || section.key === "decide";
              return (
                <section key={section.key} data-testid={`inbox-section-${section.key}`} className="mb-8">
                  <h2 className="mb-2 flex items-baseline gap-2 px-1">
                    <span className={cn("text-md font-semibold", urgent ? "text-turn" : "text-foreground")}>
                      {section.label}
                    </span>
                    <span data-testid="inbox-section-count" className="text-xs tabular-nums text-ink-3">
                      {rows.length}
                    </span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {rows.map((card) => {
                      const settled = leaving[card.id]?.outcome;
                      return (
                        <article
                          key={card.id}
                          ref={(el) => {
                            if (el) cardRefs.current.set(card.id, el);
                            else cardRefs.current.delete(card.id);
                          }}
                          onFocusCapture={() => focus(card.id, false)}
                          onMouseDown={() => focus(card.id, false)}
                          data-testid={card.kind === "judgment" ? "inbox-judgment" : card.kind === "fix" ? "inbox-notice" : "inbox-review"}
                          data-id={card.id}
                          data-focused={focused === card.id || undefined}
                          className={cn(
                            "overflow-hidden rounded-xl border bg-card transition-[opacity,box-shadow,border-color] duration-300",
                            focused === card.id ? "border-ink-3/40 shadow-2" : "border-border",
                            settled ? "opacity-70" : "",
                          )}
                        >
                          <CardHead card={card} now={now} />
                          {settled ? (
                            <SettledBody outcome={settled} card={card} />
                          ) : card.kind === "judgment" ? (
                            <JudgmentBody item={card.item} onAnswered={(choice) => settle(card, { kind: "answered", choice })} />
                          ) : card.kind === "returned" ? (
                            <ReturnedBody
                              item={card.item}
                              onSent={(text) => settle(card, { kind: "sent", text })}
                              onSeen={() => markSeen(card)}
                            />
                          ) : (
                            <NoticeBody item={card.item} onSeen={() => markSeen(card)} />
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-xs text-ink-2">
      {children}
    </kbd>
  );
}

// ── カードの頭：どこの会話か・印・何分前・会話を開く ─────────────────────────

function CardHead({ card, now }: { card: Card; now: number }) {
  const threadId = card.kind === "fix" ? (card.item.threadId ?? card.item.resume?.threadId) : card.item.threadId;
  const thread = threadId ? getThread(threadId) : undefined;
  const projectId = thread?.projectId ?? card.item.projectId;
  const project = projectId ? getProject(projectId) : undefined;
  const threadName = thread ? (thread.kind === "base" ? "Base Thread" : (thread.title ?? "Fork Thread")) : null;
  const destination = destinationOf(card);
  return (
    <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
      <Mark card={card} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-ink-2">
        <span data-testid="inbox-card-project" className="shrink-0 font-medium text-foreground">
          {project ? project.name : card.kind === "fix" && !projectId ? "banto 全体" : "（読み込み中の Project）"}
        </span>
        {threadName ? (
          <>
            <span aria-hidden className="text-ink-3">
              /
            </span>
            {thread?.kind === "fork" ? <GitFork className="size-3 shrink-0 text-ink-3" /> : null}
            <span data-testid="inbox-card-thread" className="truncate">
              {threadName}
            </span>
          </>
        ) : null}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-ink-3">{age(card.createdAt, now)}</span>
      {destination ? (
        // 押すとその先へ移る（受信箱は URL の `?overlay=inbox` が持っているので、移れば閉じる）。開いた会話が
        // レビュー待ちを「見た」にする（`markThreadViewing`）——ここでも先に「見た」にしておく。お知らせは「見た」に
        // しない——直すまで残す
        <Link
          href={destination.href}
          data-open-target={destination.target}
          data-testid={`inbox-open-${destination.target}`}
          onClick={() => {
            if (card.kind === "returned") void acknowledgeRealNotice(card.id).catch(() => undefined);
          }}
          className="-mr-1.5 flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 hover:bg-accent hover:text-foreground"
          aria-label={destination.label}
        >
          <span className="hidden sm:inline">{destination.label}</span>
          <ArrowUpRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

/** ターンが最後まで行かなかったなら、その理由（黄で出し、返信の欄の横を「続ける」にする） */
function cutReason(item: RealInboxReview): string | undefined {
  switch (item.turn?.outcome) {
    case "interrupted":
      return "banto を起こし直したなどで、途中で切れました";
    case "stopped":
      return "止めたので、途中で終わりました";
    case "failed":
      return "失敗して、途中で終わりました";
    default:
      return undefined;
  }
}

function Mark({ card }: { card: Card }) {
  const base = "flex size-6 shrink-0 items-center justify-center rounded-full";
  if (card.kind === "judgment")
    return (
      <span className={cn(base, "bg-turn-soft text-turn")}>
        <Hand className="size-3.5" />
      </span>
    );
  if (card.kind === "fix")
    return (
      <span className={cn(base, "bg-warn-soft text-warn")}>
        <Wrench className="size-3.5" />
      </span>
    );
  const summary = reviewSummaryOf(card.item);
  if ((summary?.decisions.length ?? 0) > 0)
    return (
      <span className={cn(base, "bg-turn-soft text-turn")}>
        <MessageSquareReply className="size-3.5" />
      </span>
    );
  if (cutReason(card.item) || summary?.outcome.status === "failed")
    return (
      <span className={cn(base, "bg-warn-soft text-warn")}>
        <CircleX className="size-3.5" />
      </span>
    );
  if (summary?.outcome.status === "partial")
    return (
      <span className={cn(base, "bg-surface-2 text-ink-2")}>
        <CircleDashed className="size-3.5" />
      </span>
    );
  return (
    <span className={cn(base, "bg-ok-soft text-ok")}>
      <CircleCheck className="size-3.5" />
    </span>
  );
}

// ── 判断待ち：何を承認するのかを見せ、その場で答える ─────────────────────────

function JudgmentBody({ item, onAnswered }: { item: RealInboxJudgment; onAnswered: (choice: string) => void }) {
  /** 答えようとして断られた理由（押したのに何も起きない、を作らない——規則2） */
  const [error, setError] = useState<string | null>(null);
  const { rest, targets } = splitTargets(item.toolInput);
  return (
    <div className="px-4 pb-4">
      <p className="text-sm text-foreground">
        {item.serverName ? <span className="font-medium text-turn">{item.serverName}</span> : null}
        {item.serverName ? "　" : null}
        <span data-testid="inbox-judgment-message">{item.message}</span>
      </p>
      {/* 会話のカードと同じ出し方（tool-input-details.tsx） */}
      <ToolInputDetails input={targets ? rest : item.toolInput} className="mt-2.5 max-h-96 overflow-auto" />
      {/* まとめて引く口の対象は1行1件の表（JSON のまま出さない） */}
      {targets ? (
        <div className="mt-2.5">
          <RelayTargetsTable targets={targets} />
        </div>
      ) : null}
      {item.source === "elicitation" ? (
        // Module からの質問（Elicitation）は、受信箱から答える口が host に無い（会話のカードも同じ）——会話を開いて答える
        <p className="mt-3 text-xs text-ink-3">この問いには会話を開いて答えてください</p>
      ) : (
        <div data-testid="inbox-judgment-answer" className="mt-3">
          <ElicitationFormView
            elicitation={{ mode: "form", enumOptions: item.choices ?? ["許可する", "拒否する"], allowFreeText: false }}
            onAnswered={async (answer) => {
              try {
                await answerRealJudgment(item.id, answer);
                setError(null);
                onAnswered(answer);
              } catch (err) {
                setError(errorText(err));
                void refreshRealInbox();
              }
            }}
          />
          {error ? (
            <span data-testid="inbox-judgment-answer-error" className="mt-1 block text-xs text-stop">
              答えを送れませんでした：{error}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── 返ってきた会話：読んで、決めて、返信する ─────────────────────────────

const STATUS = {
  done: { label: "終わった", cls: "text-ok" },
  partial: { label: "途中まで", cls: "text-ink-2" },
  failed: { label: "できなかった", cls: "text-warn" },
} as const;

/** これより長い返事は、まとめが無いとき途中まで出して「続きを読む」 */
const LONG_REPLY_CHARS = 220;
/** 返信の欄が伸びる上限（px）。これより長い返事は欄の中でスクロールする */
const REPLY_MAX_HEIGHT_PX = 320;

function ReturnedBody({
  item,
  onSent,
  onSeen,
}: {
  item: RealInboxReview;
  onSent: (text: string) => void;
  onSeen: () => Promise<void>;
}) {
  const turn = item.turn;
  const s: TurnSummary | undefined = reviewSummaryOf(item);
  const cut = cutReason(item);
  const reply = turn?.reply ?? "";
  const touchKeyboard = useTouchKeyboard();
  const [chosen, setChosen] = useState<Record<number, string>>({});
  // 判断役が決めた問いで、別の選択肢を押した——確かめている間の問いと選択肢
  const [confirming, setConfirming] = useState<{ index: number; reply: string; label: string } | null>(null);
  const judge = item.judge;
  /** 判断役が決めた選択肢（問いの位置 0 から → 選択肢の位置 0 から） */
  const judgeChoice = new Map<number, { choice: number; label: string }>(
    judge?.kind === "decided-by-automation" ? (judge.answers ?? []).map((a) => [a.question - 1, { choice: a.choice - 1, label: a.label }]) : [],
  );
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // 返信の欄は書いた分だけ下へ伸ばす（上限 REPLY_MAX_HEIGHT_PX、超えたら欄の中でスクロール）。
  // field-sizing: content は Firefox・古い Safari で効かないので、高さを測って入れる
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), REPLY_MAX_HEIGHT_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight + (el.offsetHeight - el.clientHeight) > REPLY_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [draft]);

  function choose(index: number, text: string) {
    const next = { ...chosen, [index]: text };
    setChosen(next);
    setDraft(
      Object.keys(next)
        .map(Number)
        .sort((a, b) => a - b)
        .map((k) => next[k])
        .join("\n"),
    );
    requestAnimationFrame(() => textRef.current?.focus());
  }

  /** 選択肢を押した。判断役がもう決めて元の会話が進んでいる問いで別のものを押したら、変えるかを先に確かめる */
  function pick(index: number, optionIndex: number, reply: string, label: string) {
    const decided = judgeChoice.get(index);
    if (decided && decided.choice !== optionIndex && chosen[index] !== reply) {
      setConfirming({ index, reply, label });
      return;
    }
    setConfirming(null);
    choose(index, reply);
  }

  function suggest(text: string) {
    setDraft(text);
    requestAnimationFrame(() => textRef.current?.focus());
  }

  /** その Thread に送る（会話の入力欄と同じ口）。送れたらこのレビュー待ちは「見た」 */
  async function send(text: string) {
    // Enter を続けて押しても1回だけ送る（描き直す前の2回目も止める）
    if (busyRef.current || text === "") return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await sendRealThreadMessage(item.threadId, text);
    } catch (err) {
      setError(`送れませんでした：${errorText(err)}`);
      busyRef.current = false;
      setBusy(false);
      return;
    }
    // 送れた。「見た」にできなくても送ったことは変わらない（host も人が送ったターンの始まりで「見た」にする）
    await acknowledgeRealNotice(item.id).catch(() => undefined);
    onSent(text);
    void refreshRealInbox();
  }

  async function seen() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSeen();
    } catch (err) {
      setError(`「見た」にできませんでした：${errorText(err)}`);
      busyRef.current = false;
      setBusy(false);
    }
  }

  const decisions = s?.decisions ?? [];
  const picked = Object.keys(chosen).length;
  const long = reply.length > LONG_REPLY_CHARS;
  const artifacts = s?.outcome.artifacts ?? [];
  const linked = artifacts.filter((a) => safeLinkUrl(a.url));
  const plain = artifacts.filter((a) => !safeLinkUrl(a.url));
  const activity = turn?.toolCalls !== undefined ? `tool ${turn.toolCalls} 回` : undefined;
  const trimmed = draft.trim();

  return (
    <div>
      <div className="px-4 pb-3">
        {turn?.request ? (
          <p className="text-xs text-ink-3">
            {s ? "頼んだこと：" : "あなたの発言："}
            <span data-testid="inbox-turn-request" className="text-ink-2">
              {turn.request}
            </span>
          </p>
        ) : null}

        {s ? (
          <div className="mt-2.5">
            <p data-testid="inbox-turn-headline" className="text-lg leading-snug font-medium text-foreground">
              {s.outcome.headline}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span data-testid="inbox-turn-status" className={cn("font-medium", STATUS[s.outcome.status].cls)}>
                {STATUS[s.outcome.status].label}
              </span>
              {activity ? (
                <span data-testid="inbox-turn-activity" className="text-ink-3">
                  {activity}
                </span>
              ) : null}
              {plain.map((a, i) => (
                <span key={i} data-testid="inbox-turn-artifact" className="flex items-center gap-1 text-ink-2">
                  <Package className="size-3 text-ink-3" />
                  {a.label} <span className="font-mono text-xs">{a.detail}</span>
                </span>
              ))}
            </div>
            {/* 開いて見られるもの（モック・公開した URL）は、押せる形で頭に出す */}
            {linked.length > 0 ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {linked.map((a, i) => (
                  <a
                    key={i}
                    href={safeLinkUrl(a.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="inbox-turn-artifact-link"
                    className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs text-foreground hover:bg-accent"
                  >
                    <ExternalLink className="size-3.5 text-ink-3" />
                    {a.label}
                  </a>
                ))}
              </div>
            ) : null}
            {s.outcome.points.length > 0 || (s.outcome.notVerified?.length ?? 0) > 0 ? (
              <ul className="mt-2.5 space-y-1 text-md">
                {s.outcome.points.map((p, i) => (
                  <li key={`p${i}`} data-testid="inbox-turn-point" className="flex gap-2 text-ink-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                    {p}
                  </li>
                ))}
                {(s.outcome.notVerified ?? []).map((p, i) => (
                  <li key={`n${i}`} data-testid="inbox-turn-not-verified" className="flex gap-2 text-ink-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    <span>
                      <span className="text-warn">確かめていない：</span>
                      {p}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {cut ? (
          <p data-testid="inbox-turn-cut" className="mt-2.5 flex items-center gap-1.5 text-sm font-medium text-warn">
            <AlertTriangle className="size-4" />
            {cut}
          </p>
        ) : null}

        {/* 自動化の回：後の回で置き換えなかったカードに、この会話でまだ見ていない回の数を添える（アーキ仕様 §4.3「受信箱」） */}
        {(item.unseenRuns ?? 0) > 1 ? (
          <p data-testid="inbox-unseen-runs" className="mt-2.5 text-xs text-ink-2">
            この会話には、まだ見ていない回が {item.unseenRuns} 回あります
          </p>
        ) : null}

        {/* AI の最後の返事。まとめがあるときは畳んでおき、無いときは本文そのものが主役 */}
        {!s ? (
          <p className="mt-2.5 flex items-center gap-2 text-xs text-ink-3">
            <span>AI の最後の返事</span>
            {activity ? <span data-testid="inbox-turn-activity">・{activity}</span> : null}
            <span className="rounded bg-surface-2 px-1.5 py-0.5">まとめなし</span>
          </p>
        ) : null}
        {reply !== "" ? (
          <div className={cn(s ? "mt-3 border-t border-border pt-3" : "mt-1.5")}>
            {s ? (
              <button
                type="button"
                data-testid="inbox-turn-reply-toggle"
                onClick={() => setExpanded((v) => !v)}
                className="text-xs text-ink-3 hover:text-foreground"
              >
                {expanded ? "AI の返事を畳む" : "AI の返事を読む"}
              </button>
            ) : null}
            {!s || expanded ? (
              <div data-testid="inbox-turn-reply" className={cn("relative text-md leading-relaxed text-foreground", s ? "mt-2" : "")}>
                <div className={cn(!s && !expanded && long ? "max-h-40 overflow-hidden" : "")}>
                  {/* 会話と同じ Markdown の部品で描く（リンクは別タブ、§6.25） */}
                  <TextMessagePartProvider text={reply}>
                    <MarkdownText />
                  </TextMessagePartProvider>
                </div>
                {!s && long && !expanded ? (
                  <button
                    type="button"
                    data-testid="inbox-turn-reply-more"
                    onClick={() => setExpanded(true)}
                    className="absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-card to-transparent text-xs text-ink-2"
                  >
                    続きを読む
                  </button>
                ) : null}
                {turn?.replyTruncated && (expanded || !long) ? (
                  <p className="mt-1 text-xs text-ink-3">長いので途中までです。続きは会話を開いて読んでください</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : !s && !cut ? (
          <p className="mt-1.5 text-xs text-ink-3">返事は記録されていません</p>
        ) : null}

        <JudgeNote judge={judge} carried={item.carriedJudge} watching={item.judgeWatching} />

        {decisions.length > 0 ? (
          <div className="mt-3 space-y-2.5">
            {decisions.map((d, i) => (
              <div key={i} data-testid="inbox-turn-decision" className="rounded-lg border-l-2 border-turn bg-turn-soft/50 px-3 py-2.5">
                <p className="text-md font-medium text-foreground">{d.question}</p>
                {d.context ? <p className="mt-0.5 text-xs text-ink-2">{d.context}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {d.options.map((o, oi) => {
                    const on = chosen[i] === o.reply;
                    const url = safeLinkUrl(o.url);
                    const byJudge = judgeChoice.get(i)?.choice === oi;
                    return (
                      <span key={oi} className="flex items-stretch">
                        <button
                          type="button"
                          data-testid="inbox-turn-option"
                          aria-pressed={on}
                          data-judge-choice={byJudge ? "" : undefined}
                          onClick={() => pick(i, oi, o.reply, o.label)}
                          title={o.reply}
                          className={cn(
                            "flex h-7 items-center gap-1 border px-3 text-xs",
                            url ? "rounded-l-full" : "rounded-full",
                            on
                              ? "border-turn bg-turn text-on-color"
                              : "border-border bg-card text-foreground hover:border-turn/60",
                          )}
                        >
                          {on ? <Check className="size-3" /> : null}
                          {o.label}
                          {o.recommended && !on ? <span className="text-xs text-turn">おすすめ</span> : null}
                          {byJudge && !on ? (
                            <span data-testid="inbox-turn-option-judge" className="text-xs text-primary">
                              判断役が選択
                            </span>
                          ) : null}
                        </button>
                        {/* その選択肢の中身（モック等）を開いて見る——選ぶ前に見比べられるように */}
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="inbox-turn-option-link"
                            aria-label={`${o.label} を開いて見る`}
                            className={cn(
                              "flex h-7 items-center gap-1 rounded-r-full border border-l-0 px-2.5 text-xs",
                              on
                                ? "border-turn bg-turn/85 text-on-color"
                                : "border-border bg-card text-ink-2 hover:bg-accent hover:text-foreground",
                            )}
                          >
                            見る
                            <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
                {confirming?.index === i ? (
                  <div data-testid="inbox-judge-confirm" className="mt-2 rounded-md border border-warn/40 bg-card px-3 py-2 text-xs">
                    <p className="text-foreground" data-testid="inbox-judge-confirm-text">
                      判断役は「{judgeChoice.get(i)?.label}」を選び、AI はもう進めています。「{confirming.label}」に変えますか
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        data-testid="inbox-judge-confirm-change"
                        onClick={() => {
                          setConfirming(null);
                          choose(i, confirming.reply);
                        }}
                        className="h-7 rounded-md border border-border px-3 text-foreground hover:bg-accent"
                      >
                        変える
                      </button>
                      <button
                        type="button"
                        data-testid="inbox-judge-confirm-cancel"
                        onClick={() => setConfirming(null)}
                        className="h-7 rounded-md px-3 text-ink-2 hover:bg-accent"
                      >
                        やめる
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* 返信の欄。Enter で送る（Shift+Enter で改行）——会話の入力欄と同じ。キーボードの出る端末は Enter で改行（§6.0） */}
      <div className="border-t border-border bg-surface-2/40 px-3 py-2.5">
        {s?.nextSuggestions && s.nextSuggestions.length > 0 && draft === "" ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {s.nextSuggestions.map((n, i) => (
              <button
                key={i}
                type="button"
                data-testid="inbox-turn-suggestion"
                onClick={() => suggest(n.reply)}
                className="h-7 rounded-full border border-border bg-card px-3 text-xs text-ink-2 hover:text-foreground"
              >
                {n.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={textRef}
            value={draft}
            data-testid="inbox-reply-input"
            aria-label="この会話に返信する"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || touchKeyboard) return;
              e.preventDefault();
              void send(trimmed);
            }}
            rows={1}
            placeholder={
              cut ? "続けるなら「続けて」と送る" : decisions.length > 0 ? "選択肢を押すか、返事を書く" : "この会話に返信する"
            }
            className="min-h-9 flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-ink-3 focus:border-ink-3/60"
          />
          {trimmed === "" ? (
            <button
              type="button"
              data-testid={cut ? "inbox-reply-continue" : "inbox-reply-seen"}
              disabled={busy}
              onClick={() => void (cut ? send("続けて") : seen())}
              className="h-9 shrink-0 rounded-lg px-3 text-xs text-ink-2 hover:bg-accent disabled:opacity-50"
            >
              {cut ? "続ける" : "見た"}
            </button>
          ) : (
            <Button
              type="button"
              data-testid="inbox-reply-send"
              disabled={busy}
              onClick={() => void send(trimmed)}
              className="h-9 shrink-0 gap-1.5 rounded-lg px-3 text-xs"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              送る
              <CornerDownLeft className="size-3.5 opacity-70" />
            </Button>
          )}
        </div>
        {decisions.length > 1 && picked > 0 && picked < decisions.length ? (
          <p className="mt-1.5 text-xs text-turn">まだ決めていない問いが {decisions.length - picked} つあります</p>
        ) : null}
        {error ? (
          <p data-testid="inbox-reply-error" className="mt-1.5 text-xs text-stop">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * **判断役がこのカードの決めることをどうしたか**（アーキ仕様 §4.3「banto.turn-decisions と判断役」の「受信箱」）。答えていない
 * 間は「見ています」（host が走っている回から添える）、答えたら決めた・任せた・揃わなかった。前のカードで決めて進んだ分は
 * 引き継いで出す
 */
function JudgeNote({
  judge,
  carried,
  watching,
}: {
  judge: RealReviewJudge | undefined;
  carried: RealReviewJudge | undefined;
  watching: { id: string; name: string } | undefined;
}) {
  if (!judge && !carried && !watching) return null;
  const answers = (j: RealReviewJudge) => j.answers ?? [];
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      {carried?.kind === "decided-by-automation" ? (
        <p data-testid="inbox-judge-carried" className="flex items-start gap-1.5 text-ink-2">
          <CheckCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            前のターンで、判断役（自動化「{carried.automation.name}」）が
            {answers(carried)
              .map((a) => `「${a.label}」を選んで進めました（${a.reason}）`)
              .join("。")}
          </span>
        </p>
      ) : null}
      {watching && !judge ? (
        <p data-testid="inbox-judge-watching" className="flex items-center gap-1.5 text-ink-2">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
          判断役が見ています（自動化「{watching.name}」）
        </p>
      ) : null}
      {judge?.kind === "decided-by-automation" ? (
        <div data-testid="inbox-judge" data-kind={judge.kind} className="rounded-md bg-surface-2 px-3 py-2">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <CheckCheck className="size-4 shrink-0 text-primary" />
            判断役（自動化「{judge.automation.name}」）が決めました
          </p>
          <ul className="mt-1 space-y-0.5 text-ink-2">
            {answers(judge).map((a) => (
              <li key={a.question} data-testid="inbox-judge-answer">
                「{a.label}」——{a.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-3">元の会話の AI は、この答えで進めています。</p>
        </div>
      ) : judge?.kind === "deferred" ? (
        <p data-testid="inbox-judge" data-kind={judge.kind} className="flex items-start gap-1.5 text-ink-2">
          <Hand className="mt-0.5 size-4 shrink-0 text-turn" />
          <span>
            判断役（自動化「{judge.automation.name}」）は人に任せました：{judge.reason}
          </span>
        </p>
      ) : judge?.kind === "incomplete" ? (
        <p data-testid="inbox-judge" data-kind={judge.kind} className="flex items-start gap-1.5 text-ink-2">
          <Hand className="mt-0.5 size-4 shrink-0 text-turn" />
          <span>
            判断役（自動化「{judge.automation.name}」）は {judge.total} 問中 {judge.answered} 問しか答えずに終わりました。あなたが決めてください
          </span>
        </p>
      ) : null}
    </div>
  );
}

// ── 直してほしいこと（お知らせ）────────────────────────────────────

function NoticeBody({ item, onSeen }: { item: RealInboxNotice; onSeen: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  /** 押して返事を待っている間は効かなくする。続けて押されたときは描き直す前なので、確かめは ref で行う */
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** 「続ける」を断られた理由 */
  const [resumeError, setResumeError] = useState<string | null>(null);
  function hold(): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }
  function release() {
    busyRef.current = false;
    setBusy(false);
  }
  return (
    <div className="px-4 pb-4">
      <p data-testid="inbox-notice-title" className="text-sm font-medium text-foreground">
        {item.title}
      </p>
      <p className="mt-1 text-sm text-ink-2">{item.detail}</p>
      {item.runtimeKey ? <RuntimeKeyNotice runtimeKey={item.runtimeKey} /> : null}
      {resumeError ? (
        <p data-testid="inbox-notice-resume-error" className="mt-1 text-xs text-stop">
          続けられませんでした：{resumeError}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-xs text-stop">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-testid="inbox-notice-seen"
          disabled={busy}
          onClick={() => {
            // **見たことにする**——直したかどうかは host が次に繋ぐときに分かる（宣言が変われば、また試す）
            if (!hold()) return;
            void onSeen().catch((err: unknown) => {
              setError(`「見た」にできませんでした：${errorText(err)}`);
              release();
            });
          }}
          className="h-8 rounded-md px-3 text-xs text-ink-2 hover:bg-accent disabled:opacity-50"
        >
          見た
        </button>
        {item.resume ? (
          <button
            type="button"
            data-testid="inbox-notice-resume"
            disabled={busy}
            onClick={() => {
              // **自動で続けるのをやめたターンを続ける**（§2.5「上限」）。断られたら理由を出す（規則2）。二重に頼まない
              // （host も同じお知らせを同時には続けない）
              if (!hold()) return;
              void resumeRealNoticeTurn(item.id)
                .then(() => setResumeError(null))
                .catch((err: unknown) => setResumeError(errorText(err)))
                .finally(() => {
                  release();
                  void refreshRealInbox();
                });
            }}
            className="flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          >
            続ける
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * **実行場所の SSH 鍵が置き場の外にある**（追加・2026-10-17、Backlog 375 番）。移せるなら注意と「移す」（Vault の管理画面の
 * 「移す」と同じ操作）。移すと host がカードを閉じてすぐ繋ぎ直す——閉じたことは受信箱の取り直しで見える。移せないなら
 * 理由（本文）と入口だけ
 */
function RuntimeKeyNotice({ runtimeKey }: { runtimeKey: NonNullable<RealInboxNotice["runtimeKey"]> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 移せたが繋ぎ直せなかった理由（移したことは取り消さない） */
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const projectId = runtimeKey.projectIds[0];
  return (
    <div className="mt-2 flex flex-col gap-2 text-xs" data-testid="inbox-runtime-key" data-runtime={runtimeKey.runtime}>
      {runtimeKey.from ? (
        <>
          <p className="rounded-md bg-warn-soft px-3 py-2 text-ink-2" data-testid="inbox-runtime-key-caution">
            移すと、この鍵は Project の AI から使えなくなります（今そのグループ「{runtimeKey.from.group}」の鍵として使っているもの——例えば
            Backlog の push の鍵——も使えなくなります）。Project の AI にも使わせたいなら、移す前に同じ値を別の名前でその Project の置き場に預け直してください。
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={busy}
              data-testid="inbox-runtime-key-move"
              onClick={() => {
                setBusy(true);
                setError(null);
                void moveRealRuntimeKey(runtimeKey.runtime)
                  .then((r) => setReconnectError(r.reconnectError ?? null))
                  .catch((err: unknown) => setError(errorText(err)))
                  .finally(() => {
                    setBusy(false);
                    void refreshRealInbox();
                  });
              }}
            >
              {busy ? "移しています…" : `「${runtimeKey.alias}」を実行場所の鍵の置き場へ移す`}
            </Button>
          </div>
        </>
      ) : null}
      {error ? (
        <p className="text-stop" data-testid="inbox-runtime-key-error">
          移せませんでした：{error}
        </p>
      ) : null}
      {reconnectError ? (
        <p className="text-stop" data-testid="inbox-runtime-key-reconnect-error">
          移しましたが、繋ぎ直せませんでした：{reconnectError}
        </p>
      ) : null}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-ink-3">
        {projectId ? (
          <Link
            href={`/p/${projectId}?${new URLSearchParams({ canvas: VAULT_MANAGE_CANVAS }).toString()}`}
            className="underline underline-offset-2 hover:text-foreground"
            data-testid="inbox-runtime-key-vault"
          >
            Vault の管理画面を開く
          </Link>
        ) : (
          <span data-testid="inbox-runtime-key-vault">Vault の管理画面はコマンドパレットの「Vault を管理」から開けます</span>
        )}
        <Link href="/settings?section=runtimes" className="underline underline-offset-2 hover:text-foreground" data-testid="inbox-runtime-key-settings">
          実行場所の設定を開く
        </Link>
      </p>
    </div>
  );
}

/** Vault の管理画面（vault-directory の入口の画面。`packages/modules/vault-directory/src/manage-app.ts` の `MANAGE_APP_URI`） */
const VAULT_MANAGE_CANVAS = "vault-directory:ui://banto-vault-directory/manage";

// ── 送った・答えたあと ─────────────────────────────────────────────

function SettledBody({ outcome, card }: { outcome: Outcome; card: Card }) {
  return (
    <div data-testid="inbox-settled" className="px-4 pb-4">
      {outcome.kind === "sent" ? (
        <>
          <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
            {outcome.text}
          </p>
          <p data-testid="inbox-sent" className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">
            <Loader2 className="size-3.5 animate-spin" />
            送りました。AI が動いています——返ってきたら、またここに出ます
          </p>
        </>
      ) : outcome.kind === "answered" ? (
        <p data-testid="inbox-answered" className="flex items-center gap-1.5 text-sm text-ink-2">
          <CheckCheck className="size-4 text-ok" />「{outcome.choice}」と答えました。{card.kind === "judgment" ? "AI が続きをやります" : ""}
        </p>
      ) : (
        <p className="text-xs text-ink-3">見たにしました</p>
      )}
    </div>
  );
}
