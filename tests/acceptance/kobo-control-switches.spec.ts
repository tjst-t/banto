/**
 * 工場（Kobo）の**制御の口3つ**（PO 裁定 2026-08-13・inc-0063）。
 *
 *   - `kobo.unregister_project` — 受け持ちを外す（`register_project` の対）
 *   - `kobo.set_watch`          — プロジェクト単位でタスクの取り込みを止める
 *   - `kobo.set_merge_queue`    — プロジェクト単位でマージキューを止める（非常停止）
 *
 * inc-0063 では、マージキューが空 rebase を「コンフリクト未解消」と読んで解消タスクを
 * 1分ごとに起票し続け、番頭には止める手段が1つも無かった。ここで確かめるのは
 * **止められること**と、**止めたことが再起動を跨いで残ること**の2つ。
 *
 * story_type=api: 本物の Daemon・本物の git リポジトリ・本物の HTTP。内部は差し替えない（I1）。
 * Tool は番頭が呼ぶのと同じ道（`POST /api/kobo/tools/<名前>`）で叩く——直接メソッドを
 * 呼ぶと、口が繋がっていなくても通ってしまう。
 *
 * P6: 待ちは「時間で祈る」のではなく、**同じ tick を通った別の観測**（canary）に同期する。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Daemon, createKoboModule } from "@banto/daemon";
import { selectPresentedTools } from "@banto/host";

/** この作業で開けた3つの口。名前は番頭がそのまま呼ぶものなので、ここで固定する。 */
const CONTROL_TOOLS = [
  "kobo.unregister_project",
  "kobo.set_watch",
  "kobo.set_merge_queue",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (val: T) => boolean,
  timeoutMs = 15000,
  intervalMs = 150
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

/** 番頭が呼ぶのと同じ道で Tool を叩く。I2: 失敗は投げる（200 で包まれていないことも確かめる）。 */
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

async function getAllEvents(base: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/v1/events`);
  const body = (await res.json()) as { events: Array<Record<string, unknown>> };
  return body.events;
}

/** 帳簿に「そのプロジェクトのそのタスクが生まれた」記録があるか。 */
async function taskWasIngested(
  base: string,
  projectTag: string,
  taskId: string
): Promise<boolean> {
  const events = await getAllEvents(base);
  return events.some(
    (e) => e["type"] === "task_created" && e["projectTag"] === projectTag && e["taskId"] === taskId
  );
}

function writeTaskFile(repoDir: string, taskId: string, title: string): void {
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
  paths: [src/**]
acceptance:
  - { id: a1, text: 動作確認 }
---

## 背景

制御の口のテスト用。
`,
    "utf-8"
  );
}

/** work/tasks に置かれた .md の名前（ディレクトリが無ければ空）。 */
function listTaskFiles(repoDir: string): string[] {
  const dir = path.join(repoDir, "work", "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

async function registerProject(base: string, id: string, repoPath: string): Promise<void> {
  // **`kobo.register_project` は使わない**——あれは検証環境へ問い合わせるので、
  // 検証環境の有無がこのテストの結果を左右してしまう。載せるのは REST の口で足りる
  const res = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, repoPath }),
  });
  assert.equal(res.status, 201, `project ${id} registration must succeed`);
}

function initRepo(repoDir: string, fileName = "shared.ts"): void {
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@banto-control-switches.local");
  git("config", "user.name", "banto-control-switches-test");
  fs.writeFileSync(path.join(repoDir, fileName), "// shared\nexport const VERSION = 0;\n");
  git("add", "-A");
  git("commit", "-m", "initial");
}

// ── 0. 番頭に届くこと（在庫にあるだけでは「無い」のと同じ）────────────────────

