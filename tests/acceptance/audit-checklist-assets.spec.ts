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

// ── Suite 2: CHECK-MARKER-42 propagation test ──────────────────────────────────

describe("[AC-S75f66b-3-2] Checklist edit propagates to spawned audit session system prompt", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: CaptureDriver;
  let originalChecklist: string;
  const proj = "proj-checklist-marker";
  const taskId = "task-checklist-1";

  before(async () => {
    // F3 (robustness): save original checklist content BEFORE any mutation, then
    // register unconditional SIGTERM/SIGINT handlers so a killed test run cannot
    // leave the repo dirty (the in-process after() hook does not run on SIGKILL,
    // but SIGTERM is sent by node:test on timeout — we catch it here).
    originalChecklist = fs.readFileSync(checklistPath, "utf-8");

    function restoreChecklist(): void {
      try { fs.writeFileSync(checklistPath, originalChecklist); } catch { /* best-effort */ }
    }
    // Register unconditional restore on exit signals (idempotent: safe to call multiple times).
    process.once("exit", restoreChecklist);
    process.once("SIGTERM", () => { restoreChecklist(); process.exit(143); });
    process.once("SIGINT", () => { restoreChecklist(); process.exit(130); });

    // Add marker line to checklist (scenario-2-api step-1)
    fs.writeFileSync(checklistPath, originalChecklist + "\nCHECK-MARKER-42\n");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-audit-checklist-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      reconcileIntervalMs: 99999,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      sessionBaseDir: path.join(tmpDir, "sessions"),
      tmuxSession: "",
    });

    driver = new CaptureDriver();
    daemon.driverRegistry.register("pi-rpc", driver);

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "project must register");
  });

  after(async () => {
    // Unconditional restore: always rewrite the checklist before any other cleanup.
    // This is safe even if the test threw — originalChecklist is the pre-test content.
    fs.writeFileSync(checklistPath, originalChecklist);

    await driver.killAll();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S75f66b-3-2] scenario-2-api step-1: CHECK-MARKER-42 appears in spawned audit session systemPrompt", async () => {
    // Create task and advance to auditing via HTTP (real daemon, real HTTP — Rule 2)
    const createRes = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, title: "Checklist marker test" }),
    });
    assert.equal(createRes.status, 201, "task must be created");

    for (const to of ["queued", "planning", "implementing"]) {
      const r = await fetch(
        `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        }
      );
      assert.equal(r.status, 200, `transition to ${to} must succeed`);
    }

    // Transition to auditing → daemon spawns audit session reading skills/ files
    const auditRes = await fetch(
      `${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "auditing" }),
      }
    );
    assert.equal(auditRes.status, 200, "implementing→auditing must succeed");

    // Wait for spawn to be recorded
    const spawnSeen = await pollUntil(
      () => driver.spawned.length >= 1,
      (seen) => seen,
      5000
    );
    assert.ok(spawnSeen, "CaptureDriver must have recorded an audit session spawn");

    // Verify the spawned audit session's systemPrompt contains CHECK-MARKER-42
    // (read from the file at spawn time, not compiled into code — D2)
    const auditSpawn = driver.spawned[driver.spawned.length - 1];
    assert.ok(auditSpawn, "audit spawn record must exist");
    assert.ok(
      auditSpawn.opts.systemPrompt.includes("CHECK-MARKER-42"),
      `spawned audit session systemPrompt must contain 'CHECK-MARKER-42' (read from skills/audit-checklist.md at spawn time). ` +
      `Prompt preview: ${auditSpawn.opts.systemPrompt.slice(0, 200)}`
    );

    // Also verify checklist file is a plain text file (git-trackable — D2)
    const stat = fs.statSync(checklistPath);
    assert.ok(stat.isFile(), "audit-checklist.md must be a plain file");
    assert.ok(stat.size > 0, "audit-checklist.md must be non-empty");
  });
});
