// 設定の「更新」（banto 自身を新しい版にする）のモック用データ（2026-10-04）。
// 本物の通信はしない——GitHub の release・今動いている会話・組み立てのログは、すべてここの偽物。

export interface MockCommit {
  shortId: string;
  title: string;
  /** ISO 8601 */
  at: string;
}

/** 今動いている版 */
export const mockCurrentVersion: MockCommit = {
  shortId: "597f350",
  title: "fix(core): Thread の使用量は最新の1件だけ持つ",
  at: "2026-10-02T21:14:00+09:00",
};

/** GitHub の release の最新 */
export const mockLatestRelease = {
  tag: "2026.10.04",
  shortId: "c81e2d4",
  publishedAt: "2026-10-04T09:40:00+09:00",
};

/** 今の版から最新の release までに入る新しいコミット（新しい順） */
export const mockNewCommits: readonly MockCommit[] = [
  { shortId: "c81e2d4", title: "feat(frontend): 設定に「更新」の節を足す", at: "2026-10-04T09:31:00+09:00" },
  { shortId: "7b3a910", title: "fix(core): 会話を閉じたあとも Fork の記録が残り続けていた", at: "2026-10-04T08:55:00+09:00" },
  { shortId: "e40c6f2", title: "feat(backlog): 項目の依存を一覧で辿れるようにする", at: "2026-10-03T23:12:00+09:00" },
  { shortId: "19d8b75", title: "fix(frontend): 携帯で受信箱のバッジが重なって読めなかった", at: "2026-10-03T21:47:00+09:00" },
  { shortId: "a6f0c33", title: "fix(shell): 長い出力を貼ると画面が固まっていた", at: "2026-10-03T19:02:00+09:00" },
  { shortId: "5c2e8d1", title: "feat(core): Project ごとにコンテナの上限を下げられる", at: "2026-10-03T16:20:00+09:00" },
  { shortId: "0e91b4a", title: "docs(specs): ログインの節を書き直す", at: "2026-10-03T14:05:00+09:00" },
  { shortId: "d27f6a8", title: "fix(vault): 鍵の名前に空白があると読めなかった", at: "2026-10-03T11:38:00+09:00" },
  { shortId: "8a4c1e0", title: "feat(repositories): clone のときに既定のブランチを選べる", at: "2026-10-03T10:14:00+09:00" },
  { shortId: "f3b7d29", title: "fix(core): 起動直後の記憶の読み込みが2回走っていた", at: "2026-10-02T23:51:00+09:00" },
  { shortId: "62d0a7c", title: "chore: 依存を更新", at: "2026-10-02T22:30:00+09:00" },
  { shortId: "b95e3f1", title: "fix(frontend): 暗い色で差分の背景が見えなかった", at: "2026-10-02T21:40:00+09:00" },
];

export interface MockRunningWork {
  projectName: string;
  threadTitle: string;
  /** いつから動いているか（分） */
  sinceMinutes: number;
  /** AI が人の返事を待っている（止まってはいるが、会話は途中） */
  waitingForHuman: boolean;
}

/** 今 AI が動いている会話 */
export const mockRunningWork: readonly MockRunningWork[] = [
  { projectName: "banto", threadTitle: "初回描画のパフォーマンス調査", sinceMinutes: 12, waitingForHuman: false },
  { projectName: "banto", threadTitle: "仕様書の整理", sinceMinutes: 3, waitingForHuman: true },
  { projectName: "記憶の検証", threadTitle: "埋め込みの再計算コストを測る", sinceMinutes: 41, waitingForHuman: false },
];

/** 最後に GitHub を確かめた時刻 */
export const mockLastCheckedAt = "2026-10-04T10:02:00+09:00";

function buildLogLines(failedAt: "build" | "restart"): string {
  const lines: string[] = [
    "$ git fetch --tags origin",
    "From github.com:tjst-t/banto",
    ` * [new tag]         ${mockLatestRelease.tag} -> ${mockLatestRelease.tag}`,
    `$ git worktree add /var/lib/banto/next ${mockLatestRelease.shortId}`,
    `Preparing worktree (detached HEAD ${mockLatestRelease.shortId})`,
    "$ npm ci",
  ];
  for (let i = 1; i <= 40; i++) {
    lines.push(`added ${i * 37} packages, audited ${i * 41} packages in ${(i * 0.4).toFixed(1)}s`);
  }
  lines.push("$ npm run build --workspaces");
  const packages = ["core", "frontend", "backlog", "vault", "shell", "repositories"];
  for (const p of packages) {
    lines.push(`> @banto/${p}@0.0.0 build`);
    lines.push(`> tsc -p tsconfig.build.json`);
    if (failedAt === "build" && p === "backlog") {
      lines.push(
        "src/tools/list-items.ts(48,17): error TS2339: Property 'dependsOn' does not exist on type 'BacklogItem'.",
        "src/tools/list-items.ts(52,9): error TS7006: Parameter 'dep' implicitly has an 'any' type.",
        "npm error Lifecycle script `build` failed with error:",
        "npm error code 2",
        "npm error path /var/lib/banto/next/banto/packages/backlog",
        "組み立てで止まりました（終了コード 2）。今の版はそのまま動いています。",
      );
      return lines.join("\n");
    }
    for (let i = 0; i < 6; i++) lines.push(`  compiled ${p}/src/${["index", "server", "tools", "store", "schema", "routes"][i]}.ts`);
  }
  lines.push(
    "組み立てが終わりました（4分12秒）",
    "AI が止まるのを待っています… 残り 0 件",
    "$ systemctl --user restart banto",
    "新しい版を起こしています",
    "GET http://127.0.0.1:4100/health -> 接続できません（1回目）",
    "GET http://127.0.0.1:4100/health -> 接続できません（2回目）",
    "GET http://127.0.0.1:4100/health -> 接続できません（3回目）",
    "banto[2381]: Error: Cannot find module '/var/lib/banto/next/banto/packages/core/dist/migrations/0042.js'",
    "banto[2381]:     at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
    "banto[2381]:     at runMigrations (/var/lib/banto/next/banto/packages/core/dist/db.js:88:11)",
    "GET http://127.0.0.1:4100/health -> 接続できません（10回目）",
    "60秒待っても新しい版が起きませんでした",
    `前の版（${mockCurrentVersion.shortId}）に戻しています`,
    "$ systemctl --user restart banto",
    "GET http://127.0.0.1:4100/health -> 200 OK",
    `前の版（${mockCurrentVersion.shortId}）で動いています。`,
  );
  return lines.join("\n");
}

export const mockBuildFailureLog = buildLogLines("build");
export const mockRestartFailureLog = buildLogLines("restart");
