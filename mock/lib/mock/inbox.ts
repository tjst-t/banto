import type { MockInboxItem } from "./types";
import { notifyMockStoreChange } from "./store-events";

// 7種のサンプル（4判断待ち＋3レビュー待ち）。判断待ちの選択肢は
// v4-architecture.md §2.2「Memory の書き換えと上限」で実際に決めた例をそのまま使う
// ——「拒否されたら判断待ちとして人に上げる。選択肢は『古い行を無効化する』
// 『別の Project を始める』等を Elicitation の enum で提示」
//
// §2.4「判定の軸を一般化した」（2026-08-31）の2軸——判断待ち/レビュー待ち ×
// Thread自身/Module管理下——のうち、"source: elicitation"/"module" は
// Module発、"source: thread" は Base/Fork Thread 自身の会話が発生源
// （Elicitationのような専用プロトコルを持たず、行き先はそのThreadを開くだけ）。
// 通知デモ（新着を追加する）のために mutable にした——projects.ts/threads.ts
// と同じパターン（真実はこの配列1箇所、変更は notifyMockStoreChange() で伝える）。
let inboxItems: MockInboxItem[] = [
  {
    kind: "judgment",
    source: "elicitation",
    id: "inbox-shell-confirm",
    projectId: "banto",
    serverName: "banto.repo",
    threadId: "banto-base",
    threadKind: "base",
    message: "`rm -rf dist/` を実行してよいですか？",
    age: "たった今",
    elicitation: {
      mode: "form",
      enumOptions: ["実行する", "実行しない"],
      allowFreeText: false,
    },
    // Module 側の既定タイムアウト（60秒）をまだ迎えていない、という想定のサンプル
    status: "live",
  },
  {
    kind: "judgment",
    source: "elicitation",
    id: "inbox-memory-limit",
    projectId: "banto",
    serverName: "banto.core",
    threadId: "banto-base",
    threadKind: "base",
    message: "Memory が上限に達しました。どうしますか？",
    age: "12分前",
    elicitation: {
      mode: "form",
      enumOptions: ["古い行を無効化する", "別の Project を始める"],
      allowFreeText: true,
    },
    status: "timedOut",
  },
  {
    kind: "judgment",
    source: "elicitation",
    id: "inbox-github-login",
    projectId: "banto",
    serverName: "banto.repo",
    threadId: "ui",
    threadKind: "fork",
    message: "worktree を push するには GitHub へのログインが必要です。",
    age: "28分前",
    elicitation: {
      mode: "url",
      url: "https://github.com/login/device",
      domain: "github.com",
    },
    status: "timedOut",
  },
  {
    kind: "judgment",
    source: "elicitation",
    id: "inbox-dep-update",
    projectId: "home",
    serverName: "home.repo",
    threadId: "home-base",
    threadKind: "base",
    message: "Caddy の依存を更新してよいですか？（3件、破壊的変更なし）",
    age: "1時間前",
    elicitation: {
      mode: "form",
      enumOptions: ["更新する", "更新しない"],
      allowFreeText: false,
    },
    status: "timedOut",
  },
  {
    // Elicitation を介さない判断待ち——AI自身が Fork Thread の会話で選択肢を
    // 示して止まった。行き先はそのThreadを開いて普通に返信するだけ
    kind: "judgment",
    source: "thread",
    id: "inbox-ui-choice",
    projectId: "banto",
    threadId: "ui",
    threadKind: "fork",
    threadTitle: "会話UIを一から見直す",
    message: "アシスタント表示は「文字なしアイコン」案と「罫線のみ」案、どちらで進めますか？",
    age: "5分前",
  },
  {
    kind: "review",
    source: "module",
    id: "inbox-worker-report",
    projectId: "banto",
    serverName: "banto.worker",
    message: "「views.css の分割」の作業者から診断レポートが届きました。",
    age: "2分前",
    moduleId: "banto.worker",
    viewId: "report",
  },
  {
    kind: "review",
    source: "module",
    id: "inbox-test-run",
    projectId: "hermes",
    serverName: "hermes.test",
    message: "記憶の検索テストが完了しました（180ms、目標 500ms 達成）。",
    age: "40分前",
    moduleId: "hermes.test",
    viewId: "result",
  },
  {
    // 純粋にタスクが完了して終わっただけ——判断は不要、Moduleも絡まない。
    // 行き先はそのThreadを開いて見るだけ
    kind: "review",
    source: "thread",
    id: "inbox-caddy-cert-done",
    projectId: "home",
    threadId: "home-base",
    threadKind: "base",
    threadTitle: "自宅サーバ",
    message: "Caddy の証明書更新スクリプトを直しました。特に確認は要りません。",
    age: "18分前",
  },
];

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
