/**
 * task-0102: 退避＋栞を **Claude Agent SDK 経路にも**載せる。
 *
 * task-0090 で職人にも退避を入れたが、載せ方が pi の言葉だった——工房は
 * `extensionPaths` に拡張のパスを積むだけで、claude-agent ドライバはそれを読まない。
 * 実運用の職人はほぼ全部 Claude Agent SDK 経路なので、**対策は実質効いていなかった**。
 * 器（`ToolResultOffloader`）の試験は全部通っていたのに、である——だから ここで押さえるのは
 * **繋ぎ目**（`query()` の options にフックが載ること）と、**形を保った差し替え**の2つ。
 *
 * 本物の Claude は呼ばない（認証と課金の前提を試験に混ぜない・P6）。フックは
 * `buildHostOptions` が返した options から取り出して直に叩く——ホストが渡すのと同じ実体である。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CLAUDE_OFFLOAD_DIALECT,
  CLAUDE_WORKER_OFFLOAD_PROMPT,
  DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS,
  OFFLOAD_DIR_ENV,
  OFFLOAD_ENABLED_ENV,
  OFFLOAD_THRESHOLD_ENV,
  PI_OFFLOAD_DIALECT,
  READBACK_MAX_CHARS,
  ToolResultOffloader,
  WORKER_OFFLOAD_PROMPT,
  buildHostOptions,
  createClaudeToolOffload,
  resolveOffloadDir,
  resolveThresholdChars,
} from "@banto/worker-pool";

let dir: string;
let offloader: ToolResultOffloader;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-claude-offload-"));
  offloader = new ToolResultOffloader({
    dir: path.join(dir, "offload"),
    dialect: CLAUDE_OFFLOAD_DIALECT,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const BIG = `# 見出しA\n${"あ".repeat(3000)}\n## 見出しB\n${"い".repeat(3000)}`;

/**
 * `Read` のツール結果の実物の形（2026-08-13 に実機で確かめた）。
 *
 * 平文の文字列ではない——ここを取り違えると Claude Code は差し替えを黙って捨てる。
 */
function readOutput(filePath: string, content: string): unknown {
  return {
    type: "text",
    file: {
      filePath,
      content,
      numLines: content.split("\n").length,
      startLine: 1,
      totalLines: content.split("\n").length,
    },
  };
}

/** 差し替え後の `file.content`。 */
function contentOf(output: unknown): string {
  const file = (output as { file?: { content?: unknown } }).file;
  return typeof file?.content === "string" ? file.content : "";
}

// ── a1: 長いツール結果は文脈に載らない ──────────────────────────────────────

