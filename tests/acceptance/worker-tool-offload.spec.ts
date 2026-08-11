/**
 * task-0090: 職人のツール結果にも退避＋栞を。
 *
 * 確かめるのは「**長いツール結果がモデルへ全文で渡らない**」こと（a1）。番頭には
 * `withArtifactOffload` があるのに職人経路には無く、pi の切り詰め（2000行/50KB）を通った
 * 50KB がそのまま文脈へ入って、その直後の応答が返らなくなる事故が実機で3回続いた
 * （task-0089・deepseek-v4-flash 2回／kimi-k3 1回＝モデル固有ではない）。
 *
 * LLM には繋がない。退避は職人プロセス内の機構で、モデルの振る舞いに依らない。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import {
  ToolResultOffloader,
  DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS,
  OFFLOAD_DIR_ENV,
  OFFLOAD_THRESHOLD_ENV,
  OFFLOAD_ENABLED_ENV,
  READBACK_MAX_CHARS,
  WORKER_OFFLOAD_PROMPT,
  WorkerPool,
  installToolOffload,
  isExemptTool,
  isOffloadEnabled,
  outlineOf,
  resolveOffloadDir,
  resolveThresholdChars,
  toolOffloadExtensionPath,
  type ToolResultLike,
} from "@banto/worker-pool";

let dir: string;
let offloader: ToolResultOffloader;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-worker-offload-"));
  offloader = new ToolResultOffloader({ dir: path.join(dir, "offload") });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** pi の `tool_result` イベントの形（この拡張が見る分だけ）。 */
function toolResult(
  toolName: string,
  text: string,
  input: Record<string, unknown> = {}
): ToolResultLike {
  return { toolName, input, content: [{ type: "text", text }] };
}

function textOf(patch: { content: ReadonlyArray<{ type: string }> } | undefined): string {
  if (!patch) return "";
  return patch.content
    .map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
    .join("\n");
}

const BIG = `# 見出しA\n${"あ".repeat(3000)}\n## 見出しB\n${"い".repeat(3000)}`;

// ── a1: 大きいツール結果は文脈に載らない ────────────────────────────────────

