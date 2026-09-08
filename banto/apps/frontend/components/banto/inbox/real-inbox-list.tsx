"use client";

// 受信箱の中身（実データ、§2.4）。Stage 4・決定・2026-09-05。
//
// **判断待ちだけを出す**——レビュー待ちは生成元がまだ無いので、空の区画を
// 画面に残さない（規則13）。
//
// 行き先は**その Thread を開く**だけにする。答える口は Thread 側のカード1箇所
// （§2.4.1、決定・2026-09-06）——同じ操作口を2つ持たない（規則3）。
// そのぶん「Thread を開けば必ずカードがある」ことが要件で、走行中でなくても
// host 側で生きている判断待ちは会話の画面に描き直している
// （lib/backend/adapter.ts の restoredJudgmentMessages）。

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderGit2, PlugZap } from "lucide-react";
import { getRealJudgments, getRealNotices, refreshRealInbox, useRealInboxVersion } from "@/lib/backend/real-inbox";
import { acknowledgeRealNotice } from "@/lib/backend/client";
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
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const judgments = getRealJudgments();
  // **お知らせ**（決定・2026-09-07）——許可/拒否ではなく「知らせるだけ」。
  // Module が繋がらなかったことは会話に毎ターン出さず、ここに1件だけ出す
  const notices = getRealNotices();

  if (judgments.length === 0 && notices.length === 0) {
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
            </span>
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
          <div key={item.id} className="border-b border-border last:border-b-0">
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
          </div>
        );
      })}
    </div>
  );
}
