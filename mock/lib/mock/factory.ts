// Factory（v4-modules.md §4.5）の見本データと操作。形は Factory の Module が返す `getRuns` と設定（`getSettings`）に揃える
// ——画面が欄の名前を読み替えずに済むように。時刻は「いま」からの差で持つ（見本を開いた時刻で経過が自然に見える）。
import { notifyMockStoreChange } from "./store-events";
import type { ProjectId } from "./types";

/** 段（同梱の手順と Factory が守る流れ）。並びがそのまま進む順 */
export const FACTORY_STAGES = ["始める", "実装", "テスト", "レビュー", "マージ"] as const;
export type FactoryStage = (typeof FACTORY_STAGES)[number] | "順番待ち" | "マージ待ち" | "終わった" | "やめた";

export type FactoryItemStatus = "queued" | "running" | "stopped" | "merging" | "done" | "dropped";

export interface FactoryJournalEntry {
  /** 実行が始まってからの分 */
  atMin: number;
  stage: FactoryStage;
  text: string;
  kind: "stage" | "agent" | "test-ok" | "test-fail" | "review-pass" | "review-changes" | "ask" | "answer" | "git" | "backlog";
}

export interface FactoryItem {
  taskId: string;
  number: number;
  title: string;
  story?: string;
  status: FactoryItemStatus;
  stage: FactoryStage;
  /** いまの段に入ってからの分 */
  stageMin: number;
  /** 始まってからの分 */
  totalMin: number;
  worktree: string;
  branch: string;
  /** 回数（手順の上限と並べて出す） */
  counts: { test: number; review: number };
  stopped?: { reason: string; detail?: string; offers: Array<"continue" | "accept" | "retry" | "drop"> };
  /** いま走っているサブエージェントの仕事（Subagent の画面で開ける） */
  subagent?: { role: "実装役" | "レビュー役"; agent: string; lastStep: string; runId: string };
  lastTest?: { ok: boolean; code: number; tail: string; atMin: number };
  lastReview?: { verdict: "pass" | "changes"; items: Array<{ what: string; where?: string; why: string }> };
  diff?: { files: Array<{ path: string; add: number; del: number }>; commits: number };
  journal: FactoryJournalEntry[];
  result?: string;
}

export interface FactoryRun {
  id: string;
  /** 何分前に流したか */
  startedMinAgo: number;
  /** 頼んだ会話 */
  requestedBy: string;
  finishedMinAgo?: number;
  items: FactoryItem[];
}

export interface FactorySettings {
  testCommand: string;
  prepareCommand: string;
  targetBranch: string;
  implementer: { agent: string; model: string };
  reviewer: { agent: string; model: string };
  concurrency: number;
  limits: { testRetries: number; reviewRounds: number; rebaseRetries: number };
  testTimeoutMinutes: number;
}

/** 長引いているとみなす目安（分）。物差しは未決（unattended-run）——見本は段に居る時間だけで見る */
export const LONG_STAGE_MIN = 30;

export const FACTORY_AGENTS = [
  { id: "claude-code", label: "Claude Code", models: ["既定（banto と同じ）", "claude-opus-5-5", "claude-sonnet-5"] },
  { id: "opencode", label: "OpenCode", models: ["既定", "gpt-5.3-codex", "gemini-3-pro"] },
] as const;

const settingsByProject = new Map<ProjectId, FactorySettings>([
  [
    "banto",
    {
      testCommand: "cd banto && npm run build && npm test",
      prepareCommand: "cp -al ../../banto/node_modules banto/node_modules",
      targetBranch: "main",
      implementer: { agent: "claude-code", model: "既定（banto と同じ）" },
      reviewer: { agent: "opencode", model: "gpt-5.3-codex" },
      concurrency: 3,
      limits: { testRetries: 3, reviewRounds: 2, rebaseRetries: 3 },
      testTimeoutMinutes: 60,
    },
  ],
]);

export const EMPTY_SETTINGS: FactorySettings = {
  testCommand: "",
  prepareCommand: "",
  targetBranch: "main",
  implementer: { agent: "claude-code", model: "既定（banto と同じ）" },
  reviewer: { agent: "claude-code", model: "既定（banto と同じ）" },
  concurrency: 3,
  limits: { testRetries: 3, reviewRounds: 2, rebaseRetries: 3 },
  testTimeoutMinutes: 60,
};