describe("[task-0102/a1] claude-agent 経路でも長いツール結果は栞に置き換わる", () => {
  it("本文が文脈に残らない", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/docs/big.md" },
      output: readOutput("/repo/docs/big.md", BIG),
    });

    assert.ok(patch, "大きい結果は差し替えられなければならない");
    const text = contentOf(patch.output);
    assert.doesNotMatch(text, /あああああ/u, "本文が文脈に残ってはいけない");
    assert.ok(text.length < 1000, `栞が大きすぎる（${text.length}字）`);
  });

  it("**50KB 級でも**文脈に載るのは栞だけ（task-0089 で踏んだ大きさ）", () => {
    const huge = "x".repeat(50_000);
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/big.log" },
      output: readOutput("/repo/big.log", huge),
    });

    const text = contentOf(patch?.output);
    assert.ok(text.length < 1000, `50KB がほぼそのまま入っている（${text.length}字）`);
    assert.ok((text.match(/x/gu) ?? []).length < 400, "本文がまとめて残っている");
  });

  it("栞には出所・大きさ・見出しが載る（中身の当たりが付く）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/docs/big.md" },
      output: readOutput("/repo/docs/big.md", BIG),
    });
    const text = contentOf(patch?.output);

    assert.match(text, /Read/u, "どの Tool の出力か");
    assert.match(text, /docs\/big\.md/u, "何を渡して得た結果か");
    assert.match(text, /6,0\d\d字/u, "元の大きさ");
    assert.match(text, /# 見出しA/u);
    assert.match(text, /## 見出しB/u);
  });

  it("短い結果はそのまま通る（余計な間接を増やさない）", () => {
    assert.equal(
      offloader.applyToOutput({
        toolName: "Bash",
        input: { command: "git status" },
        output: { stdout: "clean", stderr: "", interrupted: false },
      }),
      undefined
    );
  });

  it("ちょうど閾値までは通す（境目で挙動が入れ替わる）", () => {
    // 器の中の短い文字列（filePath 等）も文字数に数えるので、本文だけの器で測る
    const at = "あ".repeat(DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS);
    assert.equal(offloader.applyToOutput({ toolName: "Bash", output: at }), undefined);
    assert.ok(
      offloader.applyToOutput({ toolName: "Bash", output: `${at}あ` }),
      "1字超えたら退避する"
    );
  });

  it("Tool ごとの形を知らなくても効く（Bash の stdout も退避される）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Bash",
      input: { command: "cat big.log" },
      output: { stdout: BIG, stderr: "", interrupted: false, isImage: false },
    });

    assert.ok(patch);
    const out = patch.output as { stdout: string; stderr: string; interrupted: boolean };
    assert.doesNotMatch(out.stdout, /あああああ/u, "長い stdout は退避する");
    assert.match(out.stdout, /全文はここに残っている/u);
    assert.equal(out.stderr, "", "短い葉は触らない");
  });

  it("報告経路（mcp__banto__*）は退避しない", () => {
    assert.equal(
      offloader.applyToOutput({
        toolName: "mcp__banto__report",
        output: [{ type: "text", text: BIG }],
      }),
      undefined
    );
  });
});

// ── 形を保つこと（ここが崩れると Claude Code は差し替えを黙って捨てる）──────

describe("[task-0102/a1] 差し替えは Tool の出力の形を保つ", () => {
  it("器のキーと型がそのまま残る（平文の文字列にしない）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/docs/big.md" },
      output: readOutput("/repo/docs/big.md", BIG),
    });

    assert.ok(patch);
    const output = patch.output as {
      type: string;
      file: { filePath: string; content: string; numLines: number; startLine: number };
    };
    assert.equal(typeof patch.output, "object", "平文の文字列にすると出力スキーマ検証で捨てられる");
    assert.equal(output.type, "text");
    assert.equal(output.file.filePath, "/repo/docs/big.md", "出所は残す");
    assert.equal(typeof output.file.content, "string");
    assert.equal(typeof output.file.numLines, "number", "数値の葉は触らない");
    assert.equal(output.file.startLine, 1);
  });

  it("元のオブジェクトを書き換えない（呼び出し元の持ち物を壊さない）", () => {
    const output = readOutput("/repo/docs/big.md", BIG);
    offloader.applyToOutput({ toolName: "Read", input: { file_path: "/x" }, output });

    assert.equal(contentOf(output), BIG, "渡された側の中身が消えている");
  });

  it("MCP の内容ブロック（配列）でも形を保つ", () => {
    const patch = offloader.applyToOutput({
      toolName: "mcp__other__query",
      output: [
        { type: "text", text: BIG },
        { type: "image", data: "...", mimeType: "image/png" },
      ],
    });

    assert.ok(patch);
    const blocks = patch.output as Array<{ type: string; text?: string }>;
    assert.equal(blocks.length, 2, "画像のブロックを落とさない");
    assert.equal(blocks[1]?.type, "image");
    assert.doesNotMatch(blocks[0]?.text ?? "", /あああああ/u);
  });

  it("退避したのは長い葉だけ（短い葉は1文字も変えない）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Grep",
      output: { mode: "content", numFiles: 3, content: BIG, numLines: 42 },
    });

    assert.ok(patch);
    const out = patch.output as { mode: string; numFiles: number; content: string; numLines: number };
    assert.equal(out.mode, "content");
    assert.equal(out.numFiles, 3);
    assert.equal(out.numLines, 42);
    assert.match(out.content, /全文はここに残っている/u);
  });
});

