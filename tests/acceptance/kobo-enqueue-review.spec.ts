/**
 * task-0064（入口）・task-0065（出口）: 番頭が工場に積み、判断が会話へ返る。
 * ADR-0013 決定57・58・66・68。
 *
 * **工場は本物**を立て、番頭ホスト側は**モジュールの写し**（HTTP 越しの `kobo.*`）で叩く
 * ——決定27b の経路（`{baseUrl}/tools/{名前}`）がテストのたびに実際に通る。職人は要らない
 * ので `disableAutoSpawn`：ここで見たいのは工場の入口と出口であって、実装の実行ではない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboModule } from "../../packages/banto-daemon/src/kobo-module.js";
import { KOBO_MODULE_PATH } from "../../packages/banto-daemon/src/http-server.js";
import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";
import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

const THREAD = "thread-po-1";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
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

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Harness {
  daemon: Daemon;
  tools: NamespacedToolDefinition[];
  repoDir: string;
  tmpDir: string;
  proj: string;
  /** タスク定義ファイルを置く（番頭が file.write でするのと同じこと）。 */
  writeTask(taskId: string, frontmatter: string, body?: string): void;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function harness(options: { config?: string } = {}): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-enqueue-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  if (options.config !== undefined) {
    fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "meta", "config.yaml"), options.config, "utf-8");
  }

  const port = await freePort();
  const daemon = Daemon.create({
    port,
    dataDir: path.join(tmpDir, "data"),
    // 定義ファイルは **明示的に積む**（watcher に拾わせない）——入口の検査なので
    tickIntervalMs: 200,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
  });
  await daemon.start();
  const proj = "kobo-proj";
  daemon.registerProject(proj, repoDir);

  // 番頭ホストが持つのと同じ**写し**（HTTP 越し）。ここが決定27b の経路
  const module = createKoboModule(`http://127.0.0.1:${port}${KOBO_MODULE_PATH}`);
  const tools = module.tools as unknown as NamespacedToolDefinition[];

  return {
    daemon,
    tools,
    repoDir,
    tmpDir,
    proj,
    writeTask(taskId, frontmatter, body = "この依頼の本文。") {
      fs.writeFileSync(
        path.join(repoDir, "work", "tasks", `${taskId}.md`),
        `---\n${frontmatter}\n---\n\n${body}\n`,
        "utf-8"
      );
    },
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool: ${name}`);
      const result = await tool.execute(args as never, { toolCallId: "t" });
      return (result.details ?? {}) as Record<string, unknown>;
    },
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

const TASK_FM = (id: string, extra = "") =>
  [
    `id: ${id}`,
    "type: task",
    "kind: feature",
    `title: ${id} の仕事`,
    "status: queued",
    "scope:",
    "  paths:",
    "    - src/**",
    "acceptance:",
    '  - { id: a1, text: "動くこと" }',
    extra,
  ]
    .filter((l) => l !== "")
    .join("\n");

// ── 入口（task-0064）────────────────────────────────────────────────────────

describe("[task-0064] 番頭が工場に積む（入口）", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("定義ファイルを積むと工場に載り、ゲートを通って ready になる", async () => {
    h.writeTask("task-0001", TASK_FM("task-0001"));
    const details = await h.call("kobo.enqueue", {
      projectTag: h.proj,
      taskId: "task-0001",
      origin: threadOrigin(THREAD),
      originRef: "PO から「まず1本通してほしい」と言われた",
    });
    assert.equal(details["taskId"], "task-0001");

    await until(() => h.daemon.getTask(h.proj, "task-0001")?.status === "ready");
  });

  it("[a2/a3] 宛先（積んだスレッド）と経緯が一緒に残る", () => {
    const task = h.daemon.getTask(h.proj, "task-0001")!;
    assert.equal(task["origin"], threadOrigin(THREAD), "積んだスレッドが残る（決定58）");
    assert.match(String(task["originRef"]), /まず1本通してほしい/, "経緯が残る（D8）");
  });

  it("依頼の本文が契約と一緒に取り込まれる（職人に届くのはこれ）", () => {
    const task = h.daemon.getTask(h.proj, "task-0001")!;
    assert.match(String(task["body"]), /この依頼の本文/);
    assert.deepEqual((task["scope"] as { paths: string[] }).paths, ["src/**"]);
  });

  it("[a4] 積めないときは理由が返る：定義ファイルが無い", async () => {
    await assert.rejects(
      () => h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0404" }),
      /定義ファイルがありません/
    );
  });

  it("[a4] 積めないときは理由が返る：draft は「まだ積まないでほしい」", async () => {
    h.writeTask("task-0002", TASK_FM("task-0002").replace("status: queued", "status: draft"));
    await assert.rejects(
      () => h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0002" }),
      /draft/
    );
    assert.equal(h.daemon.getTask(h.proj, "task-0002"), undefined, "積まれていないこと");
  });

  it("[決定64 改訂] 積み直しでは訂正できない。理由に kobo.amend と書いてある", async () => {
    // 契約を書き換えて積み直そうとする（scope を広げる典型）
    h.writeTask("task-0001", TASK_FM("task-0001").replace("    - src/**", "    - '**'"));
    await assert.rejects(
      () => h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0001" }),
      /既に積まれています[\s\S]*kobo\.amend/,
      "訂正の道（kobo.amend）を案内すること——以前は「新しいタスクを積め」だった"
    );
    assert.deepEqual(
      (h.daemon.getTask(h.proj, "task-0001")!["scope"] as { paths: string[] }).paths,
      ["src/**"],
      "積み直しで契約が動いてはいけない（改訂は kobo.amend でだけ起きる）"
    );
  });

  it("知らないプロジェクト・知らないタスクは、知っているものを添えて止まる（I2）", async () => {
    await assert.rejects(
      () => h.call("kobo.enqueue", { projectTag: "no-such", taskId: "task-0001" }),
      /知りません/
    );
    await assert.rejects(
      () => h.call("kobo.task", { projectTag: h.proj, taskId: "task-9999" }),
      /ありません/
    );
  });

  it("一覧と経緯が読める（kobo.list / kobo.task）", async () => {
    const list = await h.call("kobo.list", { projectTag: h.proj });
    const tasks = list["tasks"] as Array<{ taskId: string; status: string }>;
    assert.ok(tasks.some((t) => t.taskId === "task-0001"));

    const detail = await h.call("kobo.task", { projectTag: h.proj, taskId: "task-0001" });
    const history = detail["history"] as Array<{ type: string }>;
    assert.ok(history.some((e) => e.type === "task_created"));
    assert.ok(history.some((e) => e.type === "gate_evaluated"));
  });

  it("Kobo が落ちていたら、黙って成功にしない（I2）", async () => {
    const dead = createKoboModule(`http://127.0.0.1:${await freePort()}${KOBO_MODULE_PATH}`);
    const enqueue = dead.tools.find((t) => t.name === "kobo.enqueue")!;
    await assert.rejects(
      () => enqueue.execute({ projectTag: h.proj, taskId: "task-0001" } as never, { toolCallId: "t" }),
      /Failed to reach module/
    );
  });
});