export function getFactorySettings(projectId: ProjectId): FactorySettings {
  return settingsByProject.get(projectId) ?? EMPTY_SETTINGS;
}

export function setFactorySettings(projectId: ProjectId, next: FactorySettings): void {
  settingsByProject.set(projectId, next);
  notifyMockStoreChange();
}

const wt = (id: string) => ({ worktree: `.worktrees/factory-${id}`, branch: `factory/${id}` });

let runs: FactoryRun[] = [
  {
    id: "run-7f3c",
    startedMinAgo: 74,
    requestedBy: "Factory を作る",
    items: [
      {
        taskId: "subagent-cwd-docs",
        number: 231,
        title: "Subagent の cwd と schema を説明に書く",
        story: "サブエージェントと人のやり取り",
        status: "stopped",
        stage: "テスト",
        stageMin: 22,
        totalMin: 71,
        ...wt("subagent-cwd-docs"),
        counts: { test: 4, review: 0 },
        stopped: {
          reason: "テストが 4 回続けて落ちました",
          detail: "subagent の server.integration.test が 60 秒で切れています。実装役は直したつもりですが、同じところで落ち続けています",
          offers: ["continue", "retry", "drop"],
        },
        lastTest: {
          ok: false,
          code: 1,
          atMin: 3,
          tail:
            "✖ 待たない形：すぐ仕事の id を返し…（60012ms）\n" +
            "  Error: 届かない\n" +
            "      at waitDelivered (dist/background.integration.test.js:41:16)\n" +
            "ℹ tests 68\nℹ pass 67\nℹ fail 1",
        },
        diff: {
          commits: 4,
          files: [
            { path: "banto/packages/modules/subagent/src/server.ts", add: 18, del: 6 },
            { path: "banto/packages/modules/subagent/src/background.integration.test.ts", add: 9, del: 2 },
          ],
        },
        journal: [
          { atMin: 0, stage: "始める", kind: "backlog", text: "Backlog を「進めている」に" },
          { atMin: 0, stage: "始める", kind: "git", text: "worktree を作った（factory/subagent-cwd-docs）" },
          { atMin: 1, stage: "実装", kind: "agent", text: "Claude Code に頼んだ" },
          { atMin: 19, stage: "テスト", kind: "test-fail", text: "テストが落ちた（1 回目）——実装役へ戻した" },
          { atMin: 31, stage: "テスト", kind: "test-fail", text: "テストが落ちた（2 回目）——実装役へ戻した" },
          { atMin: 40, stage: "テスト", kind: "test-fail", text: "テストが落ちた（3 回目）——実装役へ戻した" },
          { atMin: 49, stage: "テスト", kind: "test-fail", text: "テストが落ちた（4 回目）" },
          { atMin: 49, stage: "テスト", kind: "ask", text: "止まって、頼んだ会話に知らせた" },
        ],
      },
      {
        taskId: "factory-merge-queue-tests",
        number: 190,
        title: "マージの列の試験——競合する2件・root の未コミットの変更",
        story: "Factory",
        status: "running",
        stage: "実装",
        stageMin: 46,
        totalMin: 48,
        ...wt("factory-merge-queue-tests"),
        counts: { test: 0, review: 0 },
        subagent: { role: "実装役", agent: "Claude Code", lastStep: "npm test -w @banto/module-factory を実行中", runId: "sa-91b2" },
        diff: {
          commits: 2,
          files: [
            { path: "banto/packages/modules/factory/src/engine.test.ts", add: 112, del: 3 },
            { path: "banto/packages/modules/factory/src/engine.ts", add: 7, del: 2 },
          ],
        },
        journal: [
          { atMin: 26, stage: "始める", kind: "backlog", text: "Backlog を「進めている」に" },
          { atMin: 26, stage: "始める", kind: "git", text: "worktree を作った（factory/factory-merge-queue-tests）" },
          { atMin: 28, stage: "実装", kind: "agent", text: "Claude Code に頼んだ" },
        ],
      },
      {
        taskId: "shell-background-run",
        number: 224,
        title: "runCommand に待たない形を足す",
        story: "長い処理の終わりを知らせる",
        status: "running",
        stage: "レビュー",
        stageMin: 4,
        totalMin: 38,
        ...wt("shell-background-run"),
        counts: { test: 1, review: 1 },
        subagent: { role: "レビュー役", agent: "OpenCode", lastStep: "git diff main...HEAD を読んでいる", runId: "sa-77d0" },
        lastTest: { ok: true, code: 0, atMin: 33, tail: "ℹ tests 412\nℹ pass 412\nℹ fail 0" },
        lastReview: {
          verdict: "changes",
          items: [
            { what: "出力のファイルを 0600 で作る", where: "shell/src/background.ts", why: "コマンドの出力に秘密が混ざることがある" },
            { what: "止めたときにプロセスグループごと止める", where: "shell/src/background.ts の stop", why: "子が残り続ける" },
          ],
        },
        diff: {
          commits: 3,
          files: [
            { path: "banto/packages/modules/shell/src/background.ts", add: 164, del: 0 },
            { path: "banto/packages/modules/shell/src/server.ts", add: 41, del: 5 },
            { path: "docs/specs/v4-modules.md", add: 12, del: 1 },
          ],
        },
        journal: [
          { atMin: 36, stage: "始める", kind: "git", text: "worktree を作った（factory/shell-background-run）" },
          { atMin: 37, stage: "実装", kind: "agent", text: "Claude Code に頼んだ" },
          { atMin: 55, stage: "テスト", kind: "test-ok", text: "テストが通った" },
          { atMin: 57, stage: "レビュー", kind: "review-changes", text: "OpenCode が直すことを2つ指摘——実装役へ戻した" },
          { atMin: 64, stage: "テスト", kind: "test-ok", text: "テストが通った" },
          { atMin: 70, stage: "レビュー", kind: "agent", text: "OpenCode に頼んだ（2 回目）" },
        ],
      },
      {
        taskId: "inbox-stale-badge",
        number: 219,
        title: "受信箱の古い印を数えない",
        status: "merging",
        stage: "マージ待ち",
        stageMin: 1,
        totalMin: 29,
        ...wt("inbox-stale-badge"),
        counts: { test: 1, review: 1 },
        lastTest: { ok: true, code: 0, atMin: 72, tail: "ℹ pass 574\nℹ fail 0" },
        lastReview: { verdict: "pass", items: [] },
        diff: { commits: 1, files: [{ path: "banto/packages/core/src/inbox/store.ts", add: 9, del: 4 }] },
        journal: [
          { atMin: 44, stage: "始める", kind: "git", text: "worktree を作った（factory/inbox-stale-badge）" },
          { atMin: 45, stage: "実装", kind: "agent", text: "Claude Code に頼んだ" },
          { atMin: 61, stage: "テスト", kind: "test-ok", text: "テストが通った" },
          { atMin: 72, stage: "レビュー", kind: "review-pass", text: "OpenCode が「このまま取り込んでよい」" },
          { atMin: 73, stage: "マージ待ち", kind: "stage", text: "マージの列に並んだ（前に 0 件）" },
        ],
      },
      {
        taskId: "turn-summary-copy",
        number: 226,
        title: "まとめの「次に頼めること」の文を揃える",
        status: "done",
        stage: "終わった",
        stageMin: 0,
        totalMin: 21,
        ...wt("turn-summary-copy"),
        counts: { test: 1, review: 1 },
        lastTest: { ok: true, code: 0, atMin: 19, tail: "ℹ pass 572\nℹ fail 0" },
        lastReview: { verdict: "pass", items: [] },
        diff: { commits: 1, files: [{ path: "banto/packages/core/src/thread/report-turn.ts", add: 6, del: 6 }] },
        result: "main に取り込みました（a41c9e02）",
        journal: [
          { atMin: 0, stage: "実装", kind: "agent", text: "Claude Code に頼んだ" },
          { atMin: 14, stage: "テスト", kind: "test-ok", text: "テストが通った" },
          { atMin: 18, stage: "レビュー", kind: "review-pass", text: "OpenCode が「このまま取り込んでよい」" },
          { atMin: 21, stage: "マージ", kind: "git", text: "main に取り込んだ（a41c9e02）——worktree とブランチを消した" },
          { atMin: 21, stage: "終わった", kind: "backlog", text: "Backlog を「終わった」に" },
        ],
      },
    ],
  },
  {
    id: "run-2a91",
    startedMinAgo: 60 * 26,
    finishedMinAgo: 60 * 24,
    requestedBy: "Base Thread",
    items: [
      {
        taskId: "vault-empty-values",
        number: 208,
        title: "値が空の秘密を渡さない",
        status: "done",
        stage: "終わった",
        stageMin: 0,
        totalMin: 52,
        ...wt("vault-empty-values"),
        counts: { test: 2, review: 1 },
        result: "main に取り込みました（1a3dfb5e）",
        journal: [],
      },
      {
        taskId: "vault-variant-ui",
        number: 209,
        title: "置き場ダイアログに版の欄",
        status: "dropped",
        stage: "やめた",
        stageMin: 0,
        totalMin: 33,
        ...wt("vault-variant-ui"),
        counts: { test: 1, review: 3 },
        result: "やめました：人が手で作り直すと答えました。worktree とブランチは残してあります",
        journal: [],
      },
    ],
  },
];