describe("[kobo-control-switches] 3つの口が番頭へ配られる", () => {
  it("Kobo の在庫に3つとも載っている", () => {
    const inventory = createKoboModule("http://127.0.0.1:1/api/kobo").tools.map((t) => t.name);
    for (const name of CONTROL_TOOLS) {
      assert.ok(inventory.includes(name), `${name} が Kobo の在庫にあること`);
    }
  });

  it("**提示**の表にも載っている（決定82: 隠れている道具は無いのと同じ）", () => {
    // inc-0063 で番頭が止められなかったのは、道具が無かったからではなく
    // **提示されていなかった**から。在庫だけ確かめても、この事故は防げない
    const inventory = createKoboModule("http://127.0.0.1:1/api/kobo").tools;
    const presented = selectPresentedTools(inventory).map((t) => t.name);
    for (const name of CONTROL_TOOLS) {
      assert.ok(presented.includes(name), `${name} が番頭に提示されること`);
    }
    assert.ok(
      presented.includes("kobo.projects"),
      "止まっていることを読む口（kobo.projects）も提示されること"
    );
  });
});

// ── 1. 受け持ちを外す口・取り込みを止める口 ───────────────────────────────────

describe("[kobo-control-switches] 受け持ちを外す口と、取り込みを止める口", () => {
  let tmpDir: string;
  let alphaRepo: string;
  let canaryRepo: string;
  let daemon: Daemon;
  let base: string;
  const ALPHA = "proj-alpha";
  const CANARY = "proj-canary";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ctrl-watch-"));
    alphaRepo = path.join(tmpDir, "alpha");
    canaryRepo = path.join(tmpDir, "canary");
    fs.mkdirSync(path.join(alphaRepo, "work", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(canaryRepo, "work", "tasks"), { recursive: true });

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 200,
      tickIntervalMs: 200,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableMergeQueue: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
    await registerProject(base, ALPHA, alphaRepo);
    await registerProject(base, CANARY, canaryRepo);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("動いているタスクがあると、force 無しでは外れない（理由に名前が出る）", async () => {
    writeTaskFile(alphaRepo, "task-0001", "動いている仕事");
    // 取り込まれ、ゲートを通って ready まで進む（＝動いている状態）
    const ingested = await pollUntil(
      () => taskWasIngested(base, ALPHA, "task-0001"),
      (v) => v,
      8000
    );
    assert.ok(ingested, "task-0001 が取り込まれること（前提）");
    const status = await pollUntil(
      async () => {
        const r = await fetch(`${base}/api/v1/projects/${ALPHA}/tasks/task-0001`);
        if (r.status !== 200) return "";
        return ((await r.json()) as { task: { status: string } }).task.status;
      },
      (s) => s === "ready",
      8000
    );
    assert.equal(status, "ready", "task-0001 が ready であること（前提）");

    const refusal = await callToolExpectingRefusal(base, "kobo.unregister_project", {
      projectTag: ALPHA,
      reason: "テスト: 動いているのに外そうとする",
    });
    assert.match(refusal, /task-0001/, "何が動いているかを名指しすること");
    assert.match(refusal, /ready/, "その状態も言うこと");
    assert.match(refusal, /force/, "force で外せることを言うこと");

    // I2: 断ったのだから、外れていてはいけない
    const projects = (await callTool(base, "kobo.projects", {})).details as {
      projects: Array<{ id: string }>;
    };
    assert.ok(
      projects.projects.some((p) => p.id === ALPHA),
      "断ったなら受け持ちは残っていること"
    );
  });

  it("force を明示すれば外れる。外したプロジェクトは watcher に取り込まれない", async () => {
    const result = await callTool(base, "kobo.unregister_project", {
      projectTag: ALPHA,
      reason: "テスト: 承知の上で外す",
      force: true,
    });
    assert.match(result.content[0]!.text, /受け持ちを外しました/);
    assert.deepEqual(
      (result.details as { activeTaskIds: string[] }).activeTaskIds,
      ["task-0001"],
      "置き去りにしたものを名指しで返すこと"
    );

    const projects = (await callTool(base, "kobo.projects", {})).details as {
      projects: Array<{ id: string }>;
    };
    assert.ok(!projects.projects.some((p) => p.id === ALPHA), "一覧から消えていること");

    // 外したあとに置いた定義ファイルは取り込まれない。
    // P6: 時間で祈らず、**同じ周回を通った canary** に同期する
    writeTaskFile(alphaRepo, "task-0002", "外した後に置いた仕事");
    writeTaskFile(canaryRepo, "task-0002", "canary の仕事");
    const canaryIn = await pollUntil(
      () => taskWasIngested(base, CANARY, "task-0002"),
      (v) => v,
      8000
    );
    assert.ok(canaryIn, "canary は取り込まれること（watcher が回っている証拠）");

    assert.equal(
      await taskWasIngested(base, ALPHA, "task-0002"),
      false,
      "外したプロジェクトの定義ファイルは取り込まれないこと"
    );
  });

  it("外しても帳簿は消えない——同じ id で登録し直すと経緯がそのまま繋がる", async () => {
    await registerProject(base, ALPHA, alphaRepo);

    const r = await fetch(`${base}/api/v1/projects/${ALPHA}/tasks/task-0001`);
    assert.equal(r.status, 200, "外す前のタスクがまだ引けること");
    const body = (await r.json()) as { task: { status: string; title?: string } };
    assert.equal(body.task.status, "ready", "状態もそのまま");

    const events = await getAllEvents(base);
    assert.ok(
      events.some(
        (e) => e["type"] === "po_operation" && e["operation"] === "project_unregistered"
      ),
      "外したこと自体も帳簿に残ること"
    );
  });

  it("取り込みを止めたプロジェクトの work/tasks/*.md は取り込まれない（他は回り続ける）", async () => {
    const stopped = await callTool(base, "kobo.set_watch", {
      projectTag: ALPHA,
      enabled: false,
      reason: "テスト: 取り込みを止める",
    });
    assert.match(stopped.content[0]!.text, /取り込みを\*\*止めました\*\*/);

    writeTaskFile(alphaRepo, "task-0003", "止めている間に置いた仕事");
    writeTaskFile(canaryRepo, "task-0003", "canary の仕事2");
    const canaryIn = await pollUntil(
      () => taskWasIngested(base, CANARY, "task-0003"),
      (v) => v,
      8000
    );
    assert.ok(canaryIn, "止めていない側は取り込まれること（プロジェクト単位である証拠）");

    assert.equal(
      await taskWasIngested(base, ALPHA, "task-0003"),
      false,
      "止めた側は取り込まれないこと"
    );

    // 止まっていることが読み口で分かること（**黙って止まっているのが一番困る**）
    const listed = await callTool(base, "kobo.projects", {});
    assert.match(listed.content[0]!.text, /取り込み停止/);
    assert.match(listed.content[0]!.text, /テスト: 取り込みを止める/);

    // 戻せば取り込まれる（弁であって、壊したのではない）
    await callTool(base, "kobo.set_watch", {
      projectTag: ALPHA,
      enabled: true,
      reason: "テスト: 戻す",
    });
    const resumed = await pollUntil(
      () => taskWasIngested(base, ALPHA, "task-0003"),
      (v) => v,
      8000
    );
    assert.ok(resumed, "動かし直せば、止めている間に置いたものも取り込まれること");
  });
});

// ── 2. マージキューを止める口（inc-0063 の非常停止）─────────────────────────

describe("[kobo-control-switches] マージキューを止める口（自動起票が起きない）", () => {
  let tmpDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let daemon: Daemon;
  let base: string;
  const PROJ = "proj-mq";

  const setupTaskBranch = (taskId: string, content: string): void => {
    const worktreePath = path.join(worktreeBaseDir, PROJ, taskId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const wgit = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktreePath, stdio: "pipe" });
    wgit("checkout", "-b", `task/${taskId}`);
    fs.writeFileSync(path.join(worktreePath, "shared.ts"), content);
    wgit("add", "-A");
    wgit("commit", "-m", `feat: ${taskId}`);
  };

  const getStatus = async (taskId: string): Promise<string> => {
    const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${taskId}`);
    if (r.status !== 200) return "";
    return ((await r.json()) as { task: { status: string } }).task.status;
  };

  const transitionTo = async (taskId: string, to: string): Promise<void> => {
    const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${taskId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (r.status !== 200) {
      // 工場は自分でも進む。着きたかった先に既に居るなら成功として扱う
      if ((await getStatus(taskId)) === to) return;
      throw new Error(`transition ${taskId}→${to} failed (${r.status}): ${await r.text()}`);
    }
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ctrl-mq-"));
    repoDir = path.join(tmpDir, "repo");
    worktreeBaseDir = path.join(tmpDir, "worktrees");
    initRepo(repoDir);

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir,
      tickIntervalMs: 200,
      watchIntervalMs: 200,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      // 明示する——環境変数（BANTO_DISABLE_MERGE_QUEUE）でこのテストの意味が変わらないように
      disableMergeQueue: false,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
    await registerProject(base, PROJ, repoDir);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("止めている間は rebase も自動起票も状態遷移も回らない／動かすと回る", async () => {
    // task-A と task-B は同じ行を書き換える（A がマージされると B の rebase が必ず割れる）
    setupTaskBranch("task-A", "// shared\nexport const VERSION = 1; // A\n");
    setupTaskBranch("task-B", "// shared\nexport const VERSION = 2; // B\n");

    for (const id of ["task-A", "task-B"]) {
      const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          title: `Task ${id}`,
          scope: { paths: ["shared.ts"] },
          acceptance: [{ id: "a1", text: "file exists" }],
        }),
      });
      assert.equal(r.status, 201, `task ${id} creation must succeed`);
    }

    // ── 弁を閉じてから通す ──────────────────────────────────────────────
    const stopped = await callTool(base, "kobo.set_merge_queue", {
      projectTag: PROJ,
      enabled: false,
      reason: "テスト: inc-0063 の周回を止める",
    });
    assert.match(stopped.content[0]!.text, /マージキューを\*\*止めました\*\*/);

    const filesBefore = listTaskFiles(repoDir);

    for (const id of ["task-A", "task-B"]) {
      for (const to of [
        "queued",
        "ready",
        "planning",
        "implementing",
        "auditing",
        "review-ready",
        "in-review",
        "approved",
      ]) {
        if ((await getStatus(id)) === to) continue;
        await transitionTo(id, to);
      }
    }

    // tick は 200ms なので、3秒で 15 周ほど回る。**「回ったのに動かない」ことの根拠は
    // この待ち時間ではなく、この後で弁を開けたら即座に動くこと**——止まっていたのが
    // 弁のせいだと、同じテストの中で示す（P6: 「たまたま遅い」で通さない）
    await new Promise((r) => setTimeout(r, 3000));

    assert.equal(await getStatus("task-A"), "approved", "止めている間は merging へ進まないこと");
    assert.equal(await getStatus("task-B"), "approved", "止めている間は merging へ進まないこと");
    assert.deepEqual(
      listTaskFiles(repoDir),
      filesBefore,
      "止めている間はコンフリクト解消タスクが自動起票されないこと"
    );

    // 止まっていることが読み口で分かること
    const listed = await callTool(base, "kobo.projects", {});
    assert.match(listed.content[0]!.text, /マージキュー停止/);
    assert.match(listed.content[0]!.text, /inc-0063 の周回を止める/);

    // ── 弁を開ければ回る（＝止めていたのは弁であって、壊れていたのではない）──
    await callTool(base, "kobo.set_merge_queue", {
      projectTag: PROJ,
      enabled: true,
      reason: "テスト: 戻す",
    });

    const finalA = await pollUntil(
      () => getStatus("task-A"),
      (s) => s === "merged" || s === "closed" || s === "failed",
      20000
    );
    assert.ok(finalA === "merged" || finalA === "closed", `task-A がマージされること（${finalA}）`);

    const finalB = await pollUntil(
      () => getStatus("task-B"),
      (s) => s === "paused" || s === "failed",
      20000
    );
    assert.equal(finalB, "paused", "task-B は rebase が割れて paused になること");

    const filesAfter = listTaskFiles(repoDir);
    assert.ok(
      filesAfter.length > filesBefore.length,
      "動かすとコンフリクト解消タスクが起票されること（止まっていたのは弁のせいだと分かる）"
    );
  });
});

// ── 3. 永続化（再起動しても残る）─────────────────────────────────────────────

describe("[kobo-control-switches] 3つの口は再起動しても残る", () => {
  let tmpDir: string;
  let repoDir: string;
  let dataDir: string;
  let daemon: Daemon;
  let base: string;
  const KEPT = "proj-kept";
  const DROPPED = "proj-dropped";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ctrl-persist-"));
    repoDir = path.join(tmpDir, "repo");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const boot = async (): Promise<void> => {
    daemon = Daemon.create({
      port: 0,
      dataDir,
      watchIntervalMs: 200,
      tickIntervalMs: 200,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableMergeQueue: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
  };

  it("止めた弁と外した受け持ちが、再起動後も同じであること", async () => {
    await boot();
    await registerProject(base, KEPT, repoDir);
    await registerProject(base, DROPPED, repoDir);

    await callTool(base, "kobo.set_watch", {
      projectTag: KEPT,
      enabled: false,
      reason: "テスト: 取り込みを止めたまま再起動する",
    });
    await callTool(base, "kobo.set_merge_queue", {
      projectTag: KEPT,
      enabled: false,
      reason: "テスト: マージキューを止めたまま再起動する",
    });
    await callTool(base, "kobo.unregister_project", {
      projectTag: DROPPED,
      reason: "テスト: 外したまま再起動する",
    });

    // **置き場所は projects.json**。ここを直接見ておく——読み口が写しを返しているだけ、
    // という取り違えを防ぐ（D3: 状態の真実は1箇所）
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf-8")) as {
      projects: Array<{ id: string; watch?: { enabled: boolean }; mergeQueue?: { enabled: boolean } }>;
    };
    assert.equal(onDisk.projects.length, 1, "外した方はファイルから消えていること");
    assert.equal(onDisk.projects[0]!.id, KEPT);
    assert.equal(onDisk.projects[0]!.watch?.enabled, false);
    assert.equal(onDisk.projects[0]!.mergeQueue?.enabled, false);

    // ── 再起動 ────────────────────────────────────────────────────────────
    await daemon.stop();
    await boot();

    const listed = await callTool(base, "kobo.projects", {});
    const projects = (listed.details as {
      projects: Array<{
        id: string;
        watch?: { enabled: boolean; reason?: string };
        mergeQueue?: { enabled: boolean; reason?: string };
      }>;
    }).projects;

    assert.equal(projects.length, 1, "外した受け持ちは戻ってこないこと");
    assert.equal(projects[0]!.id, KEPT);
    assert.equal(projects[0]!.watch?.enabled, false, "取り込みは止まったままであること");
    assert.equal(projects[0]!.mergeQueue?.enabled, false, "マージキューは止まったままであること");
    assert.match(projects[0]!.watch?.reason ?? "", /再起動/, "理由も残っていること");
    assert.match(listed.content[0]!.text, /取り込み停止/);
    assert.match(listed.content[0]!.text, /マージキュー停止/);

    // 止まったままなのだから、再起動後に置いた定義ファイルも取り込まれない。
    // watcher が 200ms ごとに回っていることは、この後で弁を開けたら同じファイルが
    // 取り込まれることで示す（待ち時間そのものを根拠にしない）
    writeTaskFile(repoDir, "task-0009", "再起動後に置いた仕事");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(
      await taskWasIngested(base, KEPT, "task-0009"),
      false,
      "再起動しても取り込みは止まったままであること"
    );

    await callTool(base, "kobo.set_watch", {
      projectTag: KEPT,
      enabled: true,
      reason: "テスト: 戻す",
    });
    assert.ok(
      await pollUntil(() => taskWasIngested(base, KEPT, "task-0009"), (v) => v, 8000),
      "弁を開ければ取り込まれること（止めていたのは弁だと分かる）"
    );
  });
});
