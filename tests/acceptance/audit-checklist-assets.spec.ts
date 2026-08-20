/**
 * [AC-S75f66b-3-2] 監査セッションのシステムプロンプトと監査チェックリストは
 * 層Aプロンプト資産（skills/）ファイルから読み込まれ、基準の変更がgit差分として見える。
 *
 * 検証内容:
 *   - skills/audit-system.md が存在する
 *   - skills/audit-checklist.md が存在する
 *   - loadPromptAsset("audit-system") がファイルの内容を返す
 *   - loadPromptAsset("audit-checklist") がファイルの内容を返す
 *   - CHECK-MARKER-42 をチェックリストに追加すると spawn 時のプロンプトに含まれる
 *     (CaptureDriver で systemPrompt を確認)
 *
 * Entry point: HTTP API (story_type=api, Rule 2 — daemon accepts real HTTP audit spawn).
 * D2: criteria in text (files), mechanism in code (loadPromptAsset).
 *
 * Scenario: scenario-2-api
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { loadPromptAsset } from "../../packages/banto-core/src/index.js";
import type {
  RuntimeDriver,
  SpawnOptions,
  SessionHandle,
  DriverEventHandler,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const checklistPath = path.join(repoRoot, "skills", "audit-checklist.md");
const systemPromptPath = path.join(repoRoot, "skills", "audit-system.md");

// ── CaptureDriver ─────────────────────────────────────────────────────────────

interface CaptureRecord {
  opts: SpawnOptions;
  pid: number;
  sessionId: string;
}

class CaptureDriver implements RuntimeDriver {
  readonly spawned: CaptureRecord[] = [];
  private readonly sessions = new Map<string, { pid: number; proc: childProcess.ChildProcess }>();
  private readonly handlers: Set<DriverEventHandler> = new Set();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("CaptureDriver: failed to get pid");
    const sessionId = `capture-${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid, proc });
    proc.once("exit", (code, signal) => {
      const ev: DriverEvent = { type: "process_exited", pid, sessionId, exitCode: code, signal };
      for (const h of this.handlers) { try { h(ev); } catch { /* ignore */ } }
      this.sessions.delete(sessionId);
    });
    const startEv: DriverEvent = { type: "process_started", pid, sessionId, sessionPath: opts.sessionPath };
    for (const h of this.handlers) { try { h(startEv); } catch { /* ignore */ } }
    this.spawned.push({ opts, pid, sessionId });
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(_sessionId: string, _message: string): Promise<void> { /* no-op */ }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  async kill(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try { process.kill(s.pid, "SIGTERM"); } catch { /* already dead */ }
  }

  async killAll(): Promise<void> {
    for (const [sid] of this.sessions) { await this.kill(sid); }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

// ── Poll helper ────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => T,
  pred: (v: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = fn();
  }
  return last;
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

// ── Suite 1: Layer-A asset presence tests ─────────────────────────────────────

describe("[AC-S75f66b-3-2] Audit prompt assets are layer-A text files (skills/ directory)", () => {
  it("[AC-S75f66b-3-2] skills/audit-system.md exists at repo root", () => {
    assert.ok(
      fs.existsSync(systemPromptPath),
      `skills/audit-system.md must exist at ${systemPromptPath}`
    );
  });

  it("[AC-S75f66b-3-2] skills/audit-checklist.md exists at repo root", () => {
    assert.ok(
      fs.existsSync(checklistPath),
      `skills/audit-checklist.md must exist at ${checklistPath}`
    );
  });

  it("[AC-S75f66b-3-2] loadPromptAsset('audit-system') returns non-empty content from file", () => {
    const content = loadPromptAsset("audit-system");
    assert.ok(content.length > 0, "audit-system prompt must be non-empty");
    // Verify it contains audit-related content
    const hasAuditRole =
      content.includes("監査") ||
      content.includes("audit") ||
      content.includes("audit_report");
    assert.ok(hasAuditRole, "audit-system must contain audit role description");
  });

  it("[AC-S75f66b-3-2] loadPromptAsset('audit-checklist') returns non-empty content from file", () => {
    const content = loadPromptAsset("audit-checklist");
    assert.ok(content.length > 0, "audit-checklist must be non-empty");
    // Verify content includes checklist items
    const hasChecklist =
      content.includes("acceptance") ||
      content.includes("チェック") ||
      content.includes("- [");
    assert.ok(hasChecklist, "audit-checklist must contain checklist items");
  });

  it("[AC-S75f66b-3-2] loadPromptAsset reads from disk (not hardcoded)", () => {
    const fileContent = fs.readFileSync(checklistPath, "utf-8");
    const loaded = loadPromptAsset("audit-checklist");
    assert.equal(loaded, fileContent, "loadPromptAsset must return the exact file contents");
  });
});

// ── [a8] 監査は合否の門ではなく補助の目である、という位置づけ ─────────────────────
//
// task-0287・ADR-0027: 監査からテスト実行を剥がし、見るのを diff と受け入れ基準の
// 対応に絞った。この転換が skills/ 資産の文面そのものにも書かれていることを縛る
// ——文面が古いままだと、指示文だけ変えても監査人の自己像（system prompt）が
// 「合否の門」のままになり、次に読む人が迷う。

describe("[a8] skills/audit-system.md が「監査は補助の目」の位置づけで書かれている", () => {
  it("合否の門ではなく補助の目である、と明記されている", () => {
    const content = loadPromptAsset("audit-system");
    assert.match(
      content,
      /advisory|補助の目/,
      "監査が補助の目であることが書かれていない"
    );
  });

  it("見るのは diff と受け入れ基準の対応であって、コードベース全体の健全性ではない、と書かれている", () => {
    const content = loadPromptAsset("audit-system");
    assert.match(content, /diff/);
    assert.match(
      content,
      /not the health of the\s+codebase|コードベース全体の健全性ではない/,
      "見る範囲が diff と受け入れ基準の対応に絞られていない"
    );
  });

  it("テストを回すのは監査人の仕事ではない、と明記されている", () => {
    const content = loadPromptAsset("audit-system");
    assert.match(
      content,
      /[Nn]ever running the test suite|テストを回すのはあなたの仕事ではありません/,
      "テストを回さないことが書かれていない"
    );
  });
});

describe("[a8] skills/audit-checklist.md が「監査は補助の目」の位置づけで書かれている", () => {
  it("合否の門ではなく補助の目である、と明記されている", () => {
    const content = loadPromptAsset("audit-checklist");
    assert.match(content, /補助の目/, "監査が補助の目であることが書かれていない");
  });

  it("見るのは diff と受け入れ基準の対応である、と明記されている", () => {
    const content = loadPromptAsset("audit-checklist");
    assert.match(
      content,
      /diff.*受け入れ基準|受け入れ基準.*diff/,
      "見る範囲が diff と受け入れ基準の対応だと書かれていない"
    );
  });

  it("検証コマンドを回すこと・全体を読むことを前提にした項目が無い", () => {
    const content = loadPromptAsset("audit-checklist");
    assert.ok(
      !/その結果が正常か/.test(content),
      "検証コマンドの実行結果を確認する項目が残っている——マージ前ゲートの担当のはず"
    );
    assert.match(
      content,
      /検証コマンド.*回すのはあなたの仕事ではありません|回すのはあなたの仕事ではありません/,
      "検証コマンドを回さないことが明記されていない"
    );
  });
});

// ── Suite 2: CHECK-MARKER-42 propagation test ──────────────────────────────────
//
// **経路がもう一度変わった**（realign 第2便・段1）。
//
// 前は banto-auditor 拡張が pi の `before_agent_start` でチェックリストを読み、
// システムプロンプトに載せていた。だがその拡張は `driverOptions.extensionPaths`＝
// **pi の言葉**で渡っており、**Claude Agent SDK の職人はそれを読まない**
// （`claude-agent/tool-offload.ts` に同じ形の記録がある）。実運用の監査人はほぼ全て
// SDK 経路なので、**基準は監査人に一度も届いていなかった**——この試験は pi 拡張を
// 直に呼んでいたため、届いていないことを捕まえられなかった。
//
// いまは **Kobo が指示文に載せて渡す**（`buildAuditInstruction`）。経路に依らず届き、
// `audit_verdict.checklistVersion` に刻む指紋が「実際に渡した中身」と一致する。
// だからここで見るのも指示文になる。拡張が担うのは役の説明（audit-system）だけ。

describe("[AC-S75f66b-3-2] Checklist edit propagates to the audit agent", () => {
  let originalChecklist: string;

  before(() => {
    originalChecklist = fs.readFileSync(checklistPath, "utf-8");
    function restoreChecklist(): void {
      try { fs.writeFileSync(checklistPath, originalChecklist); } catch { /* best-effort */ }
    }
    process.once("exit", restoreChecklist);
    process.once("SIGTERM", () => { restoreChecklist(); process.exit(143); });
    process.once("SIGINT", () => { restoreChecklist(); process.exit(130); });

    fs.writeFileSync(checklistPath, originalChecklist + "\nCHECK-MARKER-42\n");
  });

  after(() => {
    fs.writeFileSync(checklistPath, originalChecklist);
  });

  it("[AC-S75f66b-3-2] scenario-2-api step-1: CHECK-MARKER-42 が監査人に届く（経路に依らず）", async () => {
    // 拡張は環境変数から自分の宛先を読む。読めないと I2 で投げる
    const savedProject = process.env["BANTO_PROJECT"];
    const savedTask = process.env["BANTO_TASK_ID"];
    process.env["BANTO_PROJECT"] = "proj-checklist-marker";
    // 職人の識別子には役目の接尾辞が付く（決定60）。拡張はここを外して Kobo に返す
    process.env["BANTO_TASK_ID"] = "task-checklist-1:audit";

    try {
      const { default: auditorExtension } = await import(
        "../../packages/banto-daemon/src/pi-extension/banto-auditor.js"
      );

      const hooks = new Map<string, (event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string }>();
      const registered: Array<{ name: string }> = [];
      auditorExtension({
        registerTool(tool: { name: string }) { registered.push(tool); },
        on(name: string, handler: (event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string }) {
          hooks.set(name, handler);
        },
      });

      // 監査人は audit_report を持つ（これが無いと判定を返せない）
      assert.ok(
        registered.some((t) => t.name === "audit_report"),
        `audit_report が登録されること。登録されたのは: ${JSON.stringify(registered.map((t) => t.name))}`
      );

      const hook = hooks.get("before_agent_start");
      assert.ok(hook, "before_agent_start フックが登録されること（ここで観点を載せる）");

      // 拡張が載せるのは**役の説明**（audit-system）。基準はここではない
      const { systemPrompt } = hook!({ systemPrompt: "（ランタイムの既定）" }, undefined);
      assert.ok(
        systemPrompt.includes("auditor agent"),
        `拡張は役の説明を載せること。冒頭: ${systemPrompt.slice(0, 200)}`
      );

      // **基準は Kobo が指示文で渡す。** ここが pi・Agent SDK の両方に効く唯一の経路
      const { buildAuditInstruction } = await import(
        "../../packages/banto-daemon/src/daemon.js"
      );
      const instruction = buildAuditInstruction(
        { id: "task-checklist-1", status: "auditing", projectTag: "proj-checklist-marker", title: "t" },
        "proj-checklist-marker",
        "task-checklist-1",
        "/tmp/wt"
      );
      assert.ok(
        instruction.includes("CHECK-MARKER-42"),
        "監査人へ渡す指示文に skills/audit-checklist.md の中身が入ること" +
          "（ファイルから読む——D2。**pi 拡張だけに載せると SDK 経路の監査人に届かない**）"
      );
    } finally {
      if (savedProject === undefined) delete process.env["BANTO_PROJECT"];
      else process.env["BANTO_PROJECT"] = savedProject;
      if (savedTask === undefined) delete process.env["BANTO_TASK_ID"];
      else process.env["BANTO_TASK_ID"] = savedTask;
    }

    // Also verify checklist file is a plain text file (git-trackable — D2)
    const stat = fs.statSync(checklistPath);
    assert.ok(stat.isFile(), "audit-checklist.md must be a plain file");
    assert.ok(stat.size > 0, "audit-checklist.md must be non-empty");
  });
});
