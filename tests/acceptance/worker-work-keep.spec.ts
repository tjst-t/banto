/**
 * work-keep: **機構が職人の成果を保全する**。
 *
 * 職人はブランチのワークツリーで働くが、落ちたり無報告で終わったりすると、そこまでの変更は
 * 未コミットのまま取り残される（実測8件。そのたびに失われている）。職人の作法まかせにせず、
 * 機構が定期的に取り置く——それがここで押さえること。
 *
 * **両経路を押さえる。** 職人には pi と Claude Agent SDK の2つのランタイム経路があり、
 * 実運用の職人はほぼ全部 Claude Agent SDK 側である。task-0102 では退避が pi 経路にしか
 * 載っておらず、器の試験は全部通っていたのに対策は1行も効いていなかった。だから押さえるのは
 * **器**（本物の git で取り置けること）と、**両経路の繋ぎ目**（実際に発火すること）の2つ。
 *
 * 本物の LLM は呼ばない。フックは `buildHostOptions` が返した options から取り出して直に叩き、
 * pi 拡張は偽の pi に載せて直に叩く——どちらもホスト／pi が呼ぶのと同じ実体である。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import * as childProcess from "node:child_process";

import {
  CLAUDE_KEEP_RUNTIME,
  DEFAULT_KEEP_INTERVAL_MS,
  DEFAULT_KEEP_MAX_AGE_DAYS,
  KEEPER_EMAIL,
  KEEPER_NAME,
  KEEP_BRANCH_PREFIX,
  KEEP_ENABLED_ENV,
  KEEP_INTERVAL_ENV,
  KEEP_MAX_AGE_ENV,
  KEEP_PRUNE_LOG,
  KEEP_SUBJECT_PREFIX,
  PI_KEEP_RUNTIME,
  PiRpcDriver,
  WorkerPool,
  WorktreeKeeper,
  buildHostOptions,
  createClaudeToolOffload,
  createClaudeWorkKeep,
  createGitRunner,
  createWorkerTools,
  createWorktreeKeeper,
  installWorkKeep,
  isKeepEnabled,
  keepBranchName,
  listKeepBranches,
  parseKeepBranch,
  pruneKeepBranches,
  resolveKeepIntervalMs,
  resolveKeepMaxAgeMs,
  sanitizeRefPart,
  workKeepExtensionPath,
  type GitRunner,
} from "@banto/worker-pool";
import { PRESENTED_TOOL_NAMES } from "../../packages/banto-host/src/presented-tools.js";

// ── 道具立て ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).toString();
}

/** 職人のワークツリーの代わり（コミットが1つある普通のリポジトリ）。 */
function initRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "banto-keep-repo-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "職人"]);
  git(dir, ["config", "user.email", "worker@example.invalid"]);
  fs.writeFileSync(path.join(dir, "README.md"), "初期\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "初期化"]);
  return dir;
}

const IDENTITY = {
  projectTag: "banto",
  taskId: "task-0103",
  runtime: "test",
} as const;

/** 試験用の器（間隔は明示、枝の名前も固定して読みやすくする）。 */
function keeperFor(
  repo: string,
  overrides: { intervalMs?: number; now?: () => number; branch?: string } = {}
): WorktreeKeeper {
  return new WorktreeKeeper({
    cwd: repo,
    identity: { ...IDENTITY, worktree: repo },
    intervalMs: overrides.intervalMs ?? 0,
    branch: overrides.branch ?? keepBranchName(IDENTITY, new Date("2026-08-14T10:15:30.000Z")),
    indexFile: path.join(repo, "..", `keep-${path.basename(repo)}.index`),
    ...(overrides.now ? { now: overrides.now } : {}),
    onError: () => undefined,
  });
}

/** 取り置き枝に載っているコミットの一覧（新しい順）。 */
function keepLog(repo: string, branch: string, format: string): string[] {
  const out = git(repo, ["log", `--format=${format}`, `refs/heads/${branch}`]);
  return out.split("\n").filter((line) => line.length > 0);
}

// ── a1: 未コミットの成果が名前つきの枝に残る ────────────────────────────────

