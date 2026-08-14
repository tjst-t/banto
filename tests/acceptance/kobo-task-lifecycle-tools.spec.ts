/**
 * タスクの**後始末の口**が番頭に届いていること（inc-0063 の5番）。
 *
 *   - `kobo.abandon`   — 二度と動かないタスクを畳む（**どの状態からでも**・PO 裁定 2026-08-14）
 *   - `kobo.supersede` — 積んだタスクを置き換えて降ろす
 *   - `kobo.amend`     — 積んだあとの契約を訂正する
 *
 * この3本は**最初から Kobo の在庫にあった**。無かったのは提示（決定82）だけで、
 * その間ずっと機構は「どうしようもなければ `kobo.abandon` で畳んでください」
 * （`kobo-notice.ts` の `adviceForFailure`・`kobo.task` の失敗欄）と番頭に案内し続けていた。
 * **案内と道具が食い違っていた**のが inc-0063 の 5 番である。在庫だけを確かめるテストでは
 * この事故は防げないので、ここでは**提示の表**も確かめる。
 *
 * 併せて、merging に居座ったタスクに届く口がどれなのかを実機で固定する
 * ——inc-0063 で止血できなかった直接の原因はここだった。
 *
 * story_type=api: 本物の Daemon・本物の git リポジトリ・本物の HTTP。内部は差し替えない（I1）。
 * Tool は番頭が呼ぶのと同じ道（`POST /api/kobo/tools/<名前>`）で叩く。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Daemon, createKoboModule } from "@banto/daemon";
import { selectPresentedTools } from "@banto/host";

/** inc-0063 の5番で提示へ回した3本。名前は番頭がそのまま呼ぶものなので、ここで固定する。 */
const LIFECYCLE_TOOLS = ["kobo.abandon", "kobo.supersede", "kobo.amend"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

async function callTool(
  base: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const res = await fetch(`${base}/api/kobo/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const body = (await res.json()) as ToolResult & { error?: string };
  if (res.status !== 200) {
    throw new Error(body.error ?? `tool ${name} failed with ${res.status}`);
  }
  return body;
}

/** 断られることを期待して叩く。返るのは理由の文字列。 */
async function callToolExpectingRefusal(
  base: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    await callTool(base, name, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`${name} は断るはずが通ってしまいました`);
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (val: T) => boolean,
  timeoutMs = 8000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function statusOf(base: string, proj: string, taskId: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
  if (r.status !== 200) return "";
  return ((await r.json()) as { task: { status: string } }).task.status;
}

/** 帳簿を直に進める（職人も監査も動かさずに、目的の状態まで運ぶための足場）。 */
async function forceTo(base: string, proj: string, taskId: string, to: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, reason: "test-scaffold" }),
  });
  const body = (await res.json()) as { error?: string };
  assert.equal(res.status, 200, `${taskId} を ${to} へ進められること: ${body.error ?? ""}`);
}

function initRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@banto-lifecycle-tools.local");
  git("config", "user.name", "banto-lifecycle-tools-test");
  fs.writeFileSync(path.join(repoDir, "shared.ts"), "// shared\nexport const VERSION = 0;\n");
  git("add", "-A");
  git("commit", "-m", "initial");
}

function writeTaskFile(
  repoDir: string,
  taskId: string,
  title: string,
  /** スコープを分けられるようにする——重ならなければ、複数の札を同時に ready まで運べる */
  scopePath: string = "src/**"
): void {
  const dir = path.join(repoDir, "work", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${taskId}.md`),
    `---
id: ${taskId}
type: task
kind: feature
title: ${title}
status: queued
scope:
  paths: [${scopePath}]
acceptance:
  - { id: a1, text: 動作確認 }
---

## 背景

後始末の口のテスト用。
`,
    "utf-8"
  );
}

async function registerProject(base: string, id: string, repoPath: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, repoPath }),
  });
  assert.equal(res.status, 201, `project ${id} registration must succeed`);
}

// ── 0. 番頭に届くこと ────────────────────────────────────────────────────────