// ── a2: 情報は失われない（職人が Read で読み返せる）──────────────────────────

describe("[task-0102/a2] 退避は可逆——職人が Read で読み返せる", () => {
  it("退避した全文が1文字も変わらずファイルに残る", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/docs/big.md" },
      output: readOutput("/repo/docs/big.md", BIG),
    });
    const filePath = /全文はここに残っている: (\S+)/u.exec(contentOf(patch?.output))?.[1];

    assert.ok(filePath, "栞に退避先のパスが無い");
    assert.equal(fs.readFileSync(filePath, "utf-8"), BIG, "1文字も変えずに残っていること");
  });

  it("栞に書く読み返し方は **Claude の言葉**（Read / file_path / Grep）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/docs/big.md" },
      output: readOutput("/repo/docs/big.md", BIG),
    });
    const text = contentOf(patch?.output);

    assert.match(text, /Read\(\{ file_path: "\/.+", offset, limit \}\)/u, "Read の呼び方が要る");
    assert.match(text, /Grep/u, "語で絞る手立ても添える");
    assert.match(text, /文脈に載せていない/u, "消えたのではないと分かること");
    assert.doesNotMatch(text, /read\(\{ path:/u, "pi の言葉のままでは職人が呼べない");
  });

  it("読み返しは再退避しない（読んだ先がまた栞では読めない）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/docs/big.md" },
      output: readOutput("/repo/docs/big.md", BIG),
    });
    const filePath = /全文はここに残っている: (\S+)/u.exec(contentOf(patch?.output))?.[1] as string;

    const back = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: filePath },
      output: readOutput(filePath, "# 見出しA\n本文の一部"),
    });
    assert.equal(back, undefined, "読み返しは素通しでよい（既に上限内）");
  });

  it("読み返しにも上限がある（1回の Read で全部戻せない）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/repo/big.log" },
      output: readOutput("/repo/big.log", "あ".repeat(50_000)),
    });
    const filePath = /全文はここに残っている: (\S+)/u.exec(contentOf(patch?.output))?.[1] as string;

    const back = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: filePath },
      output: readOutput(filePath, "あ".repeat(50_000)),
    });
    const text = contentOf(back?.output);

    assert.ok(text.length < READBACK_MAX_CHARS + 200, `一度に戻しすぎ（${text.length}字）`);
    assert.match(text, /以降は省略/u);
    assert.match(text, /offset/u, "続きの読み方を書く");
  });

  it("退避先の外の Read は普通に退避される（読み返しの免除を広げすぎない）", () => {
    const patch = offloader.applyToOutput({
      toolName: "Read",
      input: { file_path: "/etc/hosts" },
      output: readOutput("/etc/hosts", BIG),
    });
    assert.ok(patch, "退避先の外なら退避する");
  });
});

// ── a4: pi 経路と揃っていること ─────────────────────────────────────────────

