import type { MockInboxItem } from "./types";

// 7種のサンプル（4判断待ち＋3レビュー待ち）。判断待ちの選択肢は
// v4-architecture.md §2.2「Memory の書き換えと上限」で実際に決めた例をそのまま使う
// ——「拒否されたら判断待ちとして人に上げる。選択肢は『古い行を無効化する』
// 『別の Project を始める』等を Elicitation の enum で提示」
//
// §2.4「判定の軸を一般化した」（2026-08-31）の2軸——判断待ち/レビュー待ち ×
// Thread自身/Module管理下——のうち、"source: elicitation"/"module" は
// Module発、"source: thread" は Base/Fork Thread 自身の会話が発生源
// （Elicitationのような専用プロトコルを持たず、行き先はそのThreadを開くだけ）。
export const mockInboxItems: readonly MockInboxItem[] = [
  {
    kind: "judgment",
    source: "elicitation",
    id: "inbox-shell-confirm",
    projectId: "banto",
    serverName: "banto.repo",
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

export function getInboxItem(id: string): MockInboxItem | undefined {
  return mockInboxItems.find((item) => item.id === id);
}