// ── 出口（task-0065）────────────────────────────────────────────────────────

describe("[task-0065] レビューは3段（決定57・66）", () => {
  it("既定は banto——監査を通ると review-ready で止まり、番頭が通せる", async () => {
    const h = await harness();
    try {
      h.writeTask("task-0010", TASK_FM("task-0010"));
      await h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0010", origin: threadOrigin(THREAD) });
      await until(() => h.daemon.getTask(h.proj, "task-0010")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0010", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0010", "pass", []);
      assert.equal(
        h.daemon.getTask(h.proj, "task-0010")?.status,
        "review-ready",
        "既定は番頭が一次受け（決定57）"
      );

      await h.call("kobo.approve", {
        projectTag: h.proj,
        taskId: "task-0010",
        note: "受け入れ基準を確かめた",
      });
      assert.equal(h.daemon.getTask(h.proj, "task-0010")?.status, "approved");

      const approved = h.daemon
        .getTaskEvents(h.proj, "task-0010")
        .find((e) => e.type === "task_approved") as { approvedBy?: string; note?: string } | undefined;
      assert.equal(approved?.approvedBy, "banto", "誰が通したかが帳簿に残る");
      assert.match(String(approved?.note), /確かめた/);
    } finally {
      await teardown(h);
    }
  });

  it("auto は番頭も見ずにマージへ進む", async () => {
    const h = await harness();
    try {
      h.writeTask("task-0011", TASK_FM("task-0011", "review:\n  policy: auto"));
      await h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0011" });
      await until(() => h.daemon.getTask(h.proj, "task-0011")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0011", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0011", "pass", []);
      assert.equal(h.daemon.getTask(h.proj, "task-0011")?.status, "merging");
    } finally {
      await teardown(h);
    }
  });

  it("[a2] governance: true は番頭には通せない。auto を名乗っていても po が勝つ", async () => {
    const h = await harness();
    try {
      h.writeTask(
        "task-0012",
        TASK_FM("task-0012", "governance: true\nreview:\n  policy: auto")
      );
      await h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0012" });
      await until(() => h.daemon.getTask(h.proj, "task-0012")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0012", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0012", "pass", []);
      assert.equal(
        h.daemon.getTask(h.proj, "task-0012")?.status,
        "review-ready",
        "統治コードは auto を名乗っても素通りしない（緩い方へ倒れない）"
      );

      await assert.rejects(
        () => h.call("kobo.approve", { projectTag: h.proj, taskId: "task-0012" }),
        /PO の判断が要ります/
      );
      assert.equal(h.daemon.getTask(h.proj, "task-0012")?.status, "review-ready");
    } finally {
      await teardown(h);
    }
  });

  it("[a3] meta/config.yaml に列挙した面に触るタスクは PO 直行になる（決定66）", async () => {
    const h = await harness({
      config: "review:\n  po_required_paths:\n    - packages/banto-web/**\n    - docs/spec/design.md\n",
    });
    try {
      h.writeTask(
        "task-0013",
        TASK_FM("task-0013").replace("    - src/**", "    - packages/banto-web/src/App.tsx")
      );
      await h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0013" });
      await until(() => h.daemon.getTask(h.proj, "task-0013")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0013", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0013", "pass", []);

      await assert.rejects(
        () => h.call("kobo.approve", { projectTag: h.proj, taskId: "task-0013" }),
        /PO の判断が要ります/,
        "番頭の付け忘れに依存せず、パスで機械的に判定される"
      );

      // 会話へ返す側も**工場に聞く**（ホスト側で推測しない）。ここがずれると、
      // PO 直行のタスクを「あなたが通してよい」と見せてしまう
      const detail = await h.call("kobo.task", { projectTag: h.proj, taskId: "task-0013" });
      assert.equal(detail["reviewStage"], "po");
    } finally {
      await teardown(h);
    }
  });

  it("設定が壊れていたら、黙って緩い方へ倒れず止まる（I2）", async () => {
    const h = await harness({ config: "review:\n  po_required_paths: これは配列ではない\n" });
    try {
      h.writeTask("task-0014", TASK_FM("task-0014"));
      // **積む時点で止まる**。緩い既定（banto）へ倒して受け付けると、PO 必須の面に触る
      // タスクが素通りしうる——設定を直すまで進ませない方が安全側
      await assert.rejects(
        () => h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0014" }),
        /配列で書いてください/
      );
      assert.equal(h.daemon.getTask(h.proj, "task-0014"), undefined, "積まれていないこと");
    } finally {
      await teardown(h);
    }
  });

  it("[a6] 番頭が通しても関所は飛ばない（approved の先にマージ前ゲートがある）", async () => {
    const h = await harness();
    try {
      h.writeTask("task-0015", TASK_FM("task-0015"));
      await h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0015" });
      await until(() => h.daemon.getTask(h.proj, "task-0015")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0015", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0015", "pass", []);
      await h.call("kobo.approve", { projectTag: h.proj, taskId: "task-0015" });

      // 承認は `approved` まで。マージするのはキューで、その前にゲートが回る
      assert.equal(h.daemon.getTask(h.proj, "task-0015")?.status, "approved");
      /**
       * **止める道具は、飛ばす道具ではない**（PO 裁定 2026-08-13・inc-0063）。
       *
       * 名前の部分一致は「関所を飛ばす道具」を見つけるための当て推量でしかない。
       * `kobo.set_merge_queue` はマージキューを**止める**弁で、通せるものを増やさない
       * ——止めれば何もマージされず、開ければ関所つきの通常の道に戻るだけ。
       * ここに載せるのは、**通す方向に働かないと確かめたもの**だけにすること。
       */
      const STOPPING_NOT_SKIPPING = new Set(["kobo.set_merge_queue"]);
      const koboTools = h.tools.map((t) => t.name);
      const suspicious = koboTools.filter(
        (n) => /merge|gate|force/.test(n) && !STOPPING_NOT_SKIPPING.has(n)
      );
      assert.deepEqual(
        suspicious,
        [],
        `番頭にゲートを飛ばす道具が無いこと。持っているのは: ${koboTools.join(", ")}`
      );
    } finally {
      await teardown(h);
    }
  });
});

