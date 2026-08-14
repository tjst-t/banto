/**
 * task-0070: **宛先が分からない知らせを捨てない**（PO報告 2026-08-07）。
 *
 * ## 何が起きていたか（実機・loamium/task-0001）
 *
 * 監査人が判定を出さずに落ち、タスクは `failed` になった。だが**番頭は最後まで知らなかった**。
 * `kobo-notice.ts` がこう書いてあったため：
 *
 * ```ts
 * const origin = origins[`${projectTag}/${taskId}`];
 * // 番頭が積んだものだけを会話へ返す。PO が直にファイルを置いたものは宛先が無い
 * if (!origin) return undefined;   // ← 黙って捨てる
 * ```
 *
 * `origin` が付くのは `kobo.enqueue` を通ったものだけ。**タスク定義ファイルを watcher が
 * 取り込んだもの（決定64 の正規の入口）には付かない**。loamium の2本はどちらもファイル
 * 経由だったので、`origins` は空のまま——`task_failed` も `review-ready` も、1通残らず
 * 捨てられていた。
 *
 * 宛先が分からないことは、知らせなくてよい理由にならない（I2）。**既定のスレッドへ返す。**
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboModule, KOBO_MODULE_PATH } from "../../packages/banto-daemon/src/index.js";
import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";
import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

interface Harness {
  daemon: Daemon;
  tools: NamespacedToolDefinition[];
  tmpDir: string;
  proj: string;
  writeTask(taskId: string): void;
}

async function harness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-orphan-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  const port = await freePort();
  const daemon = Daemon.create({
    port,
    dataDir: path.join(tmpDir, "data"),
    // **watcher に拾わせる**（決定64 の正規の入口）。ここが origin の付かない経路
    tickIntervalMs: 200,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
  });
  await daemon.start();
  const proj = "orphan-proj";
  daemon.registerProject(proj, repoDir);

  const module = createKoboModule(`http://127.0.0.1:${port}${KOBO_MODULE_PATH}`);
  return {
    daemon,
    tools: module.tools as unknown as NamespacedToolDefinition[],
    tmpDir,
    proj,
    writeTask(taskId) {
      fs.writeFileSync(
        path.join(repoDir, "work", "tasks", `${taskId}.md`),
        `---\nid: ${taskId}\ntype: task\nkind: feature\ntitle: ファイルから積んだ仕事\nstatus: queued\nscope:\n  paths:\n    - src/**\nacceptance:\n  - { id: a1, text: 動くこと }\n---\n\n本文。\n`,
        "utf-8"
      );
    },
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

describe("[task-0070] ファイルから取り込んだタスクの知らせも会話へ返る", () => {
  it("watcher が取り込んだタスクには origin が付かない（この検体の前提）", async () => {
    const h = await harness();
    try {
      h.writeTask("task-0100");
      await until(() => h.daemon.getTask(h.proj, "task-0100") !== undefined);

      const tool = h.tools.find((t) => t.name === "kobo.events")!;
      const result = await tool.execute({ afterEventId: 0, limit: 200 } as never, {
        toolCallId: "t",
      });
      const origins = ((result.details ?? {}) as { origins?: Record<string, string> }).origins ?? {};
      assert.equal(
        origins[`${h.proj}/task-0100`],
        undefined,
        "origin が付いているなら、この検体は元の穴を再現していない"
      );
    } finally {
      await teardown(h);
    }
  });

  it("止まったことが既定のスレッドへ届く（宛先が無くても捨てない）", async () => {
    const h = await harness();
    const delivered: Array<{ message: string; threadId?: string }> = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0101");
      await until(() => h.daemon.getTask(h.proj, "task-0101") !== undefined);

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message, target) => {
          delivered.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, "task-0101")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0101", to, "test");
      }
      // 監査人が判定を出さずに落ちたのと同じ終わり方（実機で起きたもの）
      h.daemon.transition(h.proj, "task-0101", "failed", "audit_session_exited_without_verdict (2回試行)");

      await until(() => delivered.some((d) => /止まりました/.test(d.message)));
      const notice = delivered.find((d) => /止まりました/.test(d.message))!;
      assert.equal(notice.threadId, undefined, "宛先が無いものは既定のスレッドへ");
      assert.match(notice.message, /task-0101/);
      assert.match(
        notice.message,
        /audit_session_exited_without_verdict/,
        "なぜ止まったかが会話に出る（握り潰さない）"
      );
      assert.match(notice.message, /2回試行/, "何回試したのかも届く");
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  it("判断待ちも届く（レビューがそのまま忘れられない）", async () => {
    const h = await harness();
    const delivered: string[] = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0102");
      await until(() => h.daemon.getTask(h.proj, "task-0102") !== undefined);

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, "task-0102")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0102", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0102", "pass", []);

      await until(() => delivered.some((m) => /レビュー待ち/.test(m)));
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  /**
   * task-0071: **止まり方によって、次にやることが違う。** 一番違うのが時間切れ——
   * テストが落ちたのではなく待ち切れなかったので、「直して積み直せ」とだけ言うと、
   * 番頭は落ちてもいないテストを直そうとする。
   */
  it("時間切れで止まったときは、時間切れ向けの手を示す", async () => {
    const h = await harness();
    const delivered: string[] = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0104");
      await until(() => h.daemon.getTask(h.proj, "task-0104") !== undefined);

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, "task-0104")?.status === "ready");
      h.daemon.transition(
        h.proj,
        "task-0104",
        "failed",
        "merge_gate_failed: verify_timeout:a3(20分待っても終わらず・延長済み）"
      );

      await until(() => delivered.some((m) => /止まりました/.test(m)));
      const notice = delivered.find((m) => /止まりました/.test(m))!;
      assert.match(
        notice,
        /テストが落ちたのではなく/,
        "時間切れをテストの失敗と読ませない"
      );
      assert.match(notice, /verify_timeout_minutes/, "延ばす手が名指しで書いてある");
      assert.match(notice, /直列/, "長い1本が後ろを止めることが書いてある");
      assert.match(notice, /D9/, "自分で決めてよいことが書いてある");
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  it("番頭が積んだものは、いままでどおり積んだスレッドへ返る（取り違えない）", async () => {
    const h = await harness();
    const delivered: Array<{ message: string; threadId?: string }> = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0103");
      const enqueue = h.tools.find((t) => t.name === "kobo.enqueue")!;
      await enqueue.execute(
        { projectTag: h.proj, taskId: "task-0103", origin: threadOrigin("thread-9") } as never,
        { toolCallId: "t" }
      );

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message, target) => {
          delivered.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, "task-0103")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0103", to, "test");
      }
      h.daemon.transition(h.proj, "task-0103", "failed", "何かで止まった");

      await until(() => delivered.some((d) => /止まりました/.test(d.message)));
      const notice = delivered.find((d) => /止まりました/.test(d.message))!;
      assert.equal(notice.threadId, "thread-9", "積んだスレッドへ返る（決定35a）");
    } finally {
      stop?.();
      await teardown(h);
    }
  });
});

