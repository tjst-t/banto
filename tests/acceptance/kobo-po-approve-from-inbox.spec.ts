/**
 * imp-0034（ADR-0023 決定113）: **帳場で出した「マージしてよい」が、工場の帳簿まで届く。**
 *
 * **踏んだこと**（2026-08-15・dentaku task-0005）。`review.policy: po` のタスクは決定57 により
 * 番頭が通せない。番頭は `inbox.post`（`canvasKind: "kobo.review"`）で PO に判断を仰ぎ、
 * PO は札の選択肢を押して答えた——**ところがその答えは工場へ一切流れなかった**。
 * 番頭が続けて `kobo.approve` を呼ぶと 500 で断られ、PO はレビュー面をもう一度開いて
 * 承認ボタンを押す二度手間を踏んだ。**PO の意思表示の口が2つあり、片方は何にも繋がっていない。**
 *
 * ここで見張るのは端から端まで——札を積み、**画面から押し**、工場のタスクが `approved` まで
 * 進み、`approvedBy: "po"` と**どの札のどの回答で通ったか**が帳簿に残ること。
 * 途中を偽物にすると「繋がっているつもり」がまた通ってしまうので、工場は本物の `Daemon`、
 * 取次とホストも本物、押すのは本物の WebSocket。
 *
 * 逆向きの確認も同じだけ大事：**LLM からは通せないままであること**（決定57 は変えていない）。
 *   - `kobo.approve`（番頭に渡っている Tool）は PO 必須のタスクを断り続ける
 *   - 承認の口（`kobo.po_approve`）は `internalTools`——番頭の在庫に載らない
 *   - `inbox.resolve`（番頭に渡っている Tool）では、処理を伴う選択肢を畳めない
 *   - 配る形（`InboxItemView`）に呼び出し先は載らない
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness } from "@banto/core";
import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Inbox,
  ThreadRegistry,
  createInboxTools,
  createKoboPoDecisionTool,
  createModuleRegistry,
  koboPoDecisionEffect,
  koboReviewTarget,
  type InboxEffect,
  type NamespacedToolDefinition,
} from "@banto/host";
import {
  Daemon,
  KOBO_MODULE_PATH,
  createKoboModule,
  createKoboTools,
} from "@banto/daemon";
import { deriveQueue } from "../../packages/banto-daemon/src/merge-queue.js";
import { TRUNK } from "./threadSpecs.js";

const PROJ = "inbox-approve-proj";

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

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** ターンの進行だけをこちらから見られるセッション（プロバイダを呼ばない）。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  readonly backendId = "fake";
  isStreaming = false;
  prompts: string[] = [];
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

interface Harness {
  daemon: Daemon;
  inbox: Inbox;
  server: BantoHostServer;
  wsUrl: string;
  session: FakeSession;
  /** 番頭に渡っている Tool（＝モデルから呼べるもの）。 */
  bantoTools: NamespacedToolDefinition[];
  /** 取次の Tool（番頭が札を積む口）。 */
  inboxTools: Record<string, NamespacedToolDefinition>;
  tmpDir: string;
}

/**
 * 工場（本物）と番頭ホスト（本物）を立て、bin.ts と**同じ結線**を張る。
 *
 * 結線を試験の中で作り直しているのは、bin.ts が起動時に組む形をそのまま写すため
 * ——ここを偽物にすると「配線したつもり」が試験を通ってしまう（imp-0034 がそれ）。
 */
