"use client";

// 受信箱の中身（実データ、§2.4）。Stage 4・決定・2026-09-05。
//
// 並びは止まっているものが先——判断待ち → お知らせ → **レビュー待ち**（ターンが終わった Thread、
// 決定・2026-09-27）。
//
// 行を押せば**その Thread を開く**。**Module 間中継の承認だけは、ここでも答えられる**（改訂・2026-10-05、
// ユーザー指示）——以前は答える口を Thread 側のカード1箇所にしていた（§2.4.1、決定・2026-09-06）が、中継のカードは
// 走っているターンの流れの中にしか描かれず、会話を開いてもカードが見つからないと答える手段が無かった。答え方は
// 会話のカードと同じ部品（`ElicitationFormView`）、送る道も同じ（`answerRealJudgment`）——答えれば会話のカードも
// 答え済みになる（host がターンの流れと `judgment.answered` の両方で知らせる）

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCheck, CircleCheck, FolderGit2, PlugZap } from "lucide-react";
import {
  getRealJudgments,
  getRealNotices,
  getRealReviews,
  refreshRealInbox,
  useRealInboxVersion,
} from "@/lib/backend/real-inbox";
import { acknowledgeRealNotice, resumeRealNoticeTurn } from "@/lib/backend/client";
import { answerRealJudgment } from "@/lib/backend/adapter";
import { ElicitationFormView } from "./elicitation-form";
import { getThread } from "@/lib/mock/threads";
import { getProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { useRovingFocus } from "@/hooks/use-roving-focus";

/** 「3分前」のような相対表記。厳密さより読みやすさ——判断待ちは
 *  「どれくらい待たせているか」だけ分かればよい（§2.4）。 */
function age(createdAt: string, now: number): string {
  const diffSec = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 1000));
  if (diffSec < 60) return "たった今";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.round(hour / 24)}日前`;
}

// 行を押すとその Thread へ移動する。**閉じる操作を別に呼ばない**——受信箱の
// 開閉はURL（`?overlay=inbox`）が持っているので、遷移すれば閉じる。両方やると
// 同じtickで2回 router.push することになり、どちらが勝つかで開いたままになる
// （実測・2026-09-05）。機構は1つに保つ。
export function RealInboxList() {
  useRealInboxVersion();
  // Thread/Project の名前は mock ストア側の登録から引く（hydrateRealProjects が
  // 実Threadを登録している）——受信箱が自分の索引を持たない（規則3）
  useMockStoreVersion();
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();

  // 開いたときに取り直す（別のブラウザが走らせたターンの分もここで入る）
  useEffect(() => {
    void refreshRealInbox();
  }, []);

  // 「いま」はレンダー中に読まない（React の純粋性——同じレンダーで値が
  // 変わる）。表示のためだけの値なので、一定間隔で state に取り込む
  const [now, setNow] = useState(() => Date.now());
  /** 「続ける」を断られたお知らせと、その理由 */
  const [resumeErrors, setResumeErrors] = useState<Record<string, string>>({});
  /**
   * 「続ける」を押して返事を待っているお知らせ。押している間はボタンを効かなくする（二重に頼まない。host も同じ
   * お知らせを同時には続けない）。続けて押されたときは描き直す前なので、確かめは ref で行う
   */
  const resumingRef = useRef(new Set<string>());
  const [resuming, setResuming] = useState<ReadonlySet<string>>(() => new Set());
  /** 受信箱から答えようとして断られた判断待ちと、その理由（押したのに何も起きない、を作らない——規則2） */
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const judgments = getRealJudgments();
  // **お知らせ**（決定・2026-09-07）——許可/拒否ではなく「知らせるだけ」。
  // Module が繋がらなかったことは会話に毎ターン出さず、ここに1件だけ出す
  const notices = getRealNotices();
  // **ターンが終わった Thread**（決定・2026-09-27）——開けばその Thread へ。開いたら「見た」になる
  const reviews = getRealReviews();

  if (judgments.length === 0 && notices.length === 0 && reviews.length === 0) {
    return <p className="p-3 text-xs text-ink-3">待っているものはありません</p>;
  }

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      {notices.map((notice) => {
        const project = notice.projectId ? getProject(notice.projectId) : null;
        return (
          <div
            key={notice.id}
            data-testid="inbox-notice"
            className="flex items-start gap-2.5 border-b border-border py-3 last:border-b-0"
          >
            <PlugZap className="mt-0.5 size-4 shrink-0 text-stop" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs text-ink-3">
                <FolderGit2 className="size-3" />
                {project?.name ?? "banto 全体"}
                <span aria-hidden>·</span>
                {age(notice.createdAt, now)}
              </span>
              <span className="mt-0.5 block text-sm text-foreground">{notice.title}</span>
              <span className="mt-0.5 block text-xs text-ink-3">{notice.detail}</span>
              {resumeErrors[notice.id] ? (
                <span data-testid="inbox-notice-resume-error" className="mt-0.5 block text-xs text-stop">
                  続けられませんでした：{resumeErrors[notice.id]}
                </span>
              ) : null}
            </span>
            {notice.resume ? (
              <button
                type="button"
                data-roving-item
                data-testid="inbox-notice-resume"
                disabled={resuming.has(notice.id)}
                onClick={() => {
                  // **自動で続けるのをやめたターンを続ける**（§2.5「上限」）。断られたら理由を出す（規則2）
                  if (resumingRef.current.has(notice.id)) return;
                  resumingRef.current.add(notice.id);
                  setResuming(new Set(resumingRef.current));
                  void resumeRealNoticeTurn(notice.id)
                    .then(() =>
                      setResumeErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== notice.id))),
                    )
                    .catch((err: unknown) =>
                      setResumeErrors((prev) => ({ ...prev, [notice.id]: err instanceof Error ? err.message : String(err) })),
                    )
                    .finally(() => {
                      resumingRef.current.delete(notice.id);
                      setResuming(new Set(resumingRef.current));
                      void refreshRealInbox();
                    });
                }}
                className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-ink-2 hover:bg-accent disabled:opacity-50"
              >
                続ける
              </button>
            ) : null}
            <button
              type="button"
              data-roving-item
              onClick={() => {
                // **見たことにする**——直したかどうかは host が次に繋ぐときに分かる
                // （宣言が変われば、また試す）。ここで再試行の口は作らない（規則3）
                void acknowledgeRealNotice(notice.id).then(() => refreshRealInbox());
              }}
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-ink-2 hover:bg-accent"
            >
              確認した
            </button>
          </div>
        );
      })}
      {judgments.map((item) => {
        const thread = getThread(item.threadId);
        const project = thread ? getProject(thread.projectId) : null;
        const href = thread
          ? thread.kind === "fork"
            ? `/p/${thread.projectId}?fork=${thread.id}`
            : `/p/${thread.projectId}`
          : null;

        const row = (
          <>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-turn-soft text-turn">
              <span className="size-1.5 rounded-full bg-current" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs text-ink-3">
                <FolderGit2 className="size-3" />
                {project?.name ?? "（読み込み中の Project）"}
                <span aria-hidden>·</span>
                {thread?.kind === "fork" ? "Fork Thread" : "Base Thread"}
                <span aria-hidden>·</span>
                {age(item.createdAt, now)}
              </span>
              <span className="mt-0.5 block text-sm text-foreground">{item.message}</span>
            </span>
          </>
        );

        return (
          <div key={item.id} data-testid="inbox-judgment" className="border-b border-border last:border-b-0">
            {href ? (
              <Link
                href={href}
                data-roving-item
                className="flex w-full items-start gap-2.5 py-3 text-left hover:bg-accent"
              >
                {row}
              </Link>
            ) : (
              // Thread がまだ手元に無い（hydration 前）。**行き先を偽らない**
              // ——押せるように見せて何も起きない状態を作らない（規則13）
              <div className="flex w-full items-start gap-2.5 py-3 text-left opacity-60">{row}</div>
            )}
            {item.source === "relay" ? (
              // 会話のカードと同じ答え方（選択肢を押せばそのまま送る・右寄せ・最初だけ塗る、v4-frontend.md「答え方」）
              <div data-testid="inbox-judgment-answer" className="pb-3 pl-6.5">
                <ElicitationFormView
                  elicitation={{ mode: "form", enumOptions: item.choices ?? ["許可する", "拒否する"], allowFreeText: false }}
                  onAnswered={async (answer) => {
                    try {
                      await answerRealJudgment(item.id, answer);
                      setAnswerErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== item.id)));
                    } catch (err) {
                      setAnswerErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : String(err) }));
                      void refreshRealInbox();
                    }
                  }}
                />
                {answerErrors[item.id] ? (
                  <span data-testid="inbox-judgment-answer-error" className="mt-1 block text-xs text-stop">
                    答えを送れませんでした：{answerErrors[item.id]}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {reviews.map((review) => {
        const thread = getThread(review.threadId);
        const project = thread ? getProject(thread.projectId) : null;
        const href = thread
          ? thread.kind === "fork"
            ? `/p/${thread.projectId}?fork=${thread.id}`
            : `/p/${thread.projectId}`
          : null;
        const row = (
          <>
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs text-ink-3">
                <FolderGit2 className="size-3" />
                {project?.name ?? "（読み込み中の Project）"}
                <span aria-hidden>·</span>
                {thread?.title ?? "Thread"}
                <span aria-hidden>·</span>
                {age(review.createdAt, now)}
              </span>
              <span className="mt-0.5 block text-xs text-ink-3">ターンが終わりました</span>
              <span className="mt-0.5 line-clamp-2 block text-sm text-foreground">{review.summary}</span>
            </span>
          </>
        );
        return (
          <div key={review.id} data-testid="inbox-review" className="border-b border-border last:border-b-0">
            {href ? (
              // 開けば Thread の画面が「見た」にする（real-inbox.ts の markThreadViewing）
              <Link href={href} data-roving-item className="flex w-full items-start gap-2.5 py-3 text-left hover:bg-accent">
                {row}
              </Link>
            ) : (
              <div className="flex w-full items-start gap-2.5 py-3 text-left opacity-60">{row}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * **まとめて確認**（追加・2026-10-02、ユーザー要望。位置は同日に見出しの右へ改める）——お知らせとレビュー待ちを
 * 一度に「見た」にする。受信箱の見出しの右（閉じるボタンの左）に置く——通知の一覧によくある形
 * （見出しの右端に一括の操作、片づけるものが無いときは出さない）。
 * **判断待ちは対象にしない**（答えないと AI が進まない。答える口は Thread 側のカード1箇所）。
 */
export function RealInboxAcknowledgeAll() {
  useRealInboxVersion();
  const [busy, setBusy] = useState(false);
  const targets = [...getRealNotices().map((n) => n.id), ...getRealReviews().map((r) => r.id)];
  if (targets.length === 0) return null;
  const waiting = getRealJudgments().length;
  return (
    <button
      type="button"
      data-testid="inbox-acknowledge-all"
      disabled={busy}
      title={
        waiting > 0
          ? `お知らせと終わったターン（${targets.length} 件）を確認済みにします。判断待ち ${waiting} 件は残ります`
          : `お知らせと終わったターン（${targets.length} 件）を確認済みにします`
      }
      onClick={() => {
        setBusy(true);
        // 1件ずつの失敗で止めない——残ったものは取り直したときにまた出る
        void Promise.allSettled(targets.map((id) => acknowledgeRealNotice(id)))
          .then(() => refreshRealInbox())
          .finally(() => setBusy(false));
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-accent hover:text-foreground disabled:opacity-60"
    >
      <CheckCheck className="size-3.5" />
      {busy ? "確認しています…" : "まとめて確認"}
    </button>
  );
}