describe("[task-0090/a1] 閾値を超えたツール結果は栞に置き換わる", () => {
  it("本文が文脈に残らない", () => {
    const patch = offloader.apply(toolResult("read", BIG, { path: "docs/big.md" }));

    assert.ok(patch, "大きい結果は差し替えられなければならない");
    const text = textOf(patch);
    assert.doesNotMatch(text, /あああああ/, "本文が文脈に残ってはいけない");
    assert.ok(text.length < 1000, `栞が大きすぎる（${text.length}字）`);
  });

  it("**50KB 級でも**文脈に載るのは栞だけ（pi の切り詰めは 2000行/50KB で足りない）", () => {
    const huge = "x".repeat(50_000);
    const text = textOf(offloader.apply(toolResult("read", huge, { path: "big.log" })));

    // 栞に載るのは先頭の当たり（300字まで）だけ。50KB は文脈に入らない
    assert.ok(text.length < 1000, `50KB がほぼそのまま入っている（${text.length}字）`);
    assert.ok((text.match(/x/gu) ?? []).length < 400, "本文がまとめて残っている");
  });

  it("栞には出所・大きさ・見出しが載る（中身の当たりが付く）", () => {
    const text = textOf(offloader.apply(toolResult("read", BIG, { path: "docs/big.md" })));

    assert.match(text, /read/, "どの Tool の出力か");
    assert.match(text, /docs\/big\.md/, "何を渡して得た結果か");
    assert.match(text, /6,0\d\d字/, "元の大きさ");
    assert.match(text, /# 見出しA/);
    assert.match(text, /## 見出しB/);
  });

  it("小さい結果はそのまま通る（退避が邪魔をしない）", () => {
    assert.equal(offloader.apply(toolResult("bash", "clean", { cmd: "git status" })), undefined);
  });

  it("ちょうど閾値までは通す（境目で挙動が入れ替わる）", () => {
    const at = "あ".repeat(DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS);
    assert.equal(offloader.apply(toolResult("read", at)), undefined);
    assert.ok(offloader.apply(toolResult("read", `${at}あ`)), "1字超えたら退避する");
  });

  it("text 以外のブロック（画像など）は落とさない", () => {
    const patch = offloader.apply({
      toolName: "read",
      input: { path: "a.png" },
      content: [
        { type: "text", text: BIG },
        { type: "image", data: "...", mimeType: "image/png" },
      ],
    });

    assert.ok(patch);
    assert.equal(patch.content.length, 2);
    assert.equal(patch.content[1]!.type, "image");
  });

  it("退避しない Tool（報告経路）は素通し", () => {
    assert.ok(isExemptTool("worker__report"));
    assert.ok(isExemptTool("worker__ask"));
    assert.ok(!isExemptTool("read"));
    assert.equal(offloader.apply(toolResult("worker__report", BIG)), undefined);
  });
});

// ── a2: 情報は失われない（職人が read で読み返せる）──────────────────────────

describe("[task-0090/a2] 退避は可逆——職人が read で読み返せる", () => {
  it("退避した全文が1文字も変わらずファイルに残る", () => {
    const text = textOf(offloader.apply(toolResult("read", BIG, { path: "docs/big.md" })));
    const filePath = /全文はここに残っている: (\S+)/u.exec(text)?.[1];

    assert.ok(filePath, `栞に退避先のパスが無い:\n${text}`);
    assert.equal(fs.readFileSync(filePath, "utf-8"), BIG, "1文字も変えずに残っていること");
  });

  it("栞に read の呼び方（読み返しの手がかり）が書いてある", () => {
    const text = textOf(offloader.apply(toolResult("grep", BIG, { pattern: "あ" })));

    assert.match(text, /read\(\{ path: "\/.+", offset, limit \}\)/u, "read の呼び方が要る");
    assert.match(text, /grep/, "語で絞る手立ても添える");
    assert.match(text, /文脈に載せていない/, "消えたのではないと分かること");
  });

  it("退避先は絶対パス（職人の cwd がどこでも開ける）", () => {
    const text = textOf(offloader.apply(toolResult("read", BIG)));
    const filePath = /全文はここに残っている: (\S+)/u.exec(text)?.[1] ?? "";

    assert.ok(path.isAbsolute(filePath), `絶対パスでない: ${filePath}`);
  });

  it("読み返しは再退避しない（読んだ先がまた栞では読めない）", () => {
    const stub = textOf(offloader.apply(toolResult("read", BIG, { path: "docs/big.md" })));
    const filePath = /全文はここに残っている: (\S+)/u.exec(stub)?.[1] as string;

    // 職人が read で読み返した、の再現。本文が返らなければ a2 は満たされない
    const back = offloader.apply(toolResult("read", "# 見出しA\n本文の一部", { path: filePath }));
    assert.equal(back, undefined, "読み返しは素通しでよい（既に上限内）");
  });

  it("読み返しにも上限がある（1回の read で全部戻せない）", () => {
    const stub = textOf(offloader.apply(toolResult("read", "あ".repeat(50_000))));
    const filePath = /全文はここに残っている: (\S+)/u.exec(stub)?.[1] as string;

    const back = textOf(offloader.apply(toolResult("read", "あ".repeat(50_000), { path: filePath })));
    assert.ok(back.length < READBACK_MAX_CHARS + 200, `一度に戻しすぎ（${back.length}字）`);
    assert.match(back, /以降は省略/);
    assert.match(back, /offset/, "続きの読み方を書く");
  });

  it("退避先の外の read は普通に退避される（読み返しの免除を広げすぎない）", () => {
    const patch = offloader.apply(toolResult("read", BIG, { path: "/etc/hosts" }));
    assert.ok(patch, "退避先の外なら退避する");
  });

  it("番号は既存のファイルから導く（再開しても上書きしない・D3）", () => {
    const first = /全文はここに残っている: (\S+)/u.exec(
      textOf(offloader.apply(toolResult("read", BIG)))
    )?.[1] as string;

    // 別インスタンス＝起こし直した職人が同じ退避先を指した状態
    const reopened = new ToolResultOffloader({ dir: path.join(dir, "offload") });
    const second = /全文はここに残っている: (\S+)/u.exec(
      textOf(reopened.apply(toolResult("read", BIG)))
    )?.[1] as string;

    assert.notEqual(first, second);
    assert.match(path.basename(first), /^t-0001-read\.txt$/u);
    assert.match(path.basename(second), /^t-0002-read\.txt$/u);
    assert.equal(fs.readFileSync(first, "utf-8"), BIG, "1件目が消えていない");
  });
});

// ── a4: 閾値は変えられる・既定は番頭と同じ ──────────────────────────────────

describe("[task-0090/a4] 閾値と退避先の決め方", () => {
  it("既定は番頭と同じ 2000 字", () => {
    assert.equal(DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS, 2000);
    assert.equal(resolveThresholdChars({}), 2000);
  });

  it("環境変数で変えられる", () => {
    assert.equal(resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "500" }), 500);

    const small = new ToolResultOffloader({
      dir: path.join(dir, "offload"),
      thresholdChars: resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "10" }),
    });
    assert.ok(small.apply(toolResult("read", "あ".repeat(11))), "下げた閾値が効く");
  });

  it("読めない値は既定に落とす（0や負で全部を栞にしない・I2）", () => {
    assert.equal(resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "0" }), 2000);
    assert.equal(resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "-1" }), 2000);
    assert.equal(resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "たくさん" }), 2000);
    assert.equal(resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "" }), 2000);
  });

  it("退避先は職人ごとに閉じる（別の職人の観測を踏まない）", () => {
    const a = resolveOffloadDir({ BANTO_TASK_ID: "task-0090" }, 111);
    const b = resolveOffloadDir({ BANTO_TASK_ID: "task-0091" }, 222);

    assert.notEqual(a, b);
    assert.match(a, /task-0090-111$/u);
    assert.ok(path.isAbsolute(a));
  });

  it("退避先も環境変数で変えられる", () => {
    assert.equal(resolveOffloadDir({ [OFFLOAD_DIR_ENV]: "/var/tmp/x" }, 1), "/var/tmp/x");
  });

  it("退避は既定で有効。切りたいときだけ明示的に切る", () => {
    assert.equal(isOffloadEnabled({}), true);
    assert.equal(isOffloadEnabled({ [OFFLOAD_ENABLED_ENV]: "0" }), false);
    assert.equal(isOffloadEnabled({ [OFFLOAD_ENABLED_ENV]: "off" }), false);
    assert.equal(isOffloadEnabled({ [OFFLOAD_ENABLED_ENV]: "1" }), true);
  });
});

