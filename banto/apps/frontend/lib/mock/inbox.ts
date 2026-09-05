import type { MockInboxItem } from "./types";
import { notifyMockStoreChange } from "./store-events";

// デモ用の初期エントリーは持たない（決定・2026-09-03、実機投入に伴いデモデータを撤去）。
// §2.4「判定の軸を一般化した」（2026-08-31）の2軸——判断待ち/レビュー待ち ×
// Thread自身/Module管理下——のうち、"source: elicitation"/"module" は
// Module発、"source: thread" は Base/Fork Thread 自身の会話が発生源
// （Elicitationのような専用プロトコルを持たず、行き先はそのThreadを開くだけ）。
// mutableにしているのは通知（新着を追加する）のため——projects.ts/threads.ts
// と同じパターン（真実はこの配列1箇所、変更は notifyMockStoreChange() で伝える）。
let inboxItems: MockInboxItem[] = [];

export function getInboxItems(): readonly MockInboxItem[] {
  return inboxItems;
}

export function getInboxItem(id: string): MockInboxItem | undefined {
  return inboxItems.find((item) => item.id === id);
}

/**
 * この項目に「答える／確認する」がどこで完結するかを1つのhrefに解決する
 * （レビュー指摘 2026-09-02——トースト等から受信箱を経由させず、行き先へ直接飛ばす）。
 * Module発のレビューはCanvas。それ以外（Thread自身発・Elicitation発とも）は
 * そのThread——Elicitationも必ずどこかのThreadでの tool 呼び出し中に発生しており、
 * 生きている間は同じ tool 呼び出しがThread側にも表示される（HumanToolCard）ので、
 * 受信箱を経由させる理由が無い（レビュー指摘 2026-09-02、2回目）。
 * Command Palette（`lib/mock/palette.ts`）・通知トーストの両方がこれを使う——
 * 行き先の判定基準は1箇所に留める（規則3）。
 */
export function getInboxItemHref(item: MockInboxItem): string {
  if (item.source === "module") {
    return `/p/${item.projectId}?canvas=${item.moduleId}:${item.viewId}`;
  }
  return item.threadKind === "fork"
    ? `/p/${item.projectId}?fork=${item.threadId}`
    : `/p/${item.projectId}`;
}

/** 通知デモ用：新着を先頭に積む。実運用のイベント発生源（Elicitation等）とは繋がっていない */
export function addInboxItem(item: MockInboxItem): void {
  inboxItems = [item, ...inboxItems];
  notifyMockStoreChange();
}

/**
 * 決着したので一覧から取り除く（解決済みは状態として保持しない、Event Store の射影）。
 * 会話側のカードで答えた判断待ちが受信箱に残り続けないようにするために要る。
 */
export function removeInboxItem(id: string): void {
  const next = inboxItems.filter((item) => item.id !== id);
  if (next.length === inboxItems.length) return;
  inboxItems = next;
  notifyMockStoreChange();
}
