/**
 * task-0273 穴1: **緩める向きの契約改訂が、PO の取次承認（inbox 経由）で適用できる。**
 *
 * **踏んだこと**（2026-08-17 実測）。task-0271 の契約を「deepseek を外す」→「deepseek は
 * 残し Kimi 系を追加」と訂正しようとしたとき、番頭の `kobo.amend`（`by: "banto"`）は
 * `if (loosens && options.by !== "po")`（daemon.ts）で「緩める方向なので取次へ上げてください」と
 * 断った。PO が取次で「訂正してよい」と承認したのに、その承認が `amendTask(by: "po")` へ
 * 届く経路が無く、同じ拒否を繰り返した。
 *
 * **正すこと**（task-0273）: PO の取次承認を工場の `po-decision`（`decision: "amend"`）へ
 * 結び、`amendTask(by: "po")` として適用できるようにする。守りは壊さない——via 必須・
 * `inbox.resolve` での畳み拒否・`kobo.amend`（by banto）の拒否・決定57（番頭から押せない）。
 *
 * ここで見張るのは端から端まで——札を積み、**画面から押し**、工場の契約が改訂（`by: "po"`）
 * され、監査が無効になって implementing へ戻ること。途中を偽物にすると「繋がっているつもり」が
 * 通ってしまうので、工場は本物の `Daemon`、取次とホストも本物、押すのは本物の WebSocket。
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
  koboAmendTarget,
  koboPoDecisionEffect,
  koboReviewTarget,
  type InboxEffect,
  type NamespacedToolDefinition,
} from "@banto/host";
import { Daemon, KOBO_MODULE_PATH, createKoboModule, createKoboTools } from "@banto/daemon";
import { TRUNK } from "./threadSpecs.js";

const PROJ = "po-amend-proj";

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
  bantoTools: NamespacedToolDefinition[];
  inboxTools: Record<string, NamespacedToolDefinition>;
  tmpDir: string;
}

/**
 * 工場（本物）と番頭ホスト（本物）を立て、bin.ts と**同じ結線**を張る（task-0273 の
 * 改訂面・`kobo.amend` の結線を含む）。
 */
async function harness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-po-amend-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
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
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    workerPoolUrl: "http://127.0.0.1:1/api/worker-pool",
    disableMergeQueue: true,
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const koboUrl = `http://127.0.0.1:${koboPort}${KOBO_MODULE_PATH}`;
  const koboModule = {
    ...createKoboModule(koboUrl),
    internalTools: [createKoboPoDecisionTool(koboUrl)],
  };
  const modules = createModuleRegistry([koboModule]);

  const inbox = new Inbox(path.join(tmpDir, "inbox.jsonl"));
  const inboxToolList = createInboxTools(inbox, {
    threadId: "t-1",
    // bin.ts と同じ結線（決定113・task-0273）
    resolvePoDecisionEffect: ({ canvasKind, canvasParams, decision, detail, changes }) => {
      const review = koboReviewTarget(canvasKind, canvasParams);
      if (review) {
        if (decision === "approve" || decision === "send_back") {
          return koboPoDecisionEffect(review, decision, detail);
        }
        return undefined;
      }
      const amend = koboAmendTarget(canvasKind, canvasParams);
      if (amend && decision === "amend") {
        return koboPoDecisionEffect(amend, "amend", detail, changes);
      }
      return undefined;
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

const ACCEPT_ORIGINAL = [{ id: "a1", text: "deepseek を外す" }];
/** 緩める向きの改訂（基準を変える）。task-0271 の実例に倣う。 */
const ACCEPT_AMENDED = [{ id: "a1", text: "deepseek は残し Kimi 系を追加" }];

/** タスクを作り、review-ready まで持って行く。 */
function driveToReviewReady(daemon: Daemon, taskId: string): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: ["packages/banto-web/src/**"] },
    acceptance: ACCEPT_ORIGINAL,
  });
  for (const to of ["queued", "ready", "planning", "implementing", "auditing", "review-ready"]) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
}

