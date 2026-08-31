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
        { t: "text", text: "worktree を2本見つけました。詳しくは Repo Module の面で確認できます（Step 3 以降）。" },
      ],
    },
    {
      match: "*",
      steps: [
        { t: "delay", ms: 400 },
        {
          t: "text",
          text: "（ダミー応答）Step 2 の会話ビューはまだ台本を再生しているだけです。tool 呼び出しの表示を見るには「worktree を教えて」のように送ってみてください。",
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
