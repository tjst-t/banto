import type { MockThread } from "./types";

const bantoBaseScript: MockThread["script"] = {
  seed: [
    {
      t: "text",
      text: "banto v4 のモックへようこそ。ここは Base Thread — この Project の主の会話です。",
    },
  ],
  replies: [
    {
      match: /worktree|リポジトリ|repo/i,
      steps: [
        { t: "delay", ms: 300 },
        {
          t: "tool",
          name: "banto_repo_worktree_list",
          args: { project: "banto" },
          result: {
            worktrees: [
              { path: "/home/ubuntu/worktrees/banto-v4", branch: "v4" },
              { path: "/home/ubuntu/worktrees/banto-v4-mock", branch: "v4-mock" },
            ],
          },
          runMs: 500,
        },
        { t: "delay", ms: 200 },
        { t: "text", text: "worktree を2本見つけました。詳しくは Repo Module の Canvas で確認できます（Step 3 以降）。" },
      ],
    },
    {
      // MCP Apps の display mode "inline"（§6.2）の実演。fullscreen（Canvas）とは
      // 独立した、別の描画先——tool 呼び出しの結果を会話のカードに埋め込む
      match: /差分|diff/i,
      steps: [
        { t: "delay", ms: 300 },
        {
          t: "tool",
          name: "banto_repo_diff",
          args: { path: "lib/mock/thread-panel.tsx" },
          result: { files: 1, additions: 4, deletions: 2 },
          runMs: 400,
          inlineView: { moduleId: "banto.repo", viewId: "diff" },
        },
        { t: "delay", ms: 200 },
        { t: "text", text: "変更点をこの場に埋め込んで表示しました（inline）。同じものを大きく見るには「Canvas を開く」を使ってください（fullscreen）。" },
      ],
    },
    {
      // MCP Apps の display mode "fullscreen"（§6.2）の実演。前の inline の例とは
      // 逆に、tool 呼び出し自身が fullscreen を要求する——人がヘッダのボタンを
      // 押すのではなく、結果が揃った瞬間に banto が自動で Canvas を開く
      match: /fullscreen|全画面/i,
      steps: [
        { t: "delay", ms: 300 },
        { t: "text", text: "この変更は分量が多いので、fullscreen で見せます。" },
        {
          t: "tool",
          name: "banto_repo_diff",
          args: { path: "lib/mock/thread-panel.tsx" },
          result: { files: 1, additions: 4, deletions: 2 },
          runMs: 400,
          fullscreenView: { moduleId: "banto.repo", viewId: "diff" },
        },
        { t: "delay", ms: 200 },
        { t: "text", text: "tool 呼び出し自身が fullscreen を要求したので、Canvas を自動で開きました。「Canvas を開く」を押す操作は不要でした。" },
      ],
    },
    {
      // 受信箱のサンプル（inbox.ts の inbox-memory-limit）と同じ場面を、
      // 会話中のライブな Elicitation としても見せる——同じ問いが2箇所に出る
      // 構造（§2.4.1）を、実際の requires-action で確かめる
      match: /memory|メモリ/i,
      steps: [
        { t: "delay", ms: 300 },
        { t: "text", text: "Memory を確認したところ、上限に達しています。" },
        {
          t: "human",
          serverName: "banto.core",
          message: "Memory が上限に達しました。どうしますか？",
          elicitation: {
            mode: "form",
            enumOptions: ["古い行を無効化する", "別の Project を始める"],
            allowFreeText: true,
          },
        },
        { t: "delay", ms: 300 },
        { t: "text", text: "了解しました。その方針で進めます。" },
      ],
    },
    {
      // 承認ゲート（§6.0・§6.4）の実演。Elicitation と違い、tool はまだ
      // 呼ばれていない——承認して初めて実行される
      match: /dist|削除|rm -rf/i,
      steps: [
        { t: "delay", ms: 300 },
        { t: "text", text: "dist/ ディレクトリを削除します。破壊的な操作なので、実行前に確認します。" },
        {
          t: "approval",
          name: "banto_shell_exec",
          args: { command: "rm -rf dist/" },
          result: { stdout: "", exitCode: 0 },
        },
        { t: "delay", ms: 300 },
        { t: "text", text: "了解しました。" },
      ],
    },
    {
      match: "*",
      steps: [
        { t: "delay", ms: 400 },
        {
          t: "text",
          text: "（ダミー応答）Step 2 の会話ビューはまだ台本を再生しているだけです。tool 呼び出しの表示を見るには「worktree を教えて」、判断待ちの表示を見るには「メモリの状況は？」、承認ゲートの表示を見るには「distを削除して」、inline表示を見るには「差分を見せて」のように送ってみてください。",
          charMs: 12,
        },
      ],
    },
  ],
};

const bantoForkUiScript: MockThread["script"] = {
  seed: [
    { t: "text", text: "この Fork では「会話UIを一から見直す」件を扱っています。" },
    { t: "text", text: "prototype/13-tsuzukima-kai.html の意匠を踏襲しつつ、assistant-ui + shadcn/ui で組み直す方針です。" },
  ],
  replies: [
    {
      match: "*",
      steps: [
        { t: "delay", ms: 300 },
        { t: "text", text: "（ダミー応答、Fork Thread側）了解しました。" },
      ],
    },
  ],
};

export const mockThreads: readonly MockThread[] = [
  {
    id: "banto-base",
    projectId: "banto",
    kind: "base",
    title: "banto そのもの",
    parentThreadId: null,
    script: bantoBaseScript,
  },
  {
    id: "ui",
    projectId: "banto",
    kind: "fork",
    title: "会話UIを一から見直す",
    parentThreadId: "banto-base",
    script: bantoForkUiScript,
  },
  {
    id: "home-base",
    projectId: "home",
    kind: "base",
    title: "自宅サーバ",
    parentThreadId: null,
    script: {
      seed: [{ t: "text", text: "自宅サーバ Project の Base Thread です。Caddy・systemd・証明書まわりを扱います。" }],
      replies: [{ match: "*", steps: [{ t: "delay", ms: 300 }, { t: "text", text: "（ダミー応答）" }] }],
    },
  },
  {
    id: "hermes-base",
    projectId: "hermes",
    kind: "base",
    title: "記憶の検証",
    parentThreadId: null,
    script: {
      seed: [{ t: "text", text: "記憶の検証 Project の Base Thread です。" }],
      replies: [{ match: "*", steps: [{ t: "delay", ms: 300 }, { t: "text", text: "（ダミー応答）" }] }],
    },
  },
];

export function getThread(id: string): MockThread | undefined {
  return mockThreads.find((t) => t.id === id);
}

export function getThreadsForProject(projectId: string): readonly MockThread[] {
  return mockThreads.filter((t) => t.projectId === projectId);
}
