"use client";

// 受信箱の見直し（決定・2026-10-15、ユーザー。同日改訂「受信箱を見るだけで開発を進められるように」）。
//
// 会話と同じく前面に全面で出し、**1件ずつをカードとしてその場で読めて答えられる**ようにする：
// - 判断待ち：何を承認するのか（コマンド・引数）を見せ、その場で答える
// - 返ってきた会話：人が頼んだこと・AI の最後の返事・まとめ（分かったこと・確かめていないこと・できたもの）を
//   読み、決めることの選択肢を押すと返信の欄に入る。返信を送ると AI が動き出し、カードは一覧から外れる
// - 直してほしいこと：直し方と行き先
// 会話を開く口はカードの右上に残す（詳しく見たいとき）。
//
// キー操作：j / k で次・前のカード、r で返信の欄へ、e で「見た」、o で会話を開く、Esc で閉じる。
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { getProject } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  dismissFeedItem,
  getFeedItems,
  sectionOf,
  threadHref,
  type FeedItem,
  type FeedJudgment,
  type FeedReturned,
  type FeedSection,
} from "@/lib/mock/inbox-feed";
import { cn } from "@/lib/utils";

const SECTIONS: { key: FeedSection; label: string }[] = [
  { key: "judgment", label: "あなたの判断を待っています" },
  { key: "decide", label: "決めることがあります" },
  { key: "returned", label: "返ってきた会話" },
  { key: "fix", label: "直してほしいこと" },
];

/** 送った・答えたあと、カードを畳んで一覧から外すまでの間 */
const LEAVE_AFTER_MS = 2600;

type Outcome = { kind: "sent"; text: string } | { kind: "answered"; choice: string } | { kind: "seen" };