// ── 栞の組み立て（要約しない）────────────────────────────────────────────────

describe("[task-0090] 栞は要約しない（機械的に抜けるものだけ）", () => {
  it("Markdown の見出しがあれば見出しを使う", () => {
    assert.equal(outlineOf("# A\n本文\n## B\n本文"), "# A\n## B");
  });

  it("見出しが無ければ先頭の数行を使う", () => {
    assert.equal(outlineOf("一行目\n二行目\n三行目\n四行目"), "一行目\n二行目\n三行目");
  });

  it("見出しが多すぎるときは打ち切る", () => {
    const many = Array.from({ length: 30 }, (_, i) => `# 見出し${i}`).join("\n");
    assert.equal(outlineOf(many).split("\n").length, 12);
  });
});

// ── a1/a3: 全職人に載ること ─────────────────────────────────────────────────

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

describe("[task-0090/a3] 退避は全職人に載る", () => {
  let driver: FakeDriver;
  let pool: WorkerPool;
  let poolDir: string;

  beforeEach(() => {
    poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-offload-"));
    driver = new FakeDriver();
    pool = new WorkerPool({ driver, dataDir: poolDir, defaultProjectTag: "test" });
  });

  afterEach(() => {
    driver.cleanup();
    fs.rmSync(poolDir, { recursive: true, force: true });
  });

  const JOB = { taskId: "task-0090", worktreePath: "/tmp/wt", instruction: "調べて直して" };

  it("報告先も network も無い職人にも載る（載せ忘れた職人だけが穴に落ちる）", async () => {
    await pool.delegate(JOB);
    const paths = (driver.spawned[0]!.driverOptions?.["extensionPaths"] ?? []) as string[];

    assert.ok(
      paths.some((p) => p.includes("tool-offload")),
      `退避の拡張が載っていない: ${paths.join(", ")}`
    );
  });

  it("起動元の拡張を潰さない（Kobo の report_done 等は残る）", async () => {
    await pool.delegate({
      ...JOB,
      driverOptions: { extensionPaths: ["/tmp/kobo-executor.ts"] },
    });
    const paths = (driver.spawned[0]!.driverOptions?.["extensionPaths"] ?? []) as string[];

    assert.ok(paths.some((p) => p.endsWith("/tmp/kobo-executor.ts")));
    assert.ok(paths.some((p) => p.includes("tool-offload")));
  });

  it("拡張の実体がその場所にある（パスを返すだけで載らない、を防ぐ）", () => {
    assert.ok(fs.existsSync(toolOffloadExtensionPath()), toolOffloadExtensionPath());
  });

  it("職人には「何が起きるか」を先に伝える（取り直しを誘わない）", () => {
    assert.match(WORKER_OFFLOAD_PROMPT, /read\(\{ path, offset, limit \}\)/u);
    assert.match(WORKER_OFFLOAD_PROMPT, /Do not re-run the same tool/u);
  });
});

