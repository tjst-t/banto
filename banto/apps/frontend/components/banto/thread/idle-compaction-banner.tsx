"use client";

// **空いた会話の冷める前の要約の帯**（追加・2026-10-20、アーキ仕様 §3.1「書きかけ」、v4-frontend.md §6.52）。
//
// 4時間空いた会話を、host がキャッシュの温かいうちに要約する。core は入力欄の様子を知らないので、要約の5分前（`noticeAt`）から
// 入力欄の上に「まもなく要約します」の帯を出し、その会話で人が入力欄に文字を打った（最初の1打鍵で1回だけ）・送った・会話の中で
// 押した（スクロールは除く）ら取りやめを host に伝える——要約をやめて温め直しを続ける。要約している間は「要約しています」。
// 帯は host の知らせ（`idle_compaction.changed`）で消える——ここで先に消さない（規則3）
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Archive, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelRealIdleCompaction, type RealIdleCompaction } from "@/lib/backend/client";
import { useIdleCompaction } from "@/lib/backend/idle-compactions";
import { clockOf } from "@/lib/backend/rate-limit-waits";
import { reportFailure } from "@/lib/report-failure";

/** 取りやめを伝えた予定（同じ予定に2回送らない——最初の1打鍵で1回だけ） */
const cancelled = new Set<string>();

function cancelOnce(threadId: string, at: string): Promise<void> | undefined {
  const key = `${threadId}:${at}`;
  if (cancelled.has(key)) return undefined;
  cancelled.add(key);
  return cancelRealIdleCompaction(threadId);
}

/** 帯を出している（予定があって、帯の時刻を過ぎた）か。帯の時刻になったら描き直す */
function useNotice(threadId: string): { view: RealIdleCompaction | undefined; noticing: boolean } {
  const view = useIdleCompaction(threadId);
  // 帯の時刻を過ぎた予定（帯の時刻の文字列）。時計が知らせる——過ぎていればすぐ
  const [reached, setReached] = useState<string | undefined>(undefined);
  const noticeAt = view?.at !== undefined ? view.noticeAt : undefined;
  useEffect(() => {
    if (noticeAt === undefined) return;
    const left = Date.parse(noticeAt) - Date.now();
    const timer = setTimeout(() => setReached(noticeAt), Math.min(Math.max(0, left) + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [noticeAt]);
  return { view, noticing: noticeAt !== undefined && reached === noticeAt && !view?.compacting };
}

/**
 * **人が戻った合図を拾う**（会話の面を包む）。帯が出ている間だけ、入力欄で文字を打つ・会話の中で押すと取りやめを伝える。
 * 送るのは入力欄の Enter か送るボタン（どちらも打つ・押すに含まれる）。スクロール（ホイール・指で動かす）では `click` が来ない
 */
export function useIdleCompactionReturn(threadId: string): {
  onKeyDownCapture: (e: KeyboardEvent) => void;
  onClickCapture: (e: MouseEvent) => void;
} {
  const { view, noticing } = useNotice(threadId);
  const fire = (): void => {
    if (!noticing || view?.at === undefined) return;
    // 伝えられなくても人の操作は止めない。要約が先に始まった（409）こともある——黙らずに残す
    cancelOnce(threadId, view.at)?.catch((err: unknown) => console.warn(`[banto] ${threadId} の要約を取りやめられませんでした:`, err));
  };
  return {
    onKeyDownCapture: (e) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT" || target?.isContentEditable === true;
      // 文字を打った（1文字のキー・変換中・消す・Enter）。修飾キーだけ・矢印での移動は数えない
      if (typing && (e.key.length === 1 || e.key === "Process" || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete")) fire();
    },
    onClickCapture: () => fire(),
  };
}

/** 入力欄の上の帯：要約の5分前から「まもなく要約します」、要約している間は「要約しています」 */
export function IdleCompactionBanner({ threadId }: { threadId: string }) {
  const { view, noticing } = useNotice(threadId);
  const [busy, setBusy] = useState(false);
  if (view?.compacting) {
    return (
      <div data-testid="thread-idle-compacting" className="mb-2 flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
        <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
        <div className="flex min-w-48 flex-1 flex-col">
          <span className="text-sm text-foreground">要約しています</span>
          <span className="text-xs text-ink-3">4時間空いたので、続きの費用を抑えるために要約しています。送った発言は、要約が終わってから AI に渡ります。</span>
        </div>
      </div>
    );
  }
  if (!noticing || view?.at === undefined) return null;
  const at = view.at;
  const keep = () => {
    // 押した時点で会話の中の押す操作として伝えていることがある（包む側が先に拾う）——そのときは送らない
    const sent = cancelOnce(threadId, at);
    if (!sent) return;
    setBusy(true);
    void sent.catch((err: unknown) => reportFailure("要約を取りやめられませんでした", err)).finally(() => setBusy(false));
  };
  return (
    <div
      data-testid="thread-idle-compaction-notice"
      data-at={at}
      className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3"
    >
      <Archive className="size-4 shrink-0 text-primary" />
      <div className="flex min-w-48 flex-1 flex-col">
        <span className="text-sm text-foreground">まもなく要約します（{clockOf(at)}）</span>
        <span className="text-xs text-ink-3">
          4時間空いたので、続きの費用を抑えるためにこの会話を要約します。打つ・送る・会話の中を押すと、要約せずにこのまま続けます。
        </span>
      </div>
      <Button size="sm" variant="outline" disabled={busy} data-testid="thread-idle-compaction-keep" onClick={keep}>
        要約しない
      </Button>
    </div>
  );
}
