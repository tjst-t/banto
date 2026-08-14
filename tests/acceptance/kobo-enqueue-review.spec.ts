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
  /** 第4便: 積むのは道具の入力から。**id は Kobo が振る**ので返す */
  enqueue(args?: Record<string, unknown>): Promise<Record<string, unknown>>;
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
    async enqueue(args = {}) {
      const tool = tools.find((t) => t.name === "kobo.enqueue");
      if (!tool) throw new Error("no tool: kobo.enqueue");
      const result = await tool.execute(
        { projectTag: proj, ...TASK_INPUT, ...args } as never,
        { toolCallId: "t" }
      );
      return (result.details ?? {}) as Record<string, unknown>;
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

/** 積むときの最小の入力（第4便：番頭が渡すのはこれ全部）。 */
const TASK_INPUT = {
  title: "工場に積む仕事",
  kind: "feature",
  body: "この依頼の本文。",
  scope: { paths: ["src/**"] },
  acceptance: [{ text: "動くこと" }],
  originRef: "試験",
};

// ── 入口（task-0064）────────────────────────────────────────────────────────

describe("[task-0064] 番頭が工場に積む（入口）", () => {
  let h: Harness;
  let firstId: string;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("依頼の中身を渡すと Kobo が採番して積み、ゲートを通って ready になる", async () => {
    const details = await h.enqueue({
      origin: threadOrigin(THREAD),
      originRef: "PO から「まず1本通してほしい」と言われた",
    });
    firstId = String(details["taskId"]);
    assert.match(firstId, /^task-\d{4}$/, "**番頭は番号を決めない**——Kobo が振る");
    assert.equal(details["path"], `work/tasks/${firstId}.md`, "記録の在り処が返る");

    await until(() => h.daemon.getTask(h.proj, firstId)?.status === "ready");
  });

  it("記録ファイルは Kobo が書く（番頭は書かない）", () => {
    const record = fs.readFileSync(path.join(h.repoDir, "work", "tasks", `${firstId}.md`), "utf-8");
    assert.match(record, new RegExp(`^id: ${firstId}$`, "m"));
    assert.match(record, /^written_by: kobo$/m);
    assert.match(record, /この依頼の本文/);
  });

  it("[a2/a3] 宛先（積んだスレッド）と経緯が一緒に残る", () => {
    const task = h.daemon.getTask(h.proj, firstId)!;
    assert.equal(task["origin"], threadOrigin(THREAD), "積んだスレッドが残る（決定58）");
    assert.match(String(task["originRef"]), /まず1本通してほしい/, "経緯が残る（D8）");
  });

  it("依頼の本文が契約と一緒に凍る（職人に届くのはこれ）", () => {
    const task = h.daemon.getTask(h.proj, firstId)!;
    assert.match(String(task["body"]), /この依頼の本文/);
    assert.deepEqual((task["scope"] as { paths: string[] }).paths, ["src/**"]);
  });

  it("受け入れ条件の id は Kobo が振る（番頭は書かない）", () => {
    const acceptance = h.daemon.getTask(h.proj, firstId)!["acceptance"] as Array<{ id: string }>;
    assert.deepEqual(acceptance.map((a) => a.id), ["a1"]);
  });

  it("[a4] 積めないときは理由が返る：必須が欠けている", async () => {
    await assert.rejects(
      () => h.enqueue({ scope: { paths: [] } }),
      /scope\.paths/
    );
    await assert.rejects(() => h.enqueue({ acceptance: [] }), /acceptance/);
  });

  it("[決定62c] 契約は入力から凍る。記録ファイルを直しても動かない", () => {
    const filePath = path.join(h.repoDir, "work", "tasks", `${firstId}.md`);
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, "utf-8").replace('paths: ["src/**"]', 'paths: ["**"]'),
      "utf-8"
    );
    assert.deepEqual(
      (h.daemon.getTask(h.proj, firstId)!["scope"] as { paths: string[] }).paths,
      ["src/**"],
      "記録を直して契約が動くなら、マージ前ゲートの検査を後から緩められる"
    );
  });

  it("知らないプロジェクト・知らないタスクは、知っているものを添えて止まる（I2）", async () => {
    await assert.rejects(() => h.enqueue({ projectTag: "no-such" }), /知りません/);
    await assert.rejects(
      () => h.call("kobo.task", { projectTag: h.proj, taskId: "task-9999" }),
      /ありません/
    );
  });

  it("一覧と経緯が読める（kobo.list / kobo.task）", async () => {
    const list = await h.call("kobo.list", { projectTag: h.proj });
    const tasks = list["tasks"] as Array<{ taskId: string; status: string }>;
    assert.ok(tasks.some((t) => t.taskId === firstId));

    const detail = await h.call("kobo.task", { projectTag: h.proj, taskId: firstId });
    const history = detail["history"] as Array<{ type: string }>;
    assert.ok(history.some((e) => e.type === "task_created"));
    assert.ok(history.some((e) => e.type === "gate_evaluated"));
  });

  it("Kobo が落ちていたら、黙って成功にしない（I2）", async () => {
    const dead = createKoboModule(`http://127.0.0.1:${await freePort()}${KOBO_MODULE_PATH}`);
    const enqueue = dead.tools.find((t) => t.name === "kobo.enqueue")!;
    await assert.rejects(
      () => enqueue.execute({ projectTag: h.proj, ...TASK_INPUT } as never, { toolCallId: "t" }),
      /Failed to reach module/
    );
  });
});

// ── 出口（task-0065）────────────────────────────────────────────────────────