/** 番頭がするのと同じ改訂の確認札を積む（`canvasKind: "kobo.amend"`）。 */
async function postAmendCard(
  h: Harness,
  taskId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const result = await h.inboxTools["inbox.post"]!.execute({
    sourceId: "kobo",
    sourceLabel: "工場（テスト）",
    kind: "番頭では決められない",
    rule: "task-0273",
    title: `${taskId} の契約を訂正してよいか`,
    why: "POから「deepseek は残し Kimi 系を追加」と訂正指示があった",
    what: "kobo.amend は緩める方向を番頭では通せない",
    ask: "訂正してよいか",
    actions: [
      { id: "apply", label: "訂正する（適用）", tone: "call" },
      { id: "keep", label: "いまのまま" },
    ],
    canvasKind: "kobo.amend",
    canvasParams: { projectTag: PROJ, taskId },
    amendAction: "apply",
    amendReason: "PO からの訂正指示：deepseek は残し Kimi 系を追加",
    amendChanges: { acceptance: ACCEPT_AMENDED },
    ...overrides,
  } as never);
  return (result.details as { id: string }).id;
}

/** 条件が満たされるまで待つ。 */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("[task-0273/穴1] 緩める向きの改訂が PO 承認（取次）で適用される", () => {
  let h: Harness;
  let amendCard: string;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("前提：この改訂は番頭（kobo.amend / by:banto）では通せない（守りはそのまま）", async () => {
    driveToReviewReady(h.daemon, "task-5101");
    const amend = createKoboTools(h.daemon).find((t) => t.name === "kobo.amend")!;
    await assert.rejects(
      () =>
        amend.execute({
          projectTag: PROJ,
          taskId: "task-5101",
          reason: "訂正",
          acceptance: ACCEPT_AMENDED,
        } as never),
      /緩める方向/,
      "番頭が緩める向きの改訂を通せてしまっている"
    );
    assert.equal(h.daemon.getTask(PROJ, "task-5101")?.status, "review-ready");
  });

  it("POが札の「訂正する（適用）」を押すと、契約が by:\"po\" で改訂され監査が無効になり実装へ戻る", async () => {
    amendCard = await postAmendCard(h, "task-5101");

    const client = await BantoHostClient.connect(h.wsUrl, () => {});
    client.send({ type: "inbox_answer", itemId: amendCard, actionId: "apply" });

    await until(
      () => h.daemon.getTask(PROJ, "task-5101")?.status === "implementing",
      "タスクが implementing へ戻ること"
    );
    client.close();
  });

  it("帳簿に **PO の名前**と**どの札のどの回答で改訂したか**が残る（via 必須・決定113）", () => {
    const amended = h.daemon
      .getTaskEvents(PROJ, "task-5101")
      .find((e) => e.type === "task_contract_amended") as {
      amendedBy: string;
      via?: string;
      reason?: string;
    } | undefined;
    assert.ok(amended, "改訂の記録が無い");
    assert.equal(amended!.amendedBy, "po", "番頭（banto）の名前で書かれている");
    assert.match(
      amended!.via ?? "",
      /^inbox:in-[0-9a-f]+#apply$/,
      "どの札のどの回答で改訂したかが残っていない"
    );
    // 改訂は基準を変えたので、監査は無効——implementing へ戻った事実と整合する
  });

  it("`inbox.resolve`（番頭に渡っている Tool）では畳めない（処理は画面からだけ・決定57）", async () => {
    driveToReviewReady(h.daemon, "task-5102");
    const itemId = await postAmendCard(h, "task-5102");
    await assert.rejects(
      () => h.inboxTools["inbox.resolve"]!.execute({ id: itemId, action: "apply" } as never),
      /あなたは畳めません/,
      "番頭が改訂の札を畳めてしまっている"
    );
    assert.equal(h.daemon.getTask(PROJ, "task-5102")?.status, "review-ready");
    assert.equal(h.inbox.get(itemId)?.resolvedAt, undefined);
  });

  it("中身の無い改訂の承認は積む時点で断る（押しても何も変えられない札を作らない）", async () => {
    driveToReviewReady(h.daemon, "task-5103");
    await assert.rejects(
      () => postAmendCard(h, "task-5103", { amendChanges: undefined }),
      /amendChanges/,
      "中身の無い改訂の札を積めてしまっている"
    );
  });

  it("札は畳まれ、番頭には答えが伝わる（同じことをもう一度訊かせない）", async () => {
    await until(() => h.inbox.get(amendCard)?.resolvedAt !== undefined, "札が畳まれること");
    assert.equal(h.inbox.get(amendCard)?.resolution, "apply");
    await until(() => h.session.prompts.length > 0, "番頭のターンが回ること");
  });
});