// ── 判断が会話へ返る（task-0065・決定58）──────────────────────────────────

describe("[task-0065] 判断待ちは積んだスレッドへ返る（決定58）", () => {
  it("レビュー待ちが、積んだスレッド宛に三部構成で届く", async () => {
    const h = await harness();
    const delivered: Array<{ message: string; threadId?: string }> = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0020", TASK_FM("task-0020"));
      await h.call("kobo.enqueue", {
        projectTag: h.proj,
        taskId: "task-0020",
        origin: threadOrigin(THREAD),
        originRef: "PO から「一覧が遅いので直して」と言われた",
      });

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message, target) => {
          delivered.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, "task-0020")?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, "task-0020", to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, "task-0020", "pass", []);

      await until(() => delivered.some((d) => /レビュー待ち/.test(d.message)));
      const notice = delivered.find((d) => /レビュー待ち/.test(d.message))!;
      assert.equal(notice.threadId, THREAD, "積んだスレッドへ返る（決定58）");
      assert.match(notice.message, /経緯[\s\S]*一覧が遅いので直して/, "経緯が書いてある");
      assert.match(notice.message, /起きたこと[\s\S]*監査を通りました/, "起きたことが書いてある");
      assert.match(notice.message, /求める判断[\s\S]*kobo\.approve/, "求める判断が書いてある");
      assert.match(notice.message, /関所は飛びません/, "承認しても検査は残ることが書いてある");
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  it("進行の実況は流さない（planning・implementing で会話を埋めない）", async () => {
    const h = await harness();
    const delivered: string[] = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0021", TASK_FM("task-0021"));
      await h.call("kobo.enqueue", {
        projectTag: h.proj,
        taskId: "task-0021",
        origin: threadOrigin(THREAD),
      });
      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });
      await until(() => h.daemon.getTask(h.proj, "task-0021")?.status === "ready");
      for (const to of ["planning", "implementing"]) {
        h.daemon.transition(h.proj, "task-0021", to, "test");
      }
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(delivered, [], "着手・実装中は知らせない（要点だけが会話に来る）");
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  it("止まったことは届く。理由と次の判断つき（I2）", async () => {
    const h = await harness();
    const delivered: string[] = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0022", TASK_FM("task-0022"));
      await h.call("kobo.enqueue", {
        projectTag: h.proj,
        taskId: "task-0022",
        origin: threadOrigin(THREAD),
      });
      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });
      await until(() => h.daemon.getTask(h.proj, "task-0022")?.status === "ready");
      h.daemon.transition(h.proj, "task-0022", "failed", "職人が報告せずに終わった");

      await until(() => delivered.some((m) => /止まりました/.test(m)));
      const notice = delivered.find((m) => /止まりました/.test(m))!;
      assert.match(notice, /起きたこと[\s\S]*報告せずに終わった/);
      assert.match(notice, /求める判断/);
    } finally {
      stop?.();
      await teardown(h);
    }
  });

  /**
   * **この検査は逆を見ていた**（PO報告 2026-08-07・inc-0030）。
   *
   * もとは「宛先の無いものを既定スレッドへ流し込まない」と書いてあり、そのとおり
   * 捨てていた。だが `origin` が付くのは `kobo.enqueue` 経由だけで、**タスク定義ファイルを
   * watcher が取り込んだもの（決定64 の正規の入口）には付かない**——実機の loamium は
   * 2本ともファイル経由で、監査で落ちたことも判断待ちも1通残らず捨てられていた。
   *
   * 宛先が分からないことは、知らせなくてよい理由にならない（I2）。
   */
  it("宛先が無いタスクの知らせも、既定のスレッドへ届く（捨てない）", async () => {
    const h = await harness();
    const delivered: Array<{ message: string; threadId?: string }> = [];
    let stop: (() => void) | undefined;
    try {
      h.writeTask("task-0023", TASK_FM("task-0023"));
      // origin なしで積む＝宛先が無い
      await h.call("kobo.enqueue", { projectTag: h.proj, taskId: "task-0023" });
      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message, target) => {
          delivered.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });
      await until(() => h.daemon.getTask(h.proj, "task-0023")?.status === "ready");
      h.daemon.transition(h.proj, "task-0023", "failed", "テスト");

      await until(() => delivered.some((d) => /止まりました/.test(d.message)));
      const notice = delivered.find((d) => /止まりました/.test(d.message))!;
      assert.equal(notice.threadId, undefined, "宛先が無いものは既定のスレッドへ");
      assert.match(notice.message, /task-0023/);
    } finally {
      stop?.();
      await teardown(h);
    }
  });
});