describe("[task-0065] レビューは3段（決定57・66）", () => {
  it("既定は banto——監査を通ると review-ready で止まり、番頭が通せる", async () => {
    const h = await harness();
    try {
      const id = String((await h.enqueue({ origin: threadOrigin(THREAD) }))["taskId"]);
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);
      assert.equal(
        h.daemon.getTask(h.proj, id)?.status,
        "review-ready",
        "既定は番頭が一次受け（決定57）"
      );

      await h.call("kobo.approve", {
        projectTag: h.proj,
        taskId: id,
        note: "受け入れ基準を確かめた",
      });
      assert.equal(h.daemon.getTask(h.proj, id)?.status, "approved");

      const approved = h.daemon
        .getTaskEvents(h.proj, id)
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
      const id = String((await h.enqueue({ review: { policy: "auto" } }))["taskId"]);
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);
      assert.equal(h.daemon.getTask(h.proj, id)?.status, "merging");
    } finally {
      await teardown(h);
    }
  });

  it("[a2] governance: true は番頭には通せない。auto を名乗っていても po が勝つ", async () => {
    const h = await harness();
    try {
      const id = String(
        (await h.enqueue({ governance: true, review: { policy: "auto" } }))["taskId"]
      );
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);
      assert.equal(
        h.daemon.getTask(h.proj, id)?.status,
        "review-ready",
        "統治コードは auto を名乗っても素通りしない（緩い方へ倒れない）"
      );

      await assert.rejects(
        () => h.call("kobo.approve", { projectTag: h.proj, taskId: id }),
        /PO の判断が要ります/
      );
      assert.equal(h.daemon.getTask(h.proj, id)?.status, "review-ready");
    } finally {
      await teardown(h);
    }
  });

  it("[a3] meta/config.yaml に列挙した面に触るタスクは PO 直行になる（決定66）", async () => {
    const h = await harness({
      config: "review:\n  po_required_paths:\n    - packages/banto-web/**\n    - docs/spec/design.md\n",
    });
    try {
      const id = String(
        (await h.enqueue({ scope: { paths: ["packages/banto-web/src/App.tsx"] } }))["taskId"]
      );
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);

      await assert.rejects(
        () => h.call("kobo.approve", { projectTag: h.proj, taskId: id }),
        /PO の判断が要ります/,
        "番頭の付け忘れに依存せず、パスで機械的に判定される"
      );

      // 会話へ返す側も**工場に聞く**（ホスト側で推測しない）。ここがずれると、
      // PO 直行のタスクを「あなたが通してよい」と見せてしまう
      const detail = await h.call("kobo.task", { projectTag: h.proj, taskId: id });
      assert.equal(detail["reviewStage"], "po");
    } finally {
      await teardown(h);
    }
  });

  it("設定が壊れていたら、黙って緩い方へ倒れず止まる（I2）", async () => {
    const h = await harness({ config: "review:\n  po_required_paths: これは配列ではない\n" });
    try {
      // **積む時点で止まる**。緩い既定（banto）へ倒して受け付けると、PO 必須の面に触る
      // タスクが素通りしうる——設定を直すまで進ませない方が安全側
      await assert.rejects(() => h.enqueue(), /配列で書いてください/);
      assert.equal(h.daemon.getTasksByProject(h.proj).length, 0, "積まれていないこと");
    } finally {
      await teardown(h);
    }
  });

  it("[a6] 番頭が通しても関所は飛ばない（approved の先にマージ前ゲートがある）", async () => {
    const h = await harness();
    try {
      const id = String((await h.enqueue())["taskId"]);
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);
      await h.call("kobo.approve", { projectTag: h.proj, taskId: id });

      // 承認は `approved` まで。マージするのはキューで、その前にゲートが回る
      assert.equal(h.daemon.getTask(h.proj, id)?.status, "approved");
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
      const id = String(
        (
          await h.enqueue({
            origin: threadOrigin(THREAD),
            originRef: "PO から「一覧が遅いので直して」と言われた",
          })
        )["taskId"]
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

      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);

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
      const id = String((await h.enqueue({ origin: threadOrigin(THREAD) }))["taskId"]);
      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing"]) {
        h.daemon.transition(h.proj, id, to, "test");
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
      const id = String((await h.enqueue({ origin: threadOrigin(THREAD) }))["taskId"]);
      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      h.daemon.transition(h.proj, id, "failed", "職人が報告せずに終わった");

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
   * 捨てていた。だが `origin` が付くのは会話から積まれたときだけで、当時の正規の入口
   * だったファイル経由（watcher）には付かなかった——実機の loamium は2本ともファイル
   * 経由で、監査で落ちたことも判断待ちも1通残らず捨てられていた。
   *
   * **第4便で入口が1つになり、会話から積めば宛先は必ず付く。** それでも捨てないことは
   * 確かめ続ける：CLI や内部の口から積まれたものには宛先が無く、
   * 宛先が分からないことは知らせなくてよい理由にならない（I2）。
   */
  it("宛先が無いタスクの知らせも、既定のスレッドへ届く（捨てない）", async () => {
    const h = await harness();
    const delivered: Array<{ message: string; threadId?: string }> = [];
    let stop: (() => void) | undefined;
    try {
      // origin なしで積む＝宛先が無い
      const id = String((await h.enqueue())["taskId"]);
      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message, target) => {
          delivered.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });
      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      h.daemon.transition(h.proj, id, "failed", "テスト");

      await until(() => delivered.some((d) => /止まりました/.test(d.message)));
      const notice = delivered.find((d) => /止まりました/.test(d.message))!;
      assert.equal(notice.threadId, undefined, "宛先が無いものは既定のスレッドへ");
      assert.match(notice.message, new RegExp(id));
    } finally {
      stop?.();
      await teardown(h);
    }
  });
});
