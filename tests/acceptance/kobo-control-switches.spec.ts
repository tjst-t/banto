/**
 * 工場（Kobo）の**制御の口3つ**（PO 裁定 2026-08-13・inc-0063）。
 *
 *   - `kobo.unregister_project` — 受け持ちを外す（`register_project` の対）
 *   - `kobo.set_watch`          — プロジェクト単位で**仕事を積む口**を止める（第4便で意味が変わった）
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

/**
 * 積む（第4便：入口は `kobo.enqueue` だけ）。**id は Kobo が振る**ので返す。
 * 断られたら例外なので、`callToolExpectingRefusal` と使い分ける。
 */
async function enqueue(base: string, projectTag: string, title: string): Promise<string> {
  const r = await callTool(base, "kobo.enqueue", {
    projectTag,
    title,
    kind: "feature",
    body: "制御の口のテスト用。",
    scope: { paths: ["src/**"] },
    acceptance: [{ text: "動作確認" }],
    originRef: "試験",
  });
  return String((r.details as { taskId: string }).taskId);
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

// ── 1. 受け持ちを外す口・積む口を止める弁 ─────────────────────────────────────

describe("[kobo-control-switches] 受け持ちを外す口と、積む口を止める弁", () => {
  let tmpDir: string;
  let alphaRepo: string;
  let canaryRepo: string;
  let daemon: Daemon;
  let base: string;
  const ALPHA = "proj-alpha";
  const CANARY = "proj-canary";
  let aliveId: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ctrl-watch-"));
    alphaRepo = path.join(tmpDir, "alpha");
    canaryRepo = path.join(tmpDir, "canary");
    fs.mkdirSync(path.join(alphaRepo, "work", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(canaryRepo, "work", "tasks"), { recursive: true });

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
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
    aliveId = await enqueue(base, ALPHA, "動いている仕事");
    // ゲートを通って ready まで進む（＝動いている状態）
    const status = await pollUntil(
      async () => {
        const r = await fetch(`${base}/api/v1/projects/${ALPHA}/tasks/${aliveId}`);
        if (r.status !== 200) return "";
        return ((await r.json()) as { task: { status: string } }).task.status;
      },
      (s) => s === "ready",
      8000
    );
    assert.equal(status, "ready", `${aliveId} が ready であること（前提）`);

    const refusal = await callToolExpectingRefusal(base, "kobo.unregister_project", {
      projectTag: ALPHA,
      reason: "テスト: 動いているのに外そうとする",
    });
    assert.match(refusal, new RegExp(aliveId), "何が動いているかを名指しすること");
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

  it("force を明示すれば外れる。外したプロジェクトへは積めない", async () => {
    const result = await callTool(base, "kobo.unregister_project", {
      projectTag: ALPHA,
      reason: "テスト: 承知の上で外す",
      force: true,
    });
    assert.match(result.content[0]!.text, /受け持ちを外しました/);
    assert.deepEqual(
      (result.details as { activeTaskIds: string[] }).activeTaskIds,
      [aliveId],
      "置き去りにしたものを名指しで返すこと"
    );

    const projects = (await callTool(base, "kobo.projects", {})).details as {
      projects: Array<{ id: string }>;
    };
    assert.ok(!projects.projects.some((p) => p.id === ALPHA), "一覧から消えていること");

    // 外したあとは積めない。**断る**のであって、黙って捨てるのではない（I2）
    const refusal = await callToolExpectingRefusal(base, "kobo.enqueue", {
      projectTag: ALPHA,
      title: "外した後に積もうとする仕事",
      kind: "feature",
      body: "本文。",
      scope: { paths: ["src/**"] },
      acceptance: [{ text: "動作確認" }],
      originRef: "試験",
    });
    assert.match(refusal, /知りません/, "受け持っていないプロジェクトへは積めないこと");

    // 止めていない側は積めること（プロジェクト単位である証拠）
    await enqueue(base, CANARY, "canary の仕事");
  });

  it("外しても帳簿は消えない——同じ id で登録し直すと経緯がそのまま繋がる", async () => {
    await registerProject(base, ALPHA, alphaRepo);

    const r = await fetch(`${base}/api/v1/projects/${ALPHA}/tasks/${aliveId}`);
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

  it("積む口を止めたプロジェクトへは積めない。**止めた理由がそのまま返る**（他は回り続ける）", async () => {
    const stopped = await callTool(base, "kobo.set_watch", {
      projectTag: ALPHA,
      enabled: false,
      reason: "テスト: 積む口を止める",
    });
    assert.match(stopped.content[0]!.text, /仕事を積む口を\*\*止めました\*\*/);

    // **断られること**。黙って受け付けて何も起きない経路を作らない（I2）
    const refusal = await callToolExpectingRefusal(base, "kobo.enqueue", {
      projectTag: ALPHA,
      title: "止めている間に積もうとした仕事",
      kind: "feature",
      body: "本文。",
      scope: { paths: ["src/**"] },
      acceptance: [{ text: "動作確認" }],
      originRef: "試験",
    });
    assert.match(refusal, /積む口が止まっています/);
    assert.match(refusal, /テスト: 積む口を止める/, "**なぜ止まっているか**がそのまま返ること");

    // 止めていない側は積めること（プロジェクト単位である証拠）
    await enqueue(base, CANARY, "canary の仕事2");

    // 止まっていることが読み口で分かること（**黙って止まっているのが一番困る**）
    const listed = await callTool(base, "kobo.projects", {});
    assert.match(listed.content[0]!.text, /積む口を停止/);
    assert.match(listed.content[0]!.text, /テスト: 積む口を止める/);

    // 戻せば積める（弁であって、壊したのではない）
    await callTool(base, "kobo.set_watch", {
      projectTag: ALPHA,
      enabled: true,
      reason: "テスト: 戻す",
    });
    const resumedId = await enqueue(base, ALPHA, "弁を開けた後の仕事");
    assert.match(resumedId, /^task-\d{4}$/, "動かし直せば積めること");
  });
});

// ── 2. マージキューを止める口（inc-0063 の非常停止）─────────────────────────

describe("[kobo-control-switches] マージキューを止める口（衝突の戻しも起きない）", () => {
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

  it("止めている間は rebase も衝突の戻しも状態遷移も回らない／動かすと回る", async () => {
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
      [],
      "止めている間は記録ファイルが1本も増えないこと（機構は契約を作らない）"
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

    // 第4便: 衝突は**同じ契約の次の試行**。解消タスクは起票せず implementing へ戻る。
    // **状態ではなく遷移で見る**——ここには Worker Pool が居ないので、戻した直後に
    // 職人を起こせず failed まで進むことがある（P6: 状態で見ると間欠的に割れる）
    const retried = await pollUntil(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/task-B/events`);
        const events = ((await res.json()) as { events: Array<Record<string, unknown>> }).events;
        return events.find(
          (e) =>
            e["type"] === "state_transitioned" &&
            e["from"] === "merging" &&
            e["to"] === "implementing" &&
            String(e["reason"] ?? "").startsWith("rebase_conflict")
        );
      },
      (e) => e !== undefined,
      20000
    );
    assert.ok(
      retried,
      "task-B は rebase が割れて implementing へ戻ること（止まっていたのは弁のせいだと分かる）"
    );
    assert.deepEqual(
      listTaskFiles(repoDir),
      [],
      "衝突しても新しいタスクは起票されないこと（機構は契約を作らない）"
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
    assert.equal(projects[0]!.watch?.enabled, false, "積む口は止まったままであること");
    assert.equal(projects[0]!.mergeQueue?.enabled, false, "マージキューは止まったままであること");
    assert.match(projects[0]!.watch?.reason ?? "", /再起動/, "理由も残っていること");
    assert.match(listed.content[0]!.text, /積む口を停止/);
    assert.match(listed.content[0]!.text, /マージキュー停止/);

    // 止まったままなのだから、再起動後も積めない
    const refusal = await callToolExpectingRefusal(base, "kobo.enqueue", {
      projectTag: KEPT,
      title: "再起動後に積もうとした仕事",
      kind: "feature",
      body: "本文。",
      scope: { paths: ["src/**"] },
      acceptance: [{ text: "動作確認" }],
      originRef: "試験",
    });
    assert.match(refusal, /積む口が止まっています/, "再起動しても止まったままであること");

    await callTool(base, "kobo.set_watch", {
      projectTag: KEPT,
      enabled: true,
      reason: "テスト: 戻す",
    });
    assert.match(
      await enqueue(base, KEPT, "弁を開けた後の仕事"),
      /^task-\d{4}$/,
      "弁を開ければ積めること（止めていたのは弁だと分かる）"
    );
  });
});