// ── 拡張として動くこと ──────────────────────────────────────────────────────

/**
 * 拡張の入口（default export）そのものを動かす。
 *
 * 中身の器（ToolResultOffloader）が正しくても、`tool_result` に繋いでいなければ職人の文脈は
 * 何も変わらない——**繋ぎ目こそが a1 の本体**なので、そこを素通りさせない。
 */
describe("[task-0090/a1] 拡張として tool_result に繋がっている", () => {
  let extDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-offload-ext-"));
    saved = {
      dir: process.env[OFFLOAD_DIR_ENV],
      threshold: process.env[OFFLOAD_THRESHOLD_ENV],
      enabled: process.env[OFFLOAD_ENABLED_ENV],
    };
    process.env[OFFLOAD_DIR_ENV] = extDir;
    delete process.env[OFFLOAD_THRESHOLD_ENV];
    delete process.env[OFFLOAD_ENABLED_ENV];
  });

  afterEach(() => {
    for (const [key, env] of [
      [saved["dir"], OFFLOAD_DIR_ENV],
      [saved["threshold"], OFFLOAD_THRESHOLD_ENV],
      [saved["enabled"], OFFLOAD_ENABLED_ENV],
    ] as const) {
      if (key === undefined) delete process.env[env];
      else process.env[env] = key;
    }
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  /** pi の代わり。拡張が何に繋いだかを覚えるだけ。 */
  function fakePi(): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の API 形状を真似る (I4)
    on: (event: string, handler: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
    handlers: Map<string, any>;
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
    const handlers = new Map<string, any>();
    return { handlers, on: (event, handler) => handlers.set(event, handler) };
  }

  it("tool_result を差し替え、system prompt に作法を足す", async () => {
    const pi = fakePi();
    installToolOffload(pi);

    assert.ok(pi.handlers.has("tool_result"), "tool_result に繋いでいない");
    const patched = await pi.handlers.get("tool_result")(
      toolResult("read", BIG, { path: "docs/big.md" })
    );
    assert.doesNotMatch(textOf(patched), /あああああ/, "本文がモデルへ渡ってしまう");

    const started = pi.handlers.get("before_agent_start")({ systemPrompt: "元の作法" }, {});
    assert.match(started.systemPrompt, /元の作法/, "既定の作法を潰さない");
    assert.match(started.systemPrompt, /offloaded/);
  });

  it("退避先は環境変数どおり（職人が読み返せる実ファイル）", async () => {
    const pi = fakePi();
    installToolOffload(pi);

    await pi.handlers.get("tool_result")(toolResult("read", BIG, { path: "docs/big.md" }));
    const files = fs.readdirSync(extDir);

    assert.deepEqual(files, ["t-0001-read.txt"]);
    assert.equal(fs.readFileSync(path.join(extDir, files[0] as string), "utf-8"), BIG);
  });

  it("切ってあれば何も繋がない（切り分けの逃げ道）", () => {
    process.env[OFFLOAD_ENABLED_ENV] = "0";
    const pi = fakePi();
    installToolOffload(pi);

    assert.equal(pi.handlers.size, 0);
  });
});