export function InboxPage({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  useMockStoreVersion();
  const isMobile = useIsMobile();
  const items = [...getFeedItems()].sort((a, b) => a.ageMin - b.ageMin);
  const ordered = SECTIONS.flatMap((s) => items.filter((i) => sectionOf(i) === s.key));
  const [focusedId, setFocusedId] = useState<string | null>(ordered[0]?.id ?? null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const cardRefs = useRef(new Map<string, HTMLElement>());

  function settle(id: string, outcome: Outcome) {
    setOutcomes((o) => ({ ...o, [id]: outcome }));
    // 次のカードへ進む（上から順に片づけられるように）
    const at = ordered.findIndex((i) => i.id === id);
    const next = ordered.slice(at + 1).find((i) => !outcomes[i.id]) ?? ordered.slice(0, at).find((i) => !outcomes[i.id]);
    if (next) focus(next.id);
    window.setTimeout(() => dismissFeedItem(id), outcome.kind === "seen" ? 300 : LEAVE_AFTER_MS);
  }

  function focus(id: string, scroll = true) {
    setFocusedId(id);
    if (scroll) cardRefs.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
      if (e.key === "Escape") {
        if (typing) (target as HTMLElement).blur();
        else onClose();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = ordered.findIndex((i) => i.id === focusedId);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))];
        if (next) focus(next.id);
      } else if (e.key === "r" && focusedId) {
        e.preventDefault();
        cardRefs.current.get(focusedId)?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      } else if (e.key === "e" && focusedId) {
        const item = ordered[at];
        if (item && item.kind !== "judgment") settle(item.id, { kind: "seen" });
      } else if (e.key === "o" && focusedId) {
        cardRefs.current.get(focusedId)?.querySelector<HTMLAnchorElement>("a[data-open-thread]")?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const remaining = ordered.filter((i) => !outcomes[i.id]).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="inbox-page">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
        {isMobile ? <MobileNavDrawer projectId={projectId} /> : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          受信箱
          <span className="ml-2 text-xs font-normal tabular-nums text-ink-3">{remaining} 件</span>
        </p>
        <span className="hidden items-center gap-2 text-[11px] text-ink-3 lg:flex">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>移る
          <Kbd>r</Kbd>返信
          <Kbd>e</Kbd>見た
          <Kbd>o</Kbd>会話を開く
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="受信箱を閉じる"
          className="ml-2 flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-8"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-2 pb-24 pt-3 md:px-6 md:pt-6">
          {ordered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <CircleCheck className="size-8 text-ok" />
              <p className="text-sm text-foreground">あなたの番のものはありません</p>
              <p className="text-xs text-ink-3">AI が返してきたら、ここに出ます</p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const rows = ordered.filter((i) => sectionOf(i) === section.key);
              if (rows.length === 0) return null;
              const urgent = section.key === "judgment" || section.key === "decide";
              return (
                <section key={section.key} className="mb-8">
                  <h2 className="mb-2 flex items-baseline gap-2 px-1">
                    <span className={cn("text-[13px] font-semibold", urgent ? "text-turn" : "text-foreground")}>
                      {section.label}
                    </span>
                    <span className="text-xs tabular-nums text-ink-3">{rows.length}</span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {rows.map((item) => (
                      <article
                        key={item.id}
                        ref={(el) => {
                          if (el) cardRefs.current.set(item.id, el);
                          else cardRefs.current.delete(item.id);
                        }}
                        onFocusCapture={() => focus(item.id, false)}
                        onMouseDown={() => focus(item.id, false)}
                        data-testid={`inbox-card-${item.id}`}
                        className={cn(
                          "overflow-hidden rounded-xl border bg-card transition-[opacity,box-shadow,border-color] duration-300",
                          focusedId === item.id ? "border-ink-3/40 shadow-[var(--banto-sh-2)]" : "border-border",
                          outcomes[item.id] ? "opacity-70" : "",
                        )}
                      >
                        <CardHead item={item} />
                        {outcomes[item.id] ? (
                          <SettledBody outcome={outcomes[item.id]!} item={item} />
                        ) : item.kind === "judgment" ? (
                          <JudgmentBody item={item} onAnswer={(choice) => settle(item.id, { kind: "answered", choice })} />
                        ) : item.kind === "returned" ? (
                          <ReturnedBody
                            item={item}
                            onSend={(text) => settle(item.id, { kind: "sent", text })}
                            onSeen={() => settle(item.id, { kind: "seen" })}
                          />
                        ) : (
                          <div className="px-4 pb-4">
                            <p className="text-sm font-medium text-foreground">{item.title}</p>
                            <p className="mt-1 text-sm text-ink-2">
                              <Inline text={item.detail} />
                            </p>
                            <div className="mt-3 flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => settle(item.id, { kind: "seen" })}
                                className="h-8 rounded-md px-3 text-xs text-ink-2 hover:bg-accent"
                              >
                                直した
                              </button>
                              <Link
                                href={item.href}
                                className="flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent"
                              >
                                {item.actionLabel}
                                <ArrowUpRight className="size-3.5" />
                              </Link>
                            </div>
                          </div>
                        )}
                      </article>
                    ))}
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
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-[10px] text-ink-2">
      {children}
    </kbd>
  );
}

// ── カードの頭：どこの会話か・印・何分前・会話を開く ─────────────────────────

function CardHead({ item }: { item: FeedItem }) {
  const project = item.projectId ? getProject(item.projectId) : undefined;
  const thread = item.threadId ? getThread(item.threadId) : undefined;
  const threadName = thread ? (thread.kind === "base" ? "Base Thread" : thread.title) : null;
  return (
    <div className="flex items-center gap-2.5 px-4 pb-2 pt-3">
      <Mark item={item} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-ink-2">
        <span className="shrink-0 font-medium text-foreground">{project ? project.name : "banto 全体"}</span>
        {threadName ? (
          <>
            <span aria-hidden className="text-ink-3">
              /
            </span>
            {thread?.kind === "fork" ? <GitFork className="size-3 shrink-0 text-ink-3" /> : null}
            <span className="truncate">{threadName}</span>
          </>
        ) : null}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-ink-3">{item.age}</span>
      {item.kind !== "fix" ? (
        <Link
          href={threadHref(item)}
          data-open-thread
          onClick={() => dismissFeedItem(item.id)}
          className="-mr-1.5 flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 hover:bg-accent hover:text-foreground"
          aria-label="会話を開く"
        >
          <span className="hidden sm:inline">会話を開く</span>
          <ArrowUpRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

function Mark({ item }: { item: FeedItem }) {
  const base = "flex size-6 shrink-0 items-center justify-center rounded-full";
  if (item.kind === "judgment")
    return (
      <span className={cn(base, "bg-turn-soft text-turn")}>
        <Hand className="size-3.5" />
      </span>
    );
  if (item.kind === "fix")
    return (
      <span className={cn(base, "bg-warn-soft text-warn")}>
        <Wrench className="size-3.5" />
      </span>
    );
  if ((item.summary?.decisions.length ?? 0) > 0)
    return (
      <span className={cn(base, "bg-turn-soft text-turn")}>
        <MessageSquareReply className="size-3.5" />
      </span>
    );
  if (item.interrupted || item.summary?.status === "failed")
    return (
      <span className={cn(base, "bg-warn-soft text-warn")}>
        <CircleX className="size-3.5" />
      </span>
    );
  if (item.summary?.status === "partial")
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

function JudgmentBody({ item, onAnswer }: { item: FeedJudgment; onAnswer: (choice: string) => void }) {
  return (
    <div className="px-4 pb-4">
      <p className="text-sm text-foreground">
        <span className="font-medium text-turn">{item.from}</span>　{item.message}
      </p>
      {item.detail ? (
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
          {item.detail.map((d) => (
            <Fragment key={d.label}>
              <dt className="text-ink-3">{d.label}</dt>
              <dd className="min-w-0 break-all font-mono text-foreground">{d.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {item.choices.map((c, i) => (
          <button
            key={c}
            type="button"
            onClick={() => onAnswer(c)}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium",
              i === 0
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "border border-border text-foreground hover:bg-accent",
            )}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 返ってきた会話：読んで、決めて、返信する ─────────────────────────────

const STATUS = {
  done: { label: "終わった", cls: "text-ok" },
  partial: { label: "途中まで", cls: "text-ink-2" },
  failed: { label: "できなかった", cls: "text-warn" },
} as const;

function ReturnedBody({
  item,
  onSend,
  onSeen,
}: {
  item: FeedReturned;
  onSend: (text: string) => void;
  onSeen: () => void;
}) {
  const s = item.summary;
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  function choose(index: number, reply: string) {
    const next = { ...chosen, [index]: reply };
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

  function suggest(reply: string) {
    setDraft(reply);
    requestAnimationFrame(() => textRef.current?.focus());
  }

  const allDecided = (s?.decisions.length ?? 0) === Object.keys(chosen).length;
  const long = item.reply.length > 220;

  return (
    <div>
      <div className="px-4 pb-3">
        <p className="text-xs text-ink-3">
          {s ? "頼んだこと：" : "あなたの発言："}
          <span className="text-ink-2">{item.request}</span>
        </p>

        {s ? (
          <div className="mt-2.5">
            <p className="text-[15px] font-medium leading-snug text-foreground">{s.headline}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className={cn("font-medium", STATUS[s.status].cls)}>{STATUS[s.status].label}</span>
              {item.activity ? <span className="text-ink-3">{item.activity}</span> : null}
              {s.artifacts
                ?.filter((a) => !a.href)
                .map((a) => (
                  <span key={a.detail} className="flex items-center gap-1 text-ink-2">
                    <Package className="size-3 text-ink-3" />
                    {a.label} <span className="font-mono text-[11px]">{a.detail}</span>
                  </span>
                ))}
            </div>
            {/* 開いて見られるもの（モック・公開した URL）は、押せる形で頭に出す */}
            {s.artifacts?.some((a) => a.href) ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {s.artifacts
                  .filter((a) => a.href)
                  .map((a) => (
                    <a
                      key={a.href}
                      href={a.href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs text-foreground hover:border-accent-foreground/30 hover:bg-accent"
                    >
                      <ExternalLink className="size-3.5 text-ink-3" />
                      {a.label}
                    </a>
                  ))}
              </div>
            ) : null}
            {s.points.length > 0 || s.notVerified.length > 0 ? (
              <ul className="mt-2.5 space-y-1 text-[13px]">
                {s.points.map((p) => (
                  <li key={p} className="flex gap-2 text-ink-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                    {p}
                  </li>
                ))}
                {s.notVerified.map((p) => (
                  <li key={p} className="flex gap-2 text-ink-2">
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
        ) : item.interrupted ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-sm font-medium text-warn">
            <AlertTriangle className="size-4" />
            {item.interrupted}
          </p>
        ) : null}

        {/* AI の最後の返事。まとめがあるときは畳んでおき、無いときは本文そのものが主役 */}
        {!s && !item.interrupted ? (
          <p className="mt-2.5 flex items-center gap-2 text-[11px] text-ink-3">
            <span>AI の最後の返事</span>
            {item.activity ? <span>・{item.activity}</span> : null}
            <span className="rounded bg-surface-2 px-1.5 py-0.5">まとめなし</span>
          </p>
        ) : null}
        <div className={cn(s ? "mt-3 border-t border-border pt-3" : "mt-1.5")}>
          {s ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-ink-3 hover:text-foreground"
            >
              {expanded ? "AI の返事を畳む" : "AI の返事を読む"}
            </button>
          ) : null}
          {!s || expanded ? (
            <div className={cn("relative text-[13.5px] leading-relaxed text-foreground", s ? "mt-2" : "")}>
              <div className={cn(!expanded && long ? "max-h-40 overflow-hidden" : "")}>
                <Markdownish text={item.reply} />
              </div>
              {!s && long && !expanded ? (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-card to-transparent text-xs text-ink-2"
                >
                  続きを読む
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {s && s.decisions.length > 0 ? (
          <div className="mt-3 space-y-2.5">
            {s.decisions.map((d, i) => (
              <div key={d.question} className="rounded-lg border-l-2 border-turn bg-turn-soft/50 px-3 py-2.5">
                <p className="text-[13px] font-medium text-foreground">{d.question}</p>
                {d.context ? <p className="mt-0.5 text-xs text-ink-2">{d.context}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {d.options.map((o) => {
                    const on = chosen[i] === o.reply;
                    return (
                      <span key={o.label} className="flex items-stretch">
                        <button
                          type="button"
                          onClick={() => choose(i, o.reply)}
                          title={o.reply}
                          className={cn(
                            "flex h-7 items-center gap-1 border px-3 text-xs",
                            o.href ? "rounded-l-full" : "rounded-full",
                            on
                              ? "border-turn bg-turn text-[var(--banto-on-color)]"
                              : "border-border bg-card text-foreground hover:border-turn/60",
                          )}
                        >
                          {on ? <Check className="size-3" /> : null}
                          {o.label}
                          {o.recommended && !on ? <span className="text-[10px] text-turn">おすすめ</span> : null}
                        </button>
                        {/* その選択肢の中身（モック等）を開いて見る——選ぶ前に見比べられるように */}
                        {o.href ? (
                          <a
                            href={o.href}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`${o.label} を開いて見る`}
                            className={cn(
                              "flex h-7 items-center gap-1 rounded-r-full border border-l-0 px-2.5 text-[11px]",
                              on
                                ? "border-turn bg-turn/85 text-[var(--banto-on-color)]"
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
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* 返信の欄。Enter で送る（Shift+Enter で改行）——会話の入力欄と同じ */}
      <div className="border-t border-border bg-surface-2/40 px-3 py-2.5">
        {s?.nextSuggestions && s.nextSuggestions.length > 0 && draft === "" ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {s.nextSuggestions.map((n) => (
              <button
                key={n.label}
                type="button"
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
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && draft.trim() !== "") {
                e.preventDefault();
                onSend(draft.trim());
              }
            }}
            rows={draft.includes("\n") ? 3 : 1}
            placeholder={
              item.interrupted
                ? "続けるなら「続けて」と送る"
                : s && s.decisions.length > 0
                  ? "選択肢を押すか、返事を書く"
                  : "この会話に返信する"
            }
            className="min-h-9 flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-ink-3 focus:border-ink-3/60"
          />
          {draft.trim() === "" ? (
            <button
              type="button"
              onClick={item.interrupted ? () => onSend("続けて") : onSeen}
              className="h-9 shrink-0 rounded-lg px-3 text-xs text-ink-2 hover:bg-accent"
            >
              {item.interrupted ? "続ける" : "見た"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSend(draft.trim())}
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium",
                "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              送る
              <CornerDownLeft className="size-3.5 opacity-70" />
            </button>
          )}
        </div>
        {s && s.decisions.length > 1 && !allDecided && Object.keys(chosen).length > 0 ? (
          <p className="mt-1.5 text-[11px] text-turn">
            まだ決めていない問いが {s.decisions.length - Object.keys(chosen).length} つあります
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ── 送った・答えたあと ─────────────────────────────────────────────

function SettledBody({ outcome, item }: { outcome: Outcome; item: FeedItem }) {
  return (
    <div className="px-4 pb-4">
      {outcome.kind === "sent" ? (
        <>
          <p className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-foreground">
            {outcome.text}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">
            <Loader2 className="size-3.5 animate-spin" />
            送りました。AI が動いています——返ってきたら、またここに出ます
          </p>
        </>
      ) : outcome.kind === "answered" ? (
        <p className="flex items-center gap-1.5 text-sm text-ink-2">
          <CheckCheck className="size-4 text-ok" />
          「{outcome.choice}」と答えました。{item.kind === "judgment" ? "AI が続きをやります" : ""}
        </p>
      ) : (
        <p className="text-xs text-ink-3">見たにしました</p>
      )}
    </div>
  );
}

// ── 小さな Markdown（モック用：段落・箇条書き・太字・コード） ───────────────

function Markdownish({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- "))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l) => (
                <li key={l}>
                  <Inline text={l.slice(2)} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Inline text={b} />
          </p>
        );
      })}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s）、。]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") ? (
          <strong key={i} className="font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noreferrer"
            className="break-all text-[var(--banto-accent)] underline decoration-[var(--banto-accent)]/40 underline-offset-2 hover:decoration-[var(--banto-accent)]"
          >
            {p}
          </a>
        ) : p.startsWith("`") ? (
          <code key={i} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