async function harness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-inbox-approve-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
  // 決定57・66: PO 必須の面（この判定表はプロジェクトの持ち物）
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "meta", "config.yaml"),
    "review:\n  po_required_paths:\n    - packages/banto-web/**\n",
    "utf-8"
  );

  const koboPort = await freePort();
  const daemon = Daemon.create({
    port: koboPort,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    // **稼働中の器に触らせない**（`npm test` 以外の走らせ方でも同じであること）。
    // 差し戻しは職人を起こす道を通る（`spawnReworkSession`）——ここを塞がないと、
    // 試験が本物の Worker Pool に職人を1本残し、番頭からは正体不明の職人に見える
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    workerPoolUrl: "http://127.0.0.1:1/api/worker-pool",
    // マージキューは approved を拾って実際に rebase しに行く。ここでは列に載ることだけを見る
    disableMergeQueue: true,
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const koboUrl = `http://127.0.0.1:${koboPort}${KOBO_MODULE_PATH}`;
  const koboModule = {
    ...createKoboModule(koboUrl),
    // bin.ts と同じ：PO の判断を届ける口は internalTools（番頭には渡らない）
    internalTools: [createKoboPoDecisionTool(koboUrl)],
  };
  const modules = createModuleRegistry([koboModule]);

  const inbox = new Inbox(path.join(tmpDir, "inbox.jsonl"));
  const inboxToolList = createInboxTools(inbox, {
    threadId: "t-1",
    // bin.ts と同じ結線（決定113）
    resolvePoDecisionEffect: ({ canvasKind, canvasParams, decision, detail }) => {
      const target = koboReviewTarget(canvasKind, canvasParams);
      if (!target) return undefined;
      if (decision !== "approve" && decision !== "send_back") return undefined;
      return koboPoDecisionEffect(target, decision, detail);
    },
  });
  const inboxTools = Object.fromEntries(inboxToolList.map((t) => [t.name, t]));

  let session!: FakeSession;
  const threads = new ThreadRegistry(async () => {
    session = new FakeSession();
    return { harness: session, tools: [] };
  });
  await threads.open(TRUNK);

  const server = await BantoHostServer.start({
    threads,
    inbox,
    port: 0,
    // bin.ts と同じ：モジュールの帳簿から引き、出どころを `originArg` で渡す
    runInboxEffect: async (effect: InboxEffect, origin) => {
      const owner = modules.get(effect.module);
      if (!owner) throw new Error(`モジュール "${effect.module}" は登録されていません`);
      const tool = [...owner.tools, ...(owner.internalTools ?? [])].find(
        (t) => t.name === effect.tool
      );
      if (!tool) throw new Error(`"${effect.module}" に Tool "${effect.tool}" はありません`);
      const args = {
        ...(effect.args ?? {}),
        ...(effect.originArg
          ? { [effect.originArg]: `inbox:${origin.itemId}#${origin.actionId}` }
          : {}),
      };
      const result = await tool.execute(args as never, { toolCallId: "test" });
      return result.content.map((c) => c.text ?? "").join("");
    },
  });

  return {
    daemon,
    inbox,
    server,
    wsUrl: `ws://localhost:${server.port}${BANTO_WS_PATH}`,
    session,
    // 番頭に渡っているのは `tools` だけ（`internalTools` は載らない）
    bantoTools: modules.tools(),
    inboxTools,
    tmpDir,
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** PO 必須の面に触るタスクを判断待ちまで運ぶ。 */
function driveToReviewReady(daemon: Daemon, taskId: string): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: ["packages/banto-web/src/**"] },
    acceptance: [{ id: "a1", text: "動く" }],
  });
  for (const to of ["queued", "ready", "planning", "implementing", "auditing", "review-ready"]) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
}

/** 番頭がするのと同じ積み方（`canvasKind` / `canvasParams` / `approveAction` を添える）。 */
async function postReviewCard(
  h: Harness,
  taskId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const result = await h.inboxTools["inbox.post"]!.execute({
    sourceId: "kobo",
    sourceLabel: "工場（テスト）",
    kind: "番頭では決められない",
    rule: "決定57",
    title: `${taskId} を通してよいか`,
    why: "POから「電卓を作って」と言われた",
    what: "実装が終わり、監査を通った",
    ask: "マージしてよいか",
    actions: [
      { id: "approve", label: "通す（マージへ）", tone: "call" },
      { id: "send_back", label: "差し戻す" },
    ],
    canvasKind: "kobo.review",
    canvasParams: { projectTag: PROJ, taskId },
    approveAction: "approve",
    sendBackAction: "send_back",
    sendBackReason: "受け入れ基準 a1 を満たしていない",
    ...overrides,
  } as never);
  return (result.details as { id: string }).id;
}