export function getFactoryRuns(projectId: ProjectId): FactoryRun[] {
  return projectId === "banto" ? runs : [];
}

export type FactoryAnswer =
  | { action: "continue"; instruction: string }
  | { action: "accept" }
  | { action: "retry"; stage: FactoryStage }
  | { action: "drop"; reason: string };

function updateItem(runId: string, taskId: string, change: (i: FactoryItem) => FactoryItem): void {
  runs = runs.map((r) => (r.id !== runId ? r : { ...r, items: r.items.map((i) => (i.taskId === taskId ? change(i) : i)) }));
  notifyMockStoreChange();
}

/** 答える（`answerFactory`）。見本は答えの形に合わせて段だけ動かす */
export function answerFactoryItem(runId: string, taskId: string, answer: FactoryAnswer): void {
  updateItem(runId, taskId, (i) => {
    const entry = (text: string, stage: FactoryStage): FactoryJournalEntry => ({ atMin: i.totalMin, stage, kind: "answer", text });
    if (answer.action === "drop") {
      return {
        ...i,
        status: "dropped",
        stage: "やめた",
        stopped: undefined,
        result: `やめました：${answer.reason || "人がやめると答えました"}。worktree とブランチは残してあります`,
        journal: [...i.journal, entry(`人が「やめる」と答えた${answer.reason ? `：${answer.reason}` : ""}`, "やめた")],
      };
    }
    const stage: FactoryStage = answer.action === "retry" ? answer.stage : answer.action === "accept" ? "マージ待ち" : "実装";
    const text =
      answer.action === "continue"
        ? `人が指示を足して「続ける」：${answer.instruction}`
        : answer.action === "accept"
          ? "人が「このまま取り込む」と答えた"
          : `人が「${answer.stage}からやり直す」と答えた`;
    return {
      ...i,
      status: stage === "マージ待ち" ? "merging" : "running",
      stage,
      stageMin: 0,
      stopped: undefined,
      counts: { ...i.counts, test: 0 },
      subagent: stage === "実装" ? { role: "実装役", agent: "Claude Code", lastStep: "起こしています", runId: "sa-new" } : undefined,
      journal: [...i.journal, entry(text, stage)],
    };
  });
}

/** 止める（`cancelFactory`）。Backlog は「準備できた」に戻し、worktree は残す */
export function cancelFactoryItem(runId: string, taskId: string): void {
  updateItem(runId, taskId, (i) => ({
    ...i,
    status: "dropped",
    stage: "やめた",
    subagent: undefined,
    stopped: undefined,
    result: "止めました。Backlog は「準備できた」に戻し、worktree とブランチは残してあります",
    journal: [...i.journal, { atMin: i.totalMin, stage: "やめた", kind: "answer", text: "人が画面から止めた" }],
  }));
}