describe("[task-0102/a4] 閾値・退避先・栞は pi 経路と揃う", () => {
  it("閾値も退避先も同じ環境変数・同じ既定（経路で職人の体験が変わらない）", () => {
    assert.equal(resolveThresholdChars({}), DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS);
    assert.equal(resolveThresholdChars({ [OFFLOAD_THRESHOLD_ENV]: "500" }), 500);
    assert.equal(resolveOffloadDir({ [OFFLOAD_DIR_ENV]: "/var/tmp/x" }, 1), "/var/tmp/x");
    assert.equal(
      resolveOffloadDir({ BANTO_TASK_ID: "task-0102" }, 7),
      path.join(os.tmpdir(), "banto-worker-offload", "task-0102-7")
    );
  });

  it("同じ本文なら栞の中身は道具の名前を除いて同じ（判断が1つである証し）", () => {
    const pi = new ToolResultOffloader({ dir: path.join(dir, "pi"), dialect: PI_OFFLOAD_DIALECT });
    const piText = (pi.apply({ toolName: "t", input: { a: 1 }, content: [{ type: "text", text: BIG }] })
      ?.content[0] as { text: string }).text;
    // 器を持たない結果（生の文字列）は、そのまま栞へ置き換わる
    const claudeText = offloader.applyToOutput({ toolName: "t", input: { a: 1 }, output: BIG })
      ?.output as string;

    const normalize = (text: string): string =>
      text
        .replace(/\/[^\s]*t-\d+-t\.txt/gu, "<file>")
        .replace(/read\(\{ path:/u, "READ(")
        .replace(/Read\(\{ file_path:/u, "READ(")
        .replace(/ ／ 語で絞るなら (grep|Grep)/u, " ／ 語で絞るなら GREP");

    assert.equal(normalize(claudeText), normalize(piText));
  });

  it("職人に渡す作法も同じ中身で、道具の名前だけ違う", () => {
    assert.match(CLAUDE_WORKER_OFFLOAD_PROMPT, /Read\(\{ file_path, offset, limit \}\)/u);
    assert.match(CLAUDE_WORKER_OFFLOAD_PROMPT, /Do not re-run the same tool/u);
    assert.match(WORKER_OFFLOAD_PROMPT, /read\(\{ path, offset, limit \}\)/u, "pi 側は変えない");
    assert.equal(
      CLAUDE_WORKER_OFFLOAD_PROMPT.split("\n").length,
      WORKER_OFFLOAD_PROMPT.split("\n").length
    );
  });
});

// ── 繋ぎ目：ホストが渡す options にフックが載ること ──────────────────────────

/**
 * **ここが task-0102 の本体。** 器がいくら正しくても、`query()` に渡らなければ
 * 職人の文脈は1文字も変わらない——task-0090 はまさにそれで効いていなかった。
 */
describe("[task-0102/a3] ホストが渡す options に退避が載っている", () => {
  const CONFIG = {
    sessionFile: "/tmp/x.jsonl",
    model: "sonnet",
    systemPrompt: "お前は職人だ",
    tools: [],
    network: false,
    settingSources: [] as ("user" | "project" | "local")[],
  };

  let saved: Record<string, string | undefined>;
  let hookDir: string;

  beforeEach(() => {
    hookDir = path.join(dir, "hook");
    saved = {
      [OFFLOAD_DIR_ENV]: process.env[OFFLOAD_DIR_ENV],
      [OFFLOAD_ENABLED_ENV]: process.env[OFFLOAD_ENABLED_ENV],
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("PostToolUse に繋がっていて、叩くと栞が返る（モデルへ渡るのは栞だけ）", async () => {
    const offload = createClaudeToolOffload({ [OFFLOAD_DIR_ENV]: hookDir }, 1);
    assert.ok(offload);

    const options = buildHostOptions({
      config: CONFIG,
      cwd: "/repo",
      sessionId: "s-1",
      reported: true,
      offload,
    });

    const matchers = options.hooks?.PostToolUse;
    assert.ok(matchers && matchers.length === 1, "PostToolUse に繋いでいない");
    const hook = matchers[0]?.hooks[0];
    assert.ok(hook, "フックの実体が無い");

    // ホストが渡すのと同じ実体を、SDK と同じ形の入力で叩く
    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        transcript_path: "/tmp/x.jsonl",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/docs/big.md" },
        tool_response: readOutput("/repo/docs/big.md", BIG),
        tool_use_id: "toolu_1",
      },
      "toolu_1",
      { signal: new AbortController().signal }
    );

    const specific = (result as { hookSpecificOutput?: { updatedToolOutput?: unknown } })
      .hookSpecificOutput;
    assert.ok(specific, "updatedToolOutput を返していない＝全文がそのままモデルへ渡る");
    const text = contentOf(specific.updatedToolOutput);
    assert.doesNotMatch(text, /あああああ/u, "本文がモデルへ渡ってしまう");
    assert.match(text, /全文はここに残っている/u);
    assert.equal(typeof specific.updatedToolOutput, "object", "形を保っていないと黙って捨てられる");
  });

  it("短い結果には何も返さない（余計な間接を増やさない）", async () => {
    const offload = createClaudeToolOffload({ [OFFLOAD_DIR_ENV]: hookDir }, 1);
    const hook = offload?.hooks.PostToolUse[0]?.hooks[0];
    assert.ok(hook);

    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        transcript_path: "/tmp/x.jsonl",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_response: { stdout: "clean", stderr: "", interrupted: false },
        tool_use_id: "toolu_2",
      },
      "toolu_2",
      { signal: new AbortController().signal }
    );

    assert.deepEqual(result, {}, "短い結果まで差し替えない");
  });

  it("職人には「何が起きるか」を先に伝える（取り直しを誘わない）", () => {
    const offload = createClaudeToolOffload({ [OFFLOAD_DIR_ENV]: hookDir }, 1);
    const options = buildHostOptions({
      config: CONFIG,
      cwd: "/repo",
      sessionId: "s-1",
      reported: true,
      offload,
    });

    const prompt = options.systemPrompt as { append?: string };
    assert.match(prompt.append ?? "", /お前は職人だ/u, "立場を潰さない");
    assert.match(prompt.append ?? "", /Long tool results are offloaded/u);
    assert.match(prompt.append ?? "", /Read\(\{ file_path, offset, limit \}\)/u);
  });

  it("切ってあれば何も載せない（切り分けの逃げ道は pi と同じ）", () => {
    assert.equal(createClaudeToolOffload({ [OFFLOAD_ENABLED_ENV]: "0" }, 1), undefined);

    const options = buildHostOptions({
      config: CONFIG,
      cwd: "/repo",
      sessionId: "s-1",
      reported: true,
      offload: undefined,
    });
    assert.equal(options.hooks, undefined);
    assert.doesNotMatch((options.systemPrompt as { append?: string }).append ?? "", /offloaded/u);
  });

  it("退避先は職人ごと（環境変数が効き、実ファイルがそこに残る）", async () => {
    const offload = createClaudeToolOffload({ [OFFLOAD_DIR_ENV]: hookDir }, 1);
    assert.equal(offload?.directory, hookDir);
    const hook = offload?.hooks.PostToolUse[0]?.hooks[0];
    assert.ok(hook);

    await hook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        transcript_path: "/tmp/x.jsonl",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/docs/big.md" },
        tool_response: readOutput("/repo/docs/big.md", BIG),
        tool_use_id: "toolu_3",
      },
      "toolu_3",
      { signal: new AbortController().signal }
    );

    assert.deepEqual(fs.readdirSync(hookDir), ["t-0001-Read.txt"]);
    assert.equal(fs.readFileSync(path.join(hookDir, "t-0001-Read.txt"), "utf-8"), BIG);
  });

  it("報告経路の作法・道具立ての約束は変えない（options の他の中身を壊さない）", () => {
    const offload = createClaudeToolOffload({ [OFFLOAD_DIR_ENV]: hookDir }, 1);
    const options = buildHostOptions({
      config: { ...CONFIG, tools: ["Read", "Grep"], network: false },
      cwd: "/repo",
      sessionId: "s-1",
      reported: true,
      offload,
    });

    assert.deepEqual(options.tools, ["Read", "Grep"]);
    assert.deepEqual(options.disallowedTools, ["WebFetch", "WebSearch"]);
    assert.equal(options.model, "sonnet");
    assert.equal(options.cwd, "/repo");
    assert.equal((options as { sessionId?: string }).sessionId, "s-1");
  });
});