/**
 * **watcher に先を越されても、宛先は付く**（PO報告 2026-08-11）。
 *
 * 番頭は「定義ファイルを書く → `kobo.enqueue`」の順で積む。その間に watcher が
 * `status: queued` を見つけて取り込むと、enqueue は「既に積まれています」と断られ、
 * **origin が永久に付かなかった**——ひらがなの task-0001/0002 の失敗が、積んだ幹
 * （ひらがな学習アプリ構想）ではなく帳場に出たのはこれ。
 */
describe("[PO報告 2026-08-11] watcher が先に取り込んでも、積んだ幹へ返る", () => {
  it("取り込み済みのタスクでも enqueue が宛先を引き受ける", async () => {
    const h = await harness();
    const delivered: Array<{ message: string; threadId?: string }> = [];
    let stop: (() => void) | undefined;
    try {
      // **先に watcher に取らせる**（実機で起きた順序をそのまま作る）
      h.writeTask("task-0104");
      await until(() => h.daemon.getTask(h.proj, "task-0104") !== undefined);
      assert.equal(
        h.daemon.originOfTask(h.proj, "task-0104"),
        undefined,
        "この時点では宛先が無い（穴の再現）"
      );

      // 番頭が後から積む。**断られずに宛先だけ引き受ける**
      const enqueue = h.tools.find((t) => t.name === "kobo.enqueue")!;
      await enqueue.execute(
        {
          projectTag: h.proj,
          taskId: "task-0104",
          origin: threadOrigin("thread-50"),
          originRef: "PO の報告（2026-08-11）",
        } as never,
        { toolCallId: "t" }
      );
      assert.equal(h.daemon.originOfTask(h.proj, "task-0104"), threadOrigin("thread-50"));

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message, target) => {
          delivered.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, "task-0104")?.status === "ready");
      h.daemon.transition(h.proj, "task-0104", "failed", "worktree creation failed");

      await until(() => delivered.some((d) => /止まりました/.test(d.message)));
      const notice = delivered.find((d) => /止まりました/.test(d.message))!;
      assert.equal(notice.threadId, "thread-50", "帳場ではなく、積んだ幹へ返る");
      // 経緯も一緒に引き受ける（無いと札に「起きたこと」しか書けない・D8）
      assert.match(notice.message, /PO の報告（2026-08-11）/u);
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  it("既に宛先があるものは横取りさせない", async () => {
    const h = await harness();
    try {
      h.writeTask("task-0105");
      const enqueue = h.tools.find((t) => t.name === "kobo.enqueue")!;
      await enqueue.execute(
        { projectTag: h.proj, taskId: "task-0105", origin: threadOrigin("thread-1") } as never,
        { toolCallId: "t" }
      );
      // 2度目は別の宛先。**契約は凍っている**ので断る（決定62c）
      await assert.rejects(
        () =>
          enqueue.execute(
            { projectTag: h.proj, taskId: "task-0105", origin: threadOrigin("thread-2") } as never,
            { toolCallId: "t" }
          ),
        /既に積まれています/u
      );
      assert.equal(h.daemon.originOfTask(h.proj, "task-0105"), threadOrigin("thread-1"));
    } finally {
      await teardown(h);
    }
  });
});