describe("[kobo-task-lifecycle-tools] 後始末の3本が番頭へ配られる", () => {
  const inventory = () => createKoboModule("http://127.0.0.1:1/api/kobo").tools;

  it("Kobo の在庫に3本とも載っている", () => {
    const names = inventory().map((t) => t.name);
    for (const name of LIFECYCLE_TOOLS) {
      assert.ok(names.includes(name), `${name} が Kobo の在庫にあること`);
    }
  });

  it("**提示**の表にも載っている（決定82: 隠れている道具は無いのと同じ）", () => {
    // inc-0063 で番頭が畳めなかったのは、道具が無かったからではなく
    // **提示されていなかった**から。在庫だけ確かめても、この事故は防げない
    const presented = selectPresentedTools(inventory()).map((t) => t.name);
    for (const name of LIFECYCLE_TOOLS) {
      assert.ok(presented.includes(name), `${name} が番頭に提示されること`);
    }
  });

  it("機構が案内する道具は、すべて提示されている（案内と道具を食い違わせない）", async () => {
    // `kobo-notice.ts` と `kobo-tools.ts` の助言文が名指しする `kobo.*` は、
    // 番頭の手に無ければ「言われたとおりにできない」案内になる。inc-0063 の 5 番そのもの
    const presented = new Set<string>(selectPresentedTools(inventory()).map((t) => t.name));
    const noticeSource = await fs.promises.readFile(
      new URL("../../packages/banto-host/src/kobo-notice.ts", import.meta.url),
      "utf-8"
    );
    // 機構が自分で叩く口（`invoke("kobo.events" …)`）は番頭への案内ではないので外す
    const prose = noticeSource.replace(/invoke\(\s*"kobo\.[a-z_]+"/g, "invoke(");
    const named = new Set(prose.match(/kobo\.[a-z_]+/g) ?? []);
    // `kobo.review` は器（canvasKind）であって道具ではない
    named.delete("kobo.review");
    for (const name of named) {
      assert.ok(presented.has(name), `助言文が名指しする ${name} が提示されていること`);
    }
  });
});

// ── 1. merging に居座ったタスクに、どの口が届くか ─────────────────────────────

describe("[kobo-task-lifecycle-tools] merging のタスクを降ろす", () => {
  let tmpDir: string;
  let repo: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-lifecycle";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-lifecycle-"));
    repo = path.join(tmpDir, "repo");
    initRepo(repo);
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 200,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      // マージキューは回さない——ここで見たいのは「番頭が降ろせるか」だけ
      disableMergeQueue: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
    await registerProject(base, PROJ, repo);

    // 2本とも merging に置く。`kobo.supersede` と `kobo.abandon` は**どちらもタスクを
    // 降ろす**ので、同じ札を使い回すと後の1本が「もう降りている」で断られる
    writeTaskFile(repo, "task-0001", "merging に居座る仕事", "src/one/**");
    writeTaskFile(repo, "task-0002", "merging に居座るもう1つの仕事", "src/two/**");
    for (const taskId of ["task-0001", "task-0002"]) {
      const status = await pollUntil(
        () => statusOf(base, PROJ, taskId),
        (s) => s === "ready"
      );
      assert.equal(status, "ready", `${taskId} が ready まで進むこと（前提）`);
      for (const to of [
        "planning",
        "implementing",
        "auditing",
        "review-ready",
        "in-review",
        "approved",
        "merging",
      ]) {
        await forceTo(base, PROJ, taskId, to);
      }
      assert.equal(await statusOf(base, PROJ, taskId), "merging", "merging に置けること（前提）");
    }
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * **`reopen` は failed 専用のまま。** 戻す先（implementing / approved）は落ちた理由で
   * 選ぶものなので、落ちていないタスクには意味を持たない。
   *
   * 対の `abandon` は **2026-08-14 の PO 裁定でどの状態からでも通るようになった**
   * （下の1件）。緩めたのは「畳む」だけで、「戻す」は緩めていない。
   */
  it("kobo.reopen は merging に届かない（failed 専用・いまの限界）", async () => {
    const refusal = await callToolExpectingRefusal(base, "kobo.reopen", {
      projectTag: PROJ,
      taskId: "task-0001",
      mode: "rework",
      reason: "テスト: merging から戻そうとする",
    });
    assert.match(refusal, /failed/, "failed 専用であることを理由に言うこと");
    assert.match(refusal, /merging/, "いまの状態を言うこと");
    assert.equal(await statusOf(base, PROJ, "task-0001"), "merging", "断ったなら動かないこと");
  });

  /**
   * **限界を1つ外した**（PO 裁定 2026-08-14）。以前ここは
   * 「`kobo.abandon` も merging に届かない（failed 専用・いまの限界）」を固定していた。
   *
   * 何をどこまで緩めたか：`Daemon.abandonTask` の `status !== "failed"` を外し、
   * `closed` を `StateMachine.abandon()` という**横断の遷移**にした（`fail` / `supersede`
   * と同じ形）。断るのは `closed` / `superseded` の2つだけ。遷移表（REGULAR_TRANSITIONS）は
   * 触っていない——`transition()` を呼ぶ誰でも閉じられる、にはしていない。
   *
   * 緩めた理由：実運用で宙に浮くのは failed ではなく queued / paused / review-ready で、
   * 実機の工場に14本が二度と動かないまま凍っていた。
   */
  it("kobo.abandon は merging のタスクを畳める（どの状態からでも・PO 裁定 2026-08-14）", async () => {
    const result = await callTool(base, "kobo.abandon", {
      projectTag: PROJ,
      taskId: "task-0002",
      reason: "テスト: merging から畳む",
    });
    assert.match(result.content[0]!.text, /畳みました/);
    assert.equal(
      result.details?.["from"],
      "merging",
      "**どこから畳んだか**を返すこと（経緯を辿る手がかり）"
    );
    assert.equal(await statusOf(base, PROJ, "task-0002"), "closed", "merging から降りていること");
  });

  it("既に畳んだものは畳み直せない（いまの状態を名指しで断る・I2）", async () => {
    const refusal = await callToolExpectingRefusal(base, "kobo.abandon", {
      projectTag: PROJ,
      taskId: "task-0002",
      reason: "テスト: 二度目",
    });
    assert.match(refusal, /closed/, "いまの状態を名指しで言うこと");
    assert.equal(await statusOf(base, PROJ, "task-0002"), "closed", "断っても動かないこと");
  });

  /**
   * **別の依頼で置き換えて降ろす口。** `Daemon.transition` は `superseded` を
   * `StateMachine.supersede` へ回し、それは**終端以外のどの状態からでも**通る
   * （`TERMINAL_STATES` = closed / merged / failed / superseded）。
   * 新しい遷移は増やしていない——既にある道が、提示されていなかっただけである。
   */
  it("kobo.supersede は merging のタスクを降ろせる（既存の遷移・不可逆な道は増やさない）", async () => {
    const result = await callTool(base, "kobo.supersede", {
      projectTag: PROJ,
      taskId: "task-0001",
      by: "task-0002",
    });
    assert.match(result.content[0]!.text, /置き換えました/);
    assert.equal(
      await statusOf(base, PROJ, "task-0001"),
      "superseded",
      "merging から降りていること"
    );
  });
});
