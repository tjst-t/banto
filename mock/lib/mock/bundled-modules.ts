// 「Module を追加」の banto の Module（同梱の目録 BUNDLED_CATALOG）の見本データ。
// 本物の目録（banto/packages/core/src/modules/declaration.ts）の中身に合わせてある。

export type BundledScope = "project" | "instance";

export interface BundledModule {
  id: string;
  name: string;
  description: string;
  scope: BundledScope;
  /** 一緒に入っていないと動かない、目録の中の Module（required の dependsOn を目録の id にしたもの） */
  requires: string[];
  /** 接続先ごとに何本でも入れるもの（入れたあと設定で接続先を入れる） */
  perConnection?: true;
}

export const BUNDLED_MODULES: BundledModule[] = [
  {
    id: "service",
    name: "Service",
    description: "開発サーバなど、止めるまで動き続けるものを Project のコンテナで起こしておく（落ちたら起こし直す）",
    scope: "project",
    requires: [],
  },
  {
    id: "backlog",
    name: "Backlog",
    description: "今後やること・バグを、ストーリー・タスク・バグと依存で持つ。AI が一覧を引き、タスクに分ける",
    scope: "project",
    requires: [],
  },
  {
    id: "factory",
    name: "Factory",
    description: "Backlog のタスクを worktree で実装・テスト・レビューして main に取り込むまで流す",
    scope: "project",
    requires: ["backlog"],
  },
  {
    id: "browser",
    name: "Browser",
    description: "Project のコンテナの中の Chromium。人の画面で見て触れ、AI も同じタブを操作できる",
    scope: "project",
    requires: [],
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Project のコンテナでシェルを手で打つ。tmux のセッションなので、画面を閉じても残る",
    scope: "project",
    requires: [],
  },
  {
    id: "publish-directory",
    name: "Publish",
    description: "Service で動かしているサーバに URL を生やす。公開のたびに人が承認する",
    scope: "instance",
    requires: ["publish-caddy"],
  },
  {
    id: "publish-caddy",
    name: "Publish（Caddy）",
    description: "host の Caddy に <サービス>-<Project>.<ドメイン> のルートを足して公開する。設定で基のドメインを決める",
    scope: "instance",
    requires: [],
  },
  {
    id: "vault-infisical",
    name: "Vault（Infisical）",
    description: "Infisical に秘密を預ける Vault。自前ホストと Cloud を並べるなど、接続先ごとに1本入れる",
    scope: "instance",
    requires: [],
    perConnection: true,
  },
];

export type Scenario = "fresh" | "some" | "result";

/** 見本の場面ごとの「もう入れてあるもの」（id → 入れてある名前） */
export function installedFor(scenario: Scenario): Record<string, string[]> {
  if (scenario === "fresh") return {};
  return { service: ["service"], backlog: ["backlog"], "vault-infisical": ["vault-infisical"] };
}