describe("[work-keep/a1] 機構が打つので、職人が落ちても成果が残る", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("未コミットの変更が取り置き枝に載る（職人は1度もコミットしていない）", () => {
    fs.writeFileSync(path.join(repo, "書きかけ.ts"), "export const 途中 = 1;\n");
    const keeper = keeperFor(repo);

    const outcome = keeper.snapshot("interval");

    assert.equal(outcome.status, "kept", JSON.stringify(outcome));
    // 枝から中身を取り出せる＝ワークツリーを畳んでも成果が残る
    const shown = git(repo, ["show", `refs/heads/${keeper.branch}:書きかけ.ts`]);
    assert.equal(shown, "export const 途中 = 1;\n");
  });

  it("追跡外の新しいファイルも拾う（職人の作りかけは大抵まだ追跡外）", () => {
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src/新規.ts"), "新しい\n");
    const keeper = keeperFor(repo);

    keeper.snapshot("interval");

    assert.equal(git(repo, ["show", `refs/heads/${keeper.branch}:src/新規.ts`]), "新しい\n");
  });

  it("成果は名前つきの枝に残る（git branch から見える）", () => {
    fs.writeFileSync(path.join(repo, "途中.txt"), "あ\n");
    const keeper = keeperFor(repo);
    keeper.snapshot("interval");

    const branches = git(repo, ["branch", "--list", `${KEEP_BRANCH_PREFIX}/*`, "--format=%(refname:short)"])
      .split("\n")
      .filter((b) => b.length > 0);

    assert.deepEqual(branches, [keeper.branch]);
  });

  it("枝の名前で「どのタスクの・いつの・どのランタイムの作業か」が辿れる", () => {
    const branch = keepBranchName(
      { projectTag: "banto", taskId: "task-0103", runtime: "claude-agent" },
      new Date("2026-08-14T10:15:30.000Z")
    );

    assert.equal(branch, "banto/keep/banto/task-0103/20260814T101530Z-claude-agent");
  });

  it("ref に使えない字は潰す（枝が作れないと取り置きごと落ちる）", () => {
    const branch = keepBranchName(
      { projectTag: "my project", taskId: "feat/直す~やつ", runtime: "pi" },
      new Date("2026-08-14T10:15:30.000Z")
    );

    // 実際に git が受け付ける名前であること（判定を自分の思い込みに任せない）
    execFileSync("git", ["check-ref-format", `refs/heads/${branch}`]);
    assert.equal(sanitizeRefPart("...."), "unknown");
    assert.equal(sanitizeRefPart("a.lock"), "a-lock");
  });

  it("何度も撮ると1本の枝に積み上がる（履歴として辿れる）", () => {
    const keeper = keeperFor(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    keeper.snapshot("interval");
    fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
    keeper.snapshot("interval");

    const subjects = keepLog(repo, keeper.branch, "%s");
    assert.equal(subjects.length, 3); // 取り置き2枚 ＋ 職人の初期化コミット
    assert.match(subjects[0]!, /途中経過 #2/u);
    assert.match(subjects[1]!, /途中経過 #1/u);
  });

  it("職人が自分で打ったコミットも取り置き枝から辿れる（HEAD を親に繋ぐ）", () => {
    const keeper = keeperFor(repo);
    fs.writeFileSync(path.join(repo, "b.txt"), "職人の仕事\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "職人が自分で打った"]);
    fs.writeFileSync(path.join(repo, "c.txt"), "まだ途中\n");

    keeper.snapshot("interval");

    const subjects = keepLog(repo, keeper.branch, "%s");
    assert.ok(subjects.includes("職人が自分で打った"), subjects.join(" / "));
  });
});

// ── a2: 機構が打ったと分かる ────────────────────────────────────────────────

describe("[work-keep/a2] 人が書いたコミットと混同しない", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("打ち手は機構の名前（--author で機構の分だけ抜ける）", () => {
    fs.writeFileSync(path.join(repo, "x.txt"), "あ\n");
    const keeper = keeperFor(repo);
    keeper.snapshot("interval");

    const authors = keepLog(repo, keeper.branch, "%an <%ae>");
    assert.equal(authors[0], `${KEEPER_NAME} <${KEEPER_EMAIL}>`);
    // 職人自身のコミットは職人の名前のまま（混ざっていない）
    assert.equal(authors[1], "職人 <worker@example.invalid>");
    const committers = keepLog(repo, keeper.branch, "%cn");
    assert.equal(committers[0], KEEPER_NAME);
  });

  it("本文に「誰の・どのタスクの・なぜ撮ったか」が載る", () => {
    fs.writeFileSync(path.join(repo, "x.txt"), "あ\n");
    const keeper = keeperFor(repo);
    keeper.snapshot("turn_end");

    const body = git(repo, ["log", "-1", "--format=%B", `refs/heads/${keeper.branch}`]);
    assert.ok(body.startsWith(KEEP_SUBJECT_PREFIX), body);
    assert.match(body, /機構が自動で打った取り置き/u);
    assert.match(body, /project: banto/u);
    assert.match(body, /task: task-0103/u);
    assert.match(body, /runtime: test/u);
    assert.match(body, /reason: turn_end/u);
    assert.match(body, new RegExp(`worktree: ${repo.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  });
});

// ── a3: 職人の作業を壊さない ────────────────────────────────────────────────

describe("[work-keep/a3] 守るための機構が作業を壊さない", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("HEAD も現在の枝も動かさない", () => {
    fs.writeFileSync(path.join(repo, "x.txt"), "あ\n");
    const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();
    const branchBefore = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

    keeperFor(repo).snapshot("interval");

    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), headBefore);
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), branchBefore);
  });

  it("職人の index を触らない（途中まで git add した状態が消えない）", () => {
    fs.writeFileSync(path.join(repo, "staged.txt"), "これは stage 済み\n");
    fs.writeFileSync(path.join(repo, "unstaged.txt"), "これは未 stage\n");
    git(repo, ["add", "staged.txt"]);
    const statusBefore = git(repo, ["status", "--porcelain"]);
    const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));

    keeperFor(repo).snapshot("interval");

    assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), indexBefore);
  });

  it("作業ツリーのファイルを1つも書き換えない", () => {
    fs.writeFileSync(path.join(repo, "x.txt"), "あ\n");
    const before = fs.readdirSync(repo).sort();

    keeperFor(repo).snapshot("interval");

    assert.deepEqual(fs.readdirSync(repo).sort(), before);
    assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf-8"), "あ\n");
  });

  it(".gitignore に従う（職人が捨てたいものを枝に固めない）", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(path.join(repo, "node_modules", "重い.js"), "x\n");
    const keeper = keeperFor(repo);

    keeper.snapshot("interval");

    const files = git(repo, ["ls-tree", "-r", "--name-only", `refs/heads/${keeper.branch}`]);
    assert.ok(!files.includes("node_modules"), files);
  });
});

// ── a4: 空振り・失敗の扱い ──────────────────────────────────────────────────

describe("[work-keep/a4] 空撮りしない・失敗しても職人を巻き込まない", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("変わっていなければコミットを積まない", () => {
    const keeper = keeperFor(repo);

    const first = keeper.snapshot("start");
    assert.equal(first.status, "unchanged", JSON.stringify(first));

    fs.writeFileSync(path.join(repo, "x.txt"), "あ\n");
    assert.equal(keeper.snapshot("interval").status, "kept");
    // 2回目は同じ姿なので積まない
    assert.equal(keeper.snapshot("interval").status, "unchanged");
    assert.equal(keeper.keptCount(), 1);
  });

  it("git の外で働く職人では黙って降りる（例外にしない）", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "banto-keep-plain-"));
    try {
      const keeper = new WorktreeKeeper({
        cwd: plain,
        identity: { ...IDENTITY, worktree: plain },
        intervalMs: 0,
        indexFile: path.join(plain, "keep.index"),
        onError: () => undefined,
      });

      assert.equal(keeper.snapshot("interval").status, "skipped");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("git が失敗しても投げない（職人のターンを壊さない）", () => {
    const errors: string[] = [];
    const keeper = new WorktreeKeeper({
      cwd: repo,
      identity: IDENTITY,
      intervalMs: 0,
      indexFile: path.join(repo, "..", "broken.index"),
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git\n";
        throw new Error("git 爆発");
      },
      onError: (message) => errors.push(message),
    });

    const outcome = keeper.snapshot("interval");

    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /git 爆発/u);
    // I2: 握りつぶさない——失敗したことは残る
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /取り置きに失敗/u);
  });
});

// ── a5: 「定期的」であること ────────────────────────────────────────────────

describe("[work-keep/a5] 間隔の決め方", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("間隔が過ぎるまで撮らない・過ぎたら撮る", () => {
    let clock = 1_000_000;
    const keeper = keeperFor(repo, { intervalMs: 120_000, now: () => clock });
    keeper.snapshot("start"); // ここで時計が始まる
    fs.writeFileSync(path.join(repo, "x.txt"), "あ\n");

    clock += 119_000;
    assert.equal(keeper.maybeSnapshot("tool_result"), undefined);
    assert.equal(keeper.keptCount(), 0);

    clock += 2_000;
    assert.equal(keeper.maybeSnapshot("tool_result")?.status, "kept");
    assert.equal(keeper.keptCount(), 1);
  });

  it("既定は2分。環境変数で変えられる（読めない値・短すぎる値は既定へ）", () => {
    assert.equal(DEFAULT_KEEP_INTERVAL_MS, 120_000);
    assert.equal(resolveKeepIntervalMs({}), 120_000);
    assert.equal(resolveKeepIntervalMs({ [KEEP_INTERVAL_ENV]: "30000" }), 30_000);
    assert.equal(resolveKeepIntervalMs({ [KEEP_INTERVAL_ENV]: "なんだこれ" }), 120_000);
    assert.equal(resolveKeepIntervalMs({ [KEEP_INTERVAL_ENV]: "0" }), 120_000);
  });

  it("既定は入っている（載せ忘れた職人だけが穴に落ちるのを避ける）", () => {
    assert.equal(isKeepEnabled({}), true);
    assert.equal(isKeepEnabled({ [KEEP_ENABLED_ENV]: "0" }), false);
    assert.equal(isKeepEnabled({ [KEEP_ENABLED_ENV]: "off" }), false);
    assert.equal(isKeepEnabled({ [KEEP_ENABLED_ENV]: "1" }), true);
  });

  it("止めてあれば器ごと作らない（タイマーも枝も無い）", () => {
    assert.equal(
      createWorktreeKeeper({ runtime: "pi", cwd: repo, env: { [KEEP_ENABLED_ENV]: "0" } }),
      undefined
    );
  });
});

// ══ 経路1: pi ═══════════════════════════════════════════════════════════════

/** pi の代わり。拡張が何に繋いだかを覚えるだけ。 */
function fakePi(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の API 形状を真似る (I4)
  on: (event: string, handler: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
  handlers: Map<string, any>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
  const handlers = new Map<string, any>();
  return { on: (event, handler) => handlers.set(event, handler), handlers };
}

describe("[work-keep/pi] pi 経路の職人に載って、実際に発火する", () => {
  let repo: string;
  let cwdBefore: string;
  let saved: Record<string, string | undefined>;
  let installed: ReturnType<typeof installWorkKeep>;

  beforeEach(() => {
    repo = initRepo();
    cwdBefore = process.cwd();
    saved = {
      project: process.env["BANTO_PROJECT"],
      task: process.env["BANTO_TASK_ID"],
      enabled: process.env[KEEP_ENABLED_ENV],
      interval: process.env[KEEP_INTERVAL_ENV],
    };
    process.env["BANTO_PROJECT"] = "banto";
    process.env["BANTO_TASK_ID"] = "task-0103";
    delete process.env[KEEP_ENABLED_ENV];
    // 「間隔が過ぎたら撮る」は a5 で押さえたので、ここは繋ぎ目だけを見る
    process.env[KEEP_INTERVAL_ENV] = "1000";
    // pi は職人の worktree を cwd にして起こす。既定の経路（process.cwd()）をそのまま試す
    process.chdir(repo);
  });

  afterEach(() => {
    // process 全体のフックを残さない（残すと試験プロセスの終了時に発火する）
    installed?.stop("manual");
    installed = undefined;
    process.chdir(cwdBefore);
    for (const [key, name] of [
      [saved["project"], "BANTO_PROJECT"],
      [saved["task"], "BANTO_TASK_ID"],
      [saved["enabled"], KEEP_ENABLED_ENV],
      [saved["interval"], KEEP_INTERVAL_ENV],
    ] as const) {
      if (key === undefined) delete process.env[name];
      else process.env[name] = key;
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("tool_result と agent_end に繋がっている（繋ぎ目こそが対策の本体）", () => {
    const pi = fakePi();
    installed = installWorkKeep(pi);

    assert.ok(pi.handlers.has("tool_result"), [...pi.handlers.keys()].join(", "));
    assert.ok(pi.handlers.has("agent_end"), [...pi.handlers.keys()].join(", "));
  });

  it("ターンの終わり（agent_end）で実際にコミットが増える", () => {
    const pi = fakePi();
    installed = installWorkKeep(pi);
    assert.ok(installed);
    fs.writeFileSync(path.join(repo, "職人の途中.txt"), "書きかけ\n");

    pi.handlers.get("agent_end")!({});

    assert.equal(installed.keptCount(), 1);
    assert.match(installed.branch, /^banto\/keep\/banto\/task-0103\/.*-pi$/u);
    assert.equal(git(repo, ["show", `refs/heads/${installed.branch}:職人の途中.txt`]), "書きかけ\n");
  });

  it("道具を使った直後にも撮れる（tool_result・間隔が過ぎていれば）", async () => {
    const pi = fakePi();
    installed = installWorkKeep(pi);
    assert.ok(installed);
    fs.writeFileSync(path.join(repo, "途中.txt"), "1\n");

    // 起動直後は間隔（1秒）が過ぎていないので撮らない
    pi.handlers.get("tool_result")!({});
    assert.equal(installed.keptCount(), 0);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    pi.handlers.get("tool_result")!({});
    assert.equal(installed.keptCount(), 1);
  });

  it("止めてあれば拡張は何も載せない", () => {
    process.env[KEEP_ENABLED_ENV] = "0";
    const pi = fakePi();

    installed = installWorkKeep(pi);

    assert.equal(installed, undefined);
    assert.equal(pi.handlers.size, 0);
  });

  it("拡張の実体がその場所にある（パスを返すだけで載らない、を防ぐ）", () => {
    assert.ok(fs.existsSync(workKeepExtensionPath()), workKeepExtensionPath());
  });
});

// ── pi 経路: 工房が全職人に載せること ───────────────────────────────────────

/** 実プロセスを起こす偽ドライバ（生存確認が本物の pid に対して働くように）。 */
class FakeDriver implements RuntimeDriver {
  spawned: SpawnOptions[] = [];
  private counter = 0;
  private children: childProcess.ChildProcess[] = [];

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    this.spawned.push(opts);
    this.counter++;
    fs.mkdirSync(path.dirname(opts.sessionPath), { recursive: true });
    fs.writeFileSync(opts.sessionPath, "");
    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore", detached: false });
    this.children.push(child);
    return { pid: child.pid as number, sessionId: `fake-${this.counter}`, sessionPath: opts.sessionPath };
  }

  async inject(): Promise<void> {}
  subscribe(_handler: DriverEventHandler): () => void {
    return () => {};
  }
  async kill(): Promise<void> {}

  cleanup(): void {
    for (const child of this.children) {
      if (child.pid !== undefined && !child.killed) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // 既に終わっていれば何もしない
        }
      }
    }
    this.children = [];
  }
}

describe("[work-keep/pi] 取り置きは全職人に載る", () => {
  let driver: FakeDriver;
  let pool: WorkerPool;
  let poolDir: string;

  beforeEach(() => {
    poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-keep-"));
    driver = new FakeDriver();
    pool = new WorkerPool({ driver, dataDir: poolDir, defaultProjectTag: "test" });
  });

  afterEach(() => {
    driver.cleanup();
    fs.rmSync(poolDir, { recursive: true, force: true });
  });

  const JOB = { taskId: "task-0103", worktreePath: "/tmp/wt", instruction: "調べて直して" };

  it("報告先も network も無い職人にも載る（守るのは機構であって作法ではない）", async () => {
    await pool.delegate(JOB);
    const paths = (driver.spawned[0]!.driverOptions?.["extensionPaths"] ?? []) as string[];

    assert.ok(
      paths.some((p) => p.includes("work-keep")),
      `取り置きの拡張が載っていない: ${paths.join(", ")}`
    );
  });

  it("起動元の拡張も退避も潰さない", async () => {
    await pool.delegate({ ...JOB, driverOptions: { extensionPaths: ["/tmp/kobo-executor.ts"] } });
    const paths = (driver.spawned[0]!.driverOptions?.["extensionPaths"] ?? []) as string[];

    assert.ok(paths.some((p) => p.endsWith("/tmp/kobo-executor.ts")));
    assert.ok(paths.some((p) => p.includes("tool-offload")));
    assert.ok(paths.some((p) => p.includes("work-keep")));
  });
});

// ── pi 経路: 実プロセスで載ること ───────────────────────────────────────────

/**
 * **本物の pi に載って、本当に発火するところまで**見る。
 *
 * 偽の pi で `tool_result` に繋がっていることは確かめたが、それは「こちらが正しく呼べば
 * 動く」までしか言っていない。拡張が pi に読み込まれない（既定 export の形が違う・
 * 起動時に例外を投げる）と、繋ぎ目の試験は全部通ったまま職人の成果は1つも残らない
 * ——これが task-0102 で起きた形である。だから実プロセスを1回だけ起こす。
 *
 * 間隔（`BANTO_WORKER_KEEP_INTERVAL`）を1秒に縮めて、タイマーで撮れることまで見る。
 * `PI_OFFLINE=1` なので LLM は呼ばない（imp-0005 の実プロセス試験と同じ作り）。
 */
describe("[work-keep/pi] 実プロセスで拡張が載ること", () => {
  it("本物の pi に載って、未コミットの成果が枝に残る", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "banto-keep-real-pi-"));
    const repo = path.join(tmp, "wt");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "職人"]);
    git(repo, ["config", "user.email", "worker@example.invalid"]);
    fs.writeFileSync(path.join(repo, "README.md"), "初期\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "初期化"]);
    // 職人が書きかけで手を止めた状態
    fs.writeFileSync(path.join(repo, "書きかけ.ts"), "export const 途中 = 1;\n");

    const prev = {
      offline: process.env["PI_OFFLINE"],
      interval: process.env[KEEP_INTERVAL_ENV],
      enabled: process.env[KEEP_ENABLED_ENV],
    };
    process.env["PI_OFFLINE"] = "1";
    process.env[KEEP_INTERVAL_ENV] = "1000";
    delete process.env[KEEP_ENABLED_ENV];

    let branch = "";
    try {
      const driver = new PiRpcDriver({ sessionBaseDir: path.join(tmp, "sessions") });
      const handle = await driver.spawn({
        taskId: "task-0103",
        worktreePath: repo,
        sessionPath: path.join(tmp, "sessions", "real.jsonl"),
        systemPrompt: "",
        tools: [],
        driverOptions: { projectTag: "banto", extensionPaths: [workKeepExtensionPath()] },
      });
      try {
        const deadline = Date.now() + 20_000;
        while (branch.length === 0 && Date.now() < deadline) {
          branch = git(repo, ["branch", "--list", `${KEEP_BRANCH_PREFIX}/*`, "--format=%(refname:short)"]).trim();
          if (branch.length === 0) await new Promise<void>((r) => setTimeout(r, 100));
        }
      } finally {
        await driver.kill(handle.sessionId);
      }
    } finally {
      for (const [value, name] of [
        [prev.offline, "PI_OFFLINE"],
        [prev.interval, KEEP_INTERVAL_ENV],
        [prev.enabled, KEEP_ENABLED_ENV],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    try {
      assert.ok(branch.length > 0, "本物の pi では取り置きが1枚も撮れなかった（拡張が載っていない）");
      assert.match(branch, /^banto\/keep\/banto\/task-0103\/.*-pi$/u);
      assert.equal(git(repo, ["log", "-1", "--format=%an", `refs/heads/${branch}`]).trim(), KEEPER_NAME);
      assert.equal(
        git(repo, ["show", `refs/heads/${branch}:書きかけ.ts`]),
        "export const 途中 = 1;\n"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ══ 経路2: Claude Agent SDK ══════════════════════════════════════════════════

/** `buildHostOptions` に渡す最小の起動指定。 */
const HOST_CONFIG = {
  sessionFile: "/tmp/session.jsonl",
  model: "claude-opus-5",
  systemPrompt: "職人である",
  tools: [],
  network: false,
  settingSources: ["project"] as ("user" | "project" | "local")[],
};

/** フックを SDK と同じ呼び方で叩く。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK の HookInput は種類が多く、
// ここで必要なのは hook_event_name と最低限の欄だけ。全体を組み立てる意味が無い (I4)
async function fire(hooks: any, event: string, input: Record<string, unknown>): Promise<void> {
  const matchers = hooks?.[event] ?? [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      await hook({ hook_event_name: event, ...input }, undefined, {
        signal: new AbortController().signal,
      });
    }
  }
}

describe("[work-keep/claude] Claude Agent SDK 経路の職人に載って、実際に発火する", () => {
  let repo: string;
  let keep: ReturnType<typeof createClaudeWorkKeep>;

  const ENV = { BANTO_PROJECT: "banto", BANTO_TASK_ID: "task-0103", [KEEP_INTERVAL_ENV]: "1000" };

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    keep?.keeper.stop("manual");
    keep = undefined;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("PostToolUse と Stop に繋がっている（繋ぎ目こそが対策の本体）", () => {
    keep = createClaudeWorkKeep(ENV, repo, "session-1");
    assert.ok(keep);

    assert.equal(keep.hooks.PostToolUse.length, 1);
    assert.equal(keep.hooks.Stop.length, 1);
  });

  it("ターンの終わり（Stop）で実際にコミットが増える", async () => {
    keep = createClaudeWorkKeep(ENV, repo, "session-1");
    assert.ok(keep);
    fs.writeFileSync(path.join(repo, "職人の途中.txt"), "書きかけ\n");

    await fire(keep.hooks, "Stop", {});

    assert.equal(keep.keeper.keptCount(), 1);
    assert.match(keep.branch, /^banto\/keep\/banto\/task-0103\/.*-claude-agent$/u);
    assert.equal(git(repo, ["show", `refs/heads/${keep.branch}:職人の途中.txt`]), "書きかけ\n");
    // 名乗り（session）も本文に載る
    assert.match(git(repo, ["log", "-1", "--format=%B", `refs/heads/${keep.branch}`]), /session: session-1/u);
  });

  it("道具を使った直後にも撮れる（PostToolUse・間隔が過ぎていれば）", async () => {
    keep = createClaudeWorkKeep(ENV, repo, "session-1");
    assert.ok(keep);
    fs.writeFileSync(path.join(repo, "途中.txt"), "1\n");

    await fire(keep.hooks, "PostToolUse", { tool_name: "Write", tool_input: {}, tool_response: {} });
    assert.equal(keep.keeper.keptCount(), 0);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fire(keep.hooks, "PostToolUse", { tool_name: "Write", tool_input: {}, tool_response: {} });
    assert.equal(keep.keeper.keptCount(), 1);
  });

  it("止めてあれば器ごと作らない", () => {
    assert.equal(createClaudeWorkKeep({ ...ENV, [KEEP_ENABLED_ENV]: "0" }, repo), undefined);
  });

  // ── 繋ぎ目: query() の options に載ること ─────────────────────────────────

  it("buildHostOptions が hooks に載せる（ホストが渡すのと同じ実体）", () => {
    keep = createClaudeWorkKeep(ENV, repo, "session-1");
    const options = buildHostOptions({ config: HOST_CONFIG, cwd: repo, sessionId: "s", reported: false, workKeep: keep });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Options["hooks"] は
    // HookEvent 全種の Partial。ここで見たいのは2つだけなので添字で取る (I4)
    const hooks = options.hooks as any;
    assert.equal(hooks?.PostToolUse?.length, 1);
    assert.equal(hooks?.Stop?.length, 1);
  });

  it("退避（task-0102）と同じ PostToolUse を分け合っても、互いを消さない", async () => {
    keep = createClaudeWorkKeep(ENV, repo, "session-1");
    const offload = createClaudeToolOffload({ ...ENV, BANTO_WORKER_OFFLOAD_DIR: path.join(repo, "..", "offload") });
    const options = buildHostOptions({
      config: HOST_CONFIG,
      cwd: repo,
      sessionId: "s",
      reported: false,
      offload,
      workKeep: keep,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
    const hooks = options.hooks as any;
    // 2つの器のフックが両方載っている（片方が上書きしていない）
    assert.equal(hooks?.PostToolUse?.length, 2);
    assert.equal(hooks?.Stop?.length, 1);

    // 実際に叩いても両方効く：退避は栞を返し、取り置きはコミットを増やす
    fs.writeFileSync(path.join(repo, "途中.txt"), "1\n");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fire(hooks, "PostToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
      tool_response: { type: "text", file: { filePath: "/tmp/x", content: "あ".repeat(4000) } },
    });
    assert.equal(keep!.keeper.keptCount(), 1);
    assert.ok(fs.existsSync(path.join(repo, "..", "offload")));
  });

  it("取り置きが無くても退避は載る（片方だけの起動でも壊れない）", () => {
    const offload = createClaudeToolOffload({ ...ENV, BANTO_WORKER_OFFLOAD_DIR: path.join(repo, "..", "offload2") });
    const options = buildHostOptions({ config: HOST_CONFIG, cwd: repo, sessionId: "s", reported: false, offload });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
    const hooks = options.hooks as any;
    assert.equal(hooks?.PostToolUse?.length, 1);
    assert.equal(hooks?.Stop, undefined);
  });

  it("どちらも無ければ hooks を載せない", () => {
    const options = buildHostOptions({ config: HOST_CONFIG, cwd: repo, sessionId: "s", reported: false });
    assert.equal(options.hooks, undefined);
  });
});

// ══ 両経路が同じ中核を使っていること ════════════════════════════════════════

/**
 * **片方だけになっていないこと**を、器ではなく結果で押さえる。
 *
 * task-0102 の穴は「器の試験は全部通っていたのに、片方の経路には1行も効いていなかった」。
 * だから、pi と Claude Agent SDK のそれぞれの入口から起こした職人が、**同じ形の枝に
 * 同じ打ち手で成果を残す**ことをここで並べて確かめる。片方を消せばここが落ちる。
 */
describe("[work-keep] 両経路が同じ機構で守られる", () => {
  let piRepo: string;
  let claudeRepo: string;
  let cwdBefore: string;
  let saved: Record<string, string | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 経路ごとに戻り値の形が違う (I4)
  const stops: Array<() => any> = [];

  beforeEach(() => {
    piRepo = initRepo();
    claudeRepo = initRepo();
    cwdBefore = process.cwd();
    saved = {
      project: process.env["BANTO_PROJECT"],
      task: process.env["BANTO_TASK_ID"],
      interval: process.env[KEEP_INTERVAL_ENV],
    };
    process.env["BANTO_PROJECT"] = "banto";
    process.env["BANTO_TASK_ID"] = "task-0103";
    process.env[KEEP_INTERVAL_ENV] = "1000";
  });

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    process.chdir(cwdBefore);
    for (const [key, name] of [
      [saved["project"], "BANTO_PROJECT"],
      [saved["task"], "BANTO_TASK_ID"],
      [saved["interval"], KEEP_INTERVAL_ENV],
    ] as const) {
      if (key === undefined) delete process.env[name];
      else process.env[name] = key;
    }
    fs.rmSync(piRepo, { recursive: true, force: true });
    fs.rmSync(claudeRepo, { recursive: true, force: true });
  });

  it("どちらの経路の職人も、無報告で手を止めた瞬間の成果が枝に残る", async () => {
    // pi 経路
    process.chdir(piRepo);
    const pi = fakePi();
    const piKeeper = installWorkKeep(pi);
    assert.ok(piKeeper, "pi 経路に取り置きが載っていない");
    stops.push(() => piKeeper.stop("manual"));
    fs.writeFileSync(path.join(piRepo, "成果.txt"), "pi の職人が書いた\n");
    pi.handlers.get("agent_end")!({});

    // Claude Agent SDK 経路
    const keep = createClaudeWorkKeep(process.env, claudeRepo, "session-c");
    assert.ok(keep, "claude-agent 経路に取り置きが載っていない");
    stops.push(() => keep.keeper.stop("manual"));
    fs.writeFileSync(path.join(claudeRepo, "成果.txt"), "claude の職人が書いた\n");
    await fire(keep.hooks, "Stop", {});

    // 同じ形で残る：枝の頭・打ち手・中身
    for (const [repo, branch, runtime, body] of [
      [piRepo, piKeeper.branch, PI_KEEP_RUNTIME, "pi の職人が書いた\n"],
      [claudeRepo, keep.branch, CLAUDE_KEEP_RUNTIME, "claude の職人が書いた\n"],
    ] as const) {
      assert.ok(branch.startsWith(`${KEEP_BRANCH_PREFIX}/banto/task-0103/`), branch);
      assert.ok(branch.endsWith(`-${runtime}`), branch);
      assert.equal(git(repo, ["log", "-1", "--format=%an", `refs/heads/${branch}`]).trim(), KEEPER_NAME);
      assert.equal(git(repo, ["show", `refs/heads/${branch}:成果.txt`]), body);
    }
  });
});

// ══ (F) 番頭が取り置きを見つけられること ═════════════════════════════════════

/**
 * **取り置きは「在るのに誰も気づけない」ものになってはいけない。**
 *
 * 機構が成果を守っても、番頭がそれを知る経路が無ければ守っていないのと同じ。
 * 実装が全部あったのに一度も発火しなかった「触れる環境」と同じ形の穴なので、
 * ここで押さえるのは **①枝を数え上げられること ②番頭の道具として届くこと** の2つ。
 */
describe("[work-keep/F] 取り置きを見つけられる", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** 取り置きを1本作る（撮った枚数を n 枚にする）。 */
  function makeKeep(
    identity: { projectTag: string; taskId: string; runtime: string },
    startedAt: Date,
    shots = 1
  ): WorktreeKeeper {
    const keeper = new WorktreeKeeper({
      cwd: repo,
      identity,
      intervalMs: 0,
      branch: keepBranchName(identity, startedAt),
      indexFile: path.join(repo, "..", `keep-${identity.taskId}-${identity.runtime}.index`),
      onError: () => undefined,
    });
    for (let i = 0; i < shots; i++) {
      fs.writeFileSync(path.join(repo, `${identity.taskId}-${identity.runtime}.txt`), `${i}\n`);
      keeper.snapshot("interval");
    }
    return keeper;
  }

  it("枝の名前をほどいて「誰の・いつの・どのランタイムか」を返す", () => {
    makeKeep({ projectTag: "banto", taskId: "task-0103", runtime: "claude-agent" }, new Date("2026-08-14T10:15:30Z"), 2);

    const found = listKeepBranches(repo);

    assert.equal(found.length, 1);
    const info = found[0]!;
    assert.equal(info.projectTag, "banto");
    assert.equal(info.taskId, "task-0103");
    assert.equal(info.runtime, "claude-agent");
    assert.equal(info.startedAt, "2026-08-14T10:15:30Z");
    assert.equal(info.keptCount, 2);
    assert.equal(info.commit, git(repo, ["rev-parse", `refs/heads/${info.branch}`]).trim());
  });

  it("タスク・プロジェクトで絞れる", () => {
    makeKeep({ projectTag: "banto", taskId: "task-0103", runtime: "pi" }, new Date("2026-08-14T10:00:00Z"));
    makeKeep({ projectTag: "banto", taskId: "task-0104", runtime: "pi" }, new Date("2026-08-14T11:00:00Z"));
    makeKeep({ projectTag: "other", taskId: "task-0103", runtime: "pi" }, new Date("2026-08-14T12:00:00Z"));

    assert.deepEqual(
      listKeepBranches(repo, { taskId: "task-0103" }).map((i) => i.projectTag).sort(),
      ["banto", "other"]
    );
    assert.equal(listKeepBranches(repo, { projectTag: "banto" }).length, 2);
    assert.equal(listKeepBranches(repo, { projectTag: "banto", taskId: "task-0104" }).length, 1);
  });

  it("新しい順に返す（番頭が最初に見たいのは直近の取り残し）", () => {
    makeKeep({ projectTag: "banto", taskId: "old", runtime: "pi" }, new Date("2026-08-01T00:00:00Z"));
    makeKeep({ projectTag: "banto", taskId: "new", runtime: "pi" }, new Date("2026-08-14T00:00:00Z"));

    const found = listKeepBranches(repo);
    assert.equal(found.length, 2);
    assert.ok(found[0]!.lastKeptAt >= found[1]!.lastKeptAt);
  });

  it("この機構の形にほどけない名前は数えない（消しもしない）", () => {
    makeKeep({ projectTag: "banto", taskId: "task-0103", runtime: "pi" }, new Date("2026-08-14T10:00:00Z"));
    // 人が手で作った、頭だけ同じ枝
    git(repo, ["update-ref", `refs/heads/${KEEP_BRANCH_PREFIX}/手で作った`, "HEAD"]);
    git(repo, ["update-ref", `refs/heads/${KEEP_BRANCH_PREFIX}/a/b/よくわからない形`, "HEAD"]);

    assert.equal(listKeepBranches(repo).length, 1);
    assert.equal(parseKeepBranch("banto/keep/a/b/c"), undefined);
    assert.equal(parseKeepBranch("feature/なにか"), undefined);
    assert.equal(parseKeepBranch("banto/keep/p/t/20260814T101530Z-pi")?.runtime, "pi");
  });

  it("取り置きが1本も無ければ空（「読めない」と混同しない）", () => {
    assert.deepEqual(listKeepBranches(repo), []);
  });
});

describe("[work-keep/F] 番頭の道具として届く", () => {
  let repo: string;
  let poolDir: string;
  let driver: FakeDriver;
  let pool: WorkerPool;

  beforeEach(() => {
    repo = initRepo();
    poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-keeps-"));
    driver = new FakeDriver();
    pool = new WorkerPool({ driver, dataDir: poolDir, defaultProjectTag: "banto" });
  });

  afterEach(() => {
    driver.cleanup();
    fs.rmSync(poolDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** 職人を1人起こして、その worktree に取り置きを作る。 */
  async function delegateWithKeep(taskId: string): Promise<string> {
    await pool.delegate({ taskId, worktreePath: repo, instruction: "やって" });
    const identity = { projectTag: "banto", taskId, runtime: "claude-agent" };
    const keeper = new WorktreeKeeper({
      cwd: repo,
      identity,
      intervalMs: 0,
      branch: keepBranchName(identity, new Date("2026-08-14T10:15:30Z")),
      indexFile: path.join(poolDir, `${taskId}.index`),
      onError: () => undefined,
    });
    fs.writeFileSync(path.join(repo, `${taskId}.txt`), "書きかけ\n");
    keeper.snapshot("turn_end");
    return keeper.branch;
  }

  it("職人の作業場所からリポジトリを見つけて数え上げる", async () => {
    const branch = await delegateWithKeep("task-0103");

    const found = pool.keeps({ taskId: "task-0103" });

    assert.equal(found.length, 1);
    assert.equal(found[0]!.branch, branch);
  });

  it("同じリポジトリを2人の職人から2度数えない（別々のワークツリーでも）", async () => {
    await delegateWithKeep("task-0103");
    // 2人目は**同じリポジトリの別のワークツリー**で働く（現場では普通のこと）。
    // 取り置き枝は共有の `.git` にあるので、素直に数えると同じものが2度返る
    const second = path.join(repo, "..", `${path.basename(repo)}-wt2`);
    git(repo, ["worktree", "add", "-q", "-b", "task-0104", second]);
    try {
      await pool.delegate({ taskId: "task-0104", worktreePath: second, instruction: "やって" });

      const found = pool.keeps();
      assert.equal(found.length, 1, found.map((i) => i.branch).join(" / "));
    } finally {
      git(repo, ["worktree", "remove", "--force", second]);
    }
  });

  it("worker.keeps が中身と「どう見るか」を返す", async () => {
    const branch = await delegateWithKeep("task-0103");
    const keeps = createWorkerTools(pool).find((t) => t.name === "worker.keeps")!;

    const result = await keeps.execute({ taskId: "task-0103" }, {} as never);

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, new RegExp(branch.replace(/\//gu, "\\/"), "u"));
    assert.match(text, /claude-agent/u);
    assert.match(text, /git log -p /u);
    assert.equal((result.details as { keeps: unknown[] }).keeps.length, 1);
  });

  it("取り置きが無いときは「無い」と言う（黙って空を返さない）", async () => {
    await pool.delegate({ taskId: "task-0999", worktreePath: repo, instruction: "やって" });
    const keeps = createWorkerTools(pool).find((t) => t.name === "worker.keeps")!;

    const result = await keeps.execute({ taskId: "task-0999" }, {} as never);

    assert.match((result.content[0] as { text: string }).text, /取り置きはありません/u);
  });

  it("番頭に提示される（在庫にあってもモデルには見えない、を防ぐ）", () => {
    assert.ok(
      PRESENTED_TOOL_NAMES.includes("worker.keeps"),
      "worker.keeps が提示一覧に無い＝番頭からは存在しないのと同じ"
    );
    assert.ok(
      createWorkerTools(pool).some((t) => t.name === "worker.keeps"),
      "提示一覧にあるのに在庫に無い"
    );
  });
});

/**
 * **並びはリポジトリを跨いでも「新しい順」**。
 *
 * `listKeepBranches` は降順に並べるが、それは**1本のリポジトリの中の話**。工房が複数の
 * リポジトリを見に行くとき、素直に連結すると「repo1 の中では降順・repo2 の中でも降順、
 * でも全体では順不同」になる。
 *
 * ここを押さえるのは、番頭の知らせ（`kobo-notice.ts`）が**先頭だけを読んで**
 * 「そこまでの作業はこの枝に残っています」と案内するから。順が崩れると**いちばん古い枝を
 * 案内する**——`f56c43e` で一度直したのと同じ間違いが、多プロジェクト構成で再発する。
 */
describe("[work-keep/F] 並びはリポジトリを跨いでも新しい順", () => {
  let repos: string[];
  let poolDir: string;
  let driver: FakeDriver;
  let pool: WorkerPool;

  beforeEach(() => {
    repos = [];
    poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-keeps-order-"));
    driver = new FakeDriver();
    pool = new WorkerPool({ driver, dataDir: poolDir, defaultProjectTag: "banto" });
  });

  afterEach(() => {
    driver.cleanup();
    fs.rmSync(poolDir, { recursive: true, force: true });
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
  });

  /** 別々のリポジトリで職人を1人起こし、時刻を指定した取り置きを1本残す。 */
  async function delegateWithKeepAt(taskId: string, at: string): Promise<string> {
    const repo = initRepo();
    repos.push(repo);
    await pool.delegate({ taskId, worktreePath: repo, instruction: "やって" });
    const branch = keepBranchName({ projectTag: "banto", taskId, runtime: "pi" }, new Date(at));
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const commit = execFileSync(
      "git",
      ["commit-tree", tree, "-p", head, "-m", `${KEEP_SUBJECT_PREFIX} ${taskId} の途中経過 #1（interval）`],
      {
        cwd: repo,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: KEEPER_NAME,
          GIT_AUTHOR_EMAIL: KEEPER_EMAIL,
          GIT_COMMITTER_NAME: KEEPER_NAME,
          GIT_COMMITTER_EMAIL: KEEPER_EMAIL,
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_DATE: at,
        },
      }
    ).trim();
    git(repo, ["update-ref", `refs/heads/${branch}`, commit]);
    return branch;
  }

  it("2つのリポジトリにまたがっても、全体として新しい順で返る", async () => {
    // **古い方を先に起こす。** 走査するリポジトリの順は職人を起こした順に従うので、
    // 連結しただけだと古い枝が先頭に来る
    const older = await delegateWithKeepAt("task-old", "2026-08-01T00:00:00Z");
    const newer = await delegateWithKeepAt("task-new", "2026-08-14T00:00:00Z");

    const found = pool.keeps();

    assert.deepEqual(
      found.map((i) => i.branch),
      [newer, older],
      "リポジトリを跨ぐと降順が崩れている（先頭が最新でない）"
    );
    // 番頭が読むのは先頭だけ。ここが最新でないと、いちばん古い枝を案内することになる
    assert.equal(found[0]!.branch, newer);
  });

  it("worker.keeps の返りも同じ並び（番頭が読むのはこちら）", async () => {
    const older = await delegateWithKeepAt("task-old", "2026-08-01T00:00:00Z");
    const newer = await delegateWithKeepAt("task-new", "2026-08-14T00:00:00Z");
    const keeps = createWorkerTools(pool).find((t) => t.name === "worker.keeps")!;

    const result = await keeps.execute({}, {} as never);

    assert.deepEqual(
      (result.details as { keeps: { branch: string }[] }).keeps.map((i) => i.branch),
      [newer, older]
    );
  });
});

// ══ (G) 溜まり続ける取り置きの始末 ═══════════════════════════════════════════

describe("[work-keep/G] 期限を過ぎた取り置きを消す", () => {
  let repo: string;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** 取り置きを1本作って、その枝名を返す。 */
  function makeKeep(taskId: string, runtime = "pi"): string {
    const identity = { projectTag: "banto", taskId, runtime };
    const keeper = new WorktreeKeeper({
      cwd: repo,
      identity,
      intervalMs: 0,
      branch: keepBranchName(identity, new Date("2026-08-14T10:15:30Z")),
      indexFile: path.join(repo, "..", `prune-${taskId}-${runtime}.index`),
      onError: () => undefined,
    });
    fs.writeFileSync(path.join(repo, `${taskId}.txt`), "書きかけ\n");
    keeper.snapshot("interval");
    return keeper.branch;
  }

  /** 枝が残っているか。 */
  function exists(branch: string): boolean {
    try {
      git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  it("30日より古いものを消し、新しいものは残す", () => {
    const old = makeKeep("task-old");
    const fresh = makeKeep("task-fresh");
    // 「古い」を作るのは時計の側（コミット日時を捏造しない）
    const lastKeptAt = Date.parse(listKeepBranches(repo).find((i) => i.branch === old)!.lastKeptAt);

    const result = pruneKeepBranches({
      repo,
      maxAgeMs: 30 * DAY,
      now: lastKeptAt + 31 * DAY,
      // task-fresh だけ守る（実際の「新しい」は時刻で決まるので、ここでは protect で分ける）
      protect: (info) => info.branch === fresh,
    });

    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0]!.branch, old);
    assert.equal(exists(old), false);
    assert.equal(exists(fresh), true);
  });

  it("期限内のものには触らない", () => {
    const branch = makeKeep("task-0103");
    const lastKeptAt = Date.parse(listKeepBranches(repo)[0]!.lastKeptAt);

    const result = pruneKeepBranches({ repo, maxAgeMs: 30 * DAY, now: lastKeptAt + 29 * DAY });

    assert.equal(result.removed.length, 0);
    assert.equal(result.kept, 1);
    assert.equal(exists(branch), true);
  });

  it("取り置き以外の枝には一切触らない", () => {
    makeKeep("task-0103");
    git(repo, ["update-ref", "refs/heads/feature/大事な作業", "HEAD"]);
    git(repo, ["update-ref", `refs/heads/${KEEP_BRANCH_PREFIX}/手で作った`, "HEAD"]);

    pruneKeepBranches({ repo, maxAgeMs: 1, now: Date.now() + 365 * DAY });

    assert.equal(exists("feature/大事な作業"), true, "関係の無い枝を消した");
    assert.equal(exists(`${KEEP_BRANCH_PREFIX}/手で作った`), true, "形がほどけない枝を消した");
    assert.equal(exists("main"), true);
  });

  it("まだ動いている職人の取り置きは守る（消さない側に倒す）", () => {
    const branch = makeKeep("task-0103");

    const result = pruneKeepBranches({
      repo,
      maxAgeMs: 1,
      now: Date.now() + 365 * DAY,
      protect: (info) => info.taskId === "task-0103",
    });

    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.why, /まだ動いている職人/u);
    assert.equal(exists(branch), true);
  });

  it("見たあとに動いた枝は消さない（間に職人がもう1枚撮った）", () => {
    const branch = makeKeep("task-0103");
    const real = createGitRunner(repo);
    // 「掃除が見たあと・消す前」に職人が撮った1枚
    const moved = real([
      "commit-tree",
      real(["rev-parse", "HEAD^{tree}"]).trim(),
      "-m",
      "職人がもう1枚撮った",
    ]).trim();

    let interleaved = false;
    const raceGit: GitRunner = (args, env) => {
      if (args[0] === "update-ref" && args[1] === "-d" && !interleaved) {
        interleaved = true;
        real(["update-ref", `refs/heads/${branch}`, moved]);
      }
      return real(args, env);
    };

    const result = pruneKeepBranches({ repo, maxAgeMs: 1, now: Date.now() + 365 * DAY, git: raceGit });

    assert.ok(interleaved, "そもそも消しに行っていない");
    assert.equal(result.removed.length, 0, "動いたあとの枝を消した＝職人の1枚を捨てた");
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.why, /消せなかった/u);
    assert.equal(exists(branch), true);
    assert.equal(git(repo, ["rev-parse", `refs/heads/${branch}`]).trim(), moved);
  });

  it("下見（dryRun）では消さない", () => {
    const branch = makeKeep("task-0103");

    const result = pruneKeepBranches({ repo, maxAgeMs: 1, now: Date.now() + 365 * DAY, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.removed.length, 1);
    assert.equal(exists(branch), true, "下見なのに消した");
  });

  it("消す前に記録する（途中で落ちても「何を消そうとしたか」が残る）", () => {
    const branch = makeKeep("task-0103");
    const commit = git(repo, ["rev-parse", `refs/heads/${branch}`]).trim();
    const records: Record<string, unknown>[] = [];
    /** 記録が呼ばれた時点で枝がまだ在ったか（＝本当に「消す前」か）。 */
    const stillThere: boolean[] = [];

    pruneKeepBranches({
      repo,
      maxAgeMs: 1,
      now: Date.parse("2026-09-30T00:00:00Z"),
      record: (entry) => {
        records.push(entry);
        if (entry["event"] === "keep_prune_planned") stillThere.push(exists(branch));
      },
    });

    const planned = records.find((r) => r["event"] === "keep_prune_planned");
    assert.ok(planned, "消す前の記録が無い");
    assert.equal(planned["count"], 1);
    // **順番が本体**：記録した時点ではまだ消えていないこと
    assert.deepEqual(stillThere, [true], "記録より先に消していた（落ちたら何も残らない）");
    assert.equal(records[0]!["event"], "keep_prune_planned");
    // コミットの名前が残っている＝git がオブジェクトを捨てるまでは戻せる
    assert.match(JSON.stringify(planned["branches"]), new RegExp(commit, "u"));
    assert.ok(records.some((r) => r["event"] === "keep_prune_done"));
    assert.equal(exists(branch), false);
  });

  it("期限を切ってあれば何もしない", () => {
    const branch = makeKeep("task-0103");

    const result = pruneKeepBranches({ repo, maxAgeMs: 0, now: Date.now() + 365 * DAY });

    assert.equal(result.scanned, 0);
    assert.equal(result.removed.length, 0);
    assert.equal(exists(branch), true);
  });

  it("期限の既定は30日。環境変数で変えられる（0 以下で掃除しない）", () => {
    assert.equal(DEFAULT_KEEP_MAX_AGE_DAYS, 30);
    assert.equal(resolveKeepMaxAgeMs({}), 30 * DAY);
    assert.equal(resolveKeepMaxAgeMs({ [KEEP_MAX_AGE_ENV]: "7" }), 7 * DAY);
    assert.equal(resolveKeepMaxAgeMs({ [KEEP_MAX_AGE_ENV]: "0" }), 0);
    assert.equal(resolveKeepMaxAgeMs({ [KEEP_MAX_AGE_ENV]: "-1" }), 0);
    assert.equal(resolveKeepMaxAgeMs({ [KEEP_MAX_AGE_ENV]: "なんだこれ" }), 30 * DAY);
  });
});

describe("[work-keep/G] 工房が自分で掃除する（誰も呼ばない、にしない）", () => {
  let repo: string;
  let poolDir: string;
  let driver: FakeDriver;
  let pool: WorkerPool;
  let savedMaxAge: string | undefined;

  beforeEach(() => {
    repo = initRepo();
    poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-prune-"));
    driver = new FakeDriver();
    pool = new WorkerPool({ driver, dataDir: poolDir, defaultProjectTag: "banto" });
    savedMaxAge = process.env[KEEP_MAX_AGE_ENV];
  });

  afterEach(() => {
    driver.cleanup();
    if (savedMaxAge === undefined) delete process.env[KEEP_MAX_AGE_ENV];
    else process.env[KEEP_MAX_AGE_ENV] = savedMaxAge;
    fs.rmSync(poolDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** 取り置きを1本作る。 */
  function makeKeep(taskId: string): string {
    const identity = { projectTag: "banto", taskId, runtime: "pi" };
    const keeper = new WorktreeKeeper({
      cwd: repo,
      identity,
      intervalMs: 0,
      branch: keepBranchName(identity, new Date("2026-08-14T10:15:30Z")),
      indexFile: path.join(poolDir, `${taskId}.index`),
      onError: () => undefined,
    });
    fs.writeFileSync(path.join(repo, `${taskId}.txt`), "書きかけ\n");
    keeper.snapshot("interval");
    return keeper.branch;
  }

  /**
   * 本当に古い取り置きを1本作る（コミット日時を過去にする）。
   *
   * 自動掃除は `Date.now()` で動く——時計を差し替える口を通らないので、**枝の側を
   * 本当に古くしないと自動の道は試せない**。
   */
  function makeOldKeep(taskId: string, daysAgo: number): string {
    const branch = keepBranchName(
      { projectTag: "banto", taskId, runtime: "pi" },
      new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    );
    const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const commit = execFileSync(
      "git",
      ["commit-tree", tree, "-p", head, "-m", `${KEEP_SUBJECT_PREFIX} ${taskId} の途中経過 #1（interval）`],
      {
        cwd: repo,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: KEEPER_NAME,
          GIT_AUTHOR_EMAIL: KEEPER_EMAIL,
          GIT_COMMITTER_NAME: KEEPER_NAME,
          GIT_COMMITTER_EMAIL: KEEPER_EMAIL,
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_DATE: at,
        },
      }
    ).trim();
    git(repo, ["update-ref", `refs/heads/${branch}`, commit]);
    return branch;
  }

  it("職人を起こすと、期限を過ぎた取り置きが自動で消える（誰も呼ばない、にしない）", async () => {
    const old = makeOldKeep("task-old", 40);
    const fresh = makeKeep("task-fresh");
    // まだ職人を起こしていないので、リポジトリは名指しで渡す
    assert.equal(pool.keeps({ repoPath: repo }).length, 2);

    // 既定（30日）のまま。職人を起こすだけで掃除が走る
    delete process.env[KEEP_MAX_AGE_ENV];
    await pool.delegate({ taskId: "task-new", worktreePath: repo, instruction: "やって" });

    const left = pool.keeps().map((i) => i.branch);
    assert.equal(left.includes(old), false, "40日前の取り置きが残っている＝自動掃除が走っていない");
    assert.equal(left.includes(fresh), true, "期限内の取り置きまで消した");
  });

  it("掃除を切ってあれば、職人を起こしても消えない", async () => {
    const old = makeOldKeep("task-old", 40);
    process.env[KEEP_MAX_AGE_ENV] = "0";

    await pool.delegate({ taskId: "task-new", worktreePath: repo, instruction: "やって" });

    assert.equal(pool.keeps().some((i) => i.branch === old), true);
  });

  it("掃除は記録に残る（黙って消えた、にしない）", () => {
    makeKeep("task-old");

    pool.pruneKeeps({ repoPath: repo, maxAgeMs: 1, now: Date.parse("2026-09-30T00:00:00Z") });

    const logPath = path.join(poolDir, KEEP_PRUNE_LOG);
    assert.ok(fs.existsSync(logPath), `${logPath} が無い`);
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(events.some((e) => e["event"] === "keep_prune_planned"));
    assert.ok(events.some((e) => e["event"] === "keep_prune_done"));
  });

  it("動いている職人の取り置きは、工房の掃除でも守られる", async () => {
    await pool.delegate({ taskId: "task-alive", worktreePath: repo, instruction: "やって" });
    const branch = makeKeep("task-alive");

    const result = pool.pruneKeeps({ repoPath: repo, maxAgeMs: 1, now: Date.now() + 365 * 24 * 60 * 60 * 1000 });

    assert.equal(result.flatMap((r) => r.removed).length, 0);
    assert.match(result.flatMap((r) => r.skipped)[0]!.why, /まだ動いている職人/u);
    assert.equal(pool.keeps().some((i) => i.branch === branch), true);
  });

  it("掃除が失敗しても職人は起きる（掃除のために起こせないのは本末転倒）", async () => {
    // git の無いところを作業場所にする＝掃除は何も出来ない
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-plain-"));
    try {
      const worker = await pool.delegate({ taskId: "task-0103", worktreePath: plain, instruction: "やって" });
      assert.equal(worker.taskId, "task-0103");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