/** 条件が満たされるまで待つ（押した結果が届くのを待ち合わせる）。 */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("[imp-0034/決定113] 札で出した PO の答えが工場の帳簿まで届く", () => {
  let h: Harness;
  /** 通す方の札。畳まれたことを名指しで確かめるために覚えておく */
  let approveCard: string;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("前提：このタスクは番頭では通せない（決定57 は変えていない）", async () => {
    driveToReviewReady(h.daemon, "task-4001");

    // 番頭に渡っている本物の Tool を、番頭と同じように呼ぶ
    const approve = createKoboTools(h.daemon).find((t) => t.name === "kobo.approve")!;
    await assert.rejects(
      () => approve.execute({ projectTag: PROJ, taskId: "task-4001" } as never),
      /PO の判断が要ります/,
      "番頭が通せてしまっている"
    );
    assert.equal(h.daemon.getTask(PROJ, "task-4001")?.status, "review-ready");
  });

  it("POが札の「通す」を押すと、工場で `approved`（＝マージ待ち）へ進む", async () => {
    approveCard = await postReviewCard(h, "task-4001");

    const client = await BantoHostClient.connect(h.wsUrl, () => {});
    client.send({ type: "inbox_answer", itemId: approveCard, actionId: "approve" });

    await until(
      () => h.daemon.getTask(PROJ, "task-4001")?.status === "approved",
      "工場のタスクが approved まで進むこと"
    );
    client.close();
  });

  it("帳簿に **PO の名前**と、**どの札のどの回答で通ったか**が残る", () => {
    const approved = h.daemon
      .getTaskEvents(PROJ, "task-4001")
      .find((e) => e.type === "task_approved") as { approvedBy: string; via?: string };
    assert.equal(approved.approvedBy, "po", "番頭の名前で書かれている");
    assert.match(
      approved.via ?? "",
      /^inbox:in-[0-9a-f]+#approve$/,
      "どの札のどの回答で通ったかが残っていない（合言葉をやめた代わりの担保）"
    );
  });

  /**
   * **マージ待ちの列に載ること**（PO要望 2026-08-15）。`approved` は状態機械の
   * 終点ではなく、直列マージキューの**入口**——ここに載って初めて `merging` へ進む。
   * 「承認は記録されたが誰も拾わない」を通さないために、列そのものを見る。
   */
  it("マージ待ちの列に載る（承認が帳簿に残るだけで終わらない）", () => {
    const queued = deriveQueue(h.daemon.getAllEvents()).find((e) => e.taskId === "task-4001");
    assert.ok(queued, "承認したのにマージキューに載っていない");
    assert.equal(queued.status, "approved", "マージ待ちとして並んでいない");
  });

  it("関所は飛ばない（承認の後にマージ前ゲートが回る・決定57）", () => {
    // `approved` は**マージではない**。ここから先はマージキューがゲートを回す
    assert.equal(h.daemon.getTask(PROJ, "task-4001")?.status, "approved");
    const merged = h.daemon
      .getTaskEvents(PROJ, "task-4001")
      .some((e) => e.type === "gate_evaluated" && (e as { passed?: boolean }).passed === true);
    assert.equal(merged, false, "承認だけでゲートを通ったことにしている");
  });

  /**
   * **戻す側を落とさない**（PO要望 2026-08-15）。通す側だけ結ぶと、PO が「駄目だ」と
   * 押しても何も起きない札になる——imp-0034 の形が半分だけ残る。
   */
  it("POが札の「差し戻す」を押すと、工場が実装へ戻す", async () => {
    driveToReviewReady(h.daemon, "task-4003");
    const itemId = await postReviewCard(h, "task-4003");

    const client = await BantoHostClient.connect(h.wsUrl, () => {});
    client.send({ type: "inbox_answer", itemId, actionId: "send_back" });

    await until(
      () => h.daemon.getTask(PROJ, "task-4003")?.status === "implementing",
      "工場のタスクが implementing へ戻ること"
    );
    // 指摘は帳簿に残り、どこから来た判断かも分かる
    const back = h.daemon
      .getTaskEvents(PROJ, "task-4003")
      .filter((e) => e.type === "state_transitioned")
      .map((e) => (e as { reason?: string }).reason ?? "")
      .find((r) => r.startsWith("sent_back_by:"));
    assert.match(back ?? "", /^sent_back_by:po@inbox:in-[0-9a-f]+#send_back/, back ?? "差し戻しの記録が無い");
    assert.match(back ?? "", /受け入れ基準 a1 を満たしていない/, "指摘が職人へ渡っていない");
    client.close();
  });

  it("札は畳まれ、番頭には答えが伝わる（同じことをもう一度訊かせない）", async () => {
    await until(() => h.inbox.get(approveCard)?.resolvedAt !== undefined, "札が畳まれること");
    assert.equal(h.inbox.get(approveCard)?.resolution, "approve");
    await until(() => h.session.prompts.length > 0, "番頭のターンが回ること");
    assert.match(h.session.prompts[0]!, /通す（マージへ）/);
  });
});

describe("[imp-0034/決定113] 番頭（LLM）からは通せないまま", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("PO の判断を届ける口は番頭の在庫に載らない（`internalTools`）", () => {
    assert.equal(
      h.bantoTools.some((t) => t.name === "kobo.po_decide"),
      false,
      "番頭が呼べる一覧に PO の口が載っている"
    );
    assert.equal(
      h.bantoTools.some((t) => t.name === "kobo.approve"),
      true,
      "前提が崩れている（番頭の承認の口が消えている）"
    );
  });

  it("`inbox.resolve` では畳めない（押すのは PO・処理は走らない）", async () => {
    driveToReviewReady(h.daemon, "task-4002");
    const itemId = await postReviewCard(h, "task-4002");

    await assert.rejects(
      () => h.inboxTools["inbox.resolve"]!.execute({ id: itemId, action: "approve" } as never),
      /あなたは畳めません/,
      "番頭が札を畳めてしまっている"
    );
    assert.equal(
      h.daemon.getTask(PROJ, "task-4002")?.status,
      "review-ready",
      "番頭の操作で状態が動いている"
    );
    assert.equal(h.inbox.get(itemId)?.resolvedAt, undefined, "札が畳まれてしまっている");
  });

  it("処理を伴わない選択肢は今までどおり畳める（POが会話の中で答えたとき）", async () => {
    const itemId = await postReviewCard(h, "task-4002", {
      approveAction: undefined,
      sendBackAction: undefined,
      sendBackReason: undefined,
      title: "呼び方をどちらにするか",
    });
    await h.inboxTools["inbox.resolve"]!.execute({ id: itemId, action: "approve" } as never);
    assert.ok(h.inbox.get(itemId)?.resolvedAt, "承認を伴わない札まで畳めなくなっている");
  });

  it("配る形に呼び出し先は載らない（画面から任意の口を叩けない・決定73）", () => {
    const view = h.inbox.list().find((i) => !i.resolvedAt)!;
    for (const action of view.actions) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(action, "effect"),
        `選択肢 ${action.id} に呼び出し先が載っている`
      );
    }
    assert.equal(h.inbox.get(view.id)!.actions[0]!.effect?.tool, "kobo.po_decide");
  });

  /**
   * I2: 結べない札を黙って積まない。積めてしまうと、PO が押しても何も起きない
   * ——それが imp-0034 そのもの。
   */
  it("結べない札は積む時点で断る（押しても何も起きない札を作らない）", async () => {
    await assert.rejects(
      () => postReviewCard(h, "task-4002", { canvasKind: undefined }),
      /approveAction を結べません/
    );
    await assert.rejects(
      () => postReviewCard(h, "task-4002", { approveAction: "yes" }),
      /approveAction "yes" は actions にありません/
    );
  });
});
