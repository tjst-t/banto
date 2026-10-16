// **最初に出す出来事**（アーキ仕様 §4.3「最初に出す出来事」、Backlog #347）。
//
// 同梱の Service と Backlog を本物のコンテナの Project に入れ、出来事のきっかけの自動化を動かす。起こし直しを見るので
// 自前の host（`own-host.ts`）を使う。見ること（host の台帳・会話の記録・画面）：
//   1. Backlog を AI のターンが変えた出来事（`backlog.item-changed`）で自動化が動き、届いたものに**そのターンのホップ＋1**が付く
//   2. Service をわざと落とすと、起動役が出口の箱に書いた `service.crashed` で自動化が動く。届いたものに属性（名前・終了コード）と
//      ログの末尾が入り、起こした呼び出しの印から**ホップ＋1**が付く。自動化の画面と会話の届いたカードにも出る
//   3. banto（と Module）が止まっていた間に落ちた分は、起き直して Module が繋がったときに届く
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openPaletteEntry } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(900_000);

type Run = { runId: string; result: string; cause: string; reason?: string; received?: number };
type Automation = { id: string; name: string; target: { kind: string; threadId?: string }; runs: Run[] };
type Delivered = {
  role: string;
  text: string;
  origin?: {
    automation?: { id: string };
    hop: number;
    external?: Array<{ source: string; body: string; event?: { name: string; title: string; fields: Record<string, unknown> } }>;
  };
};

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(
  host: OwnHost,
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-automation-events-emitters", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${host.apiUrl}/agent-relay/${connName}`), {
      requestInit: {
        headers: { authorization: `Bearer ${host.token}`, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId },
      },
    }),
  );
  try {
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

/** ターンを1本最後まで（承認は聞かない形で）。SSE の終わりまで読む */
async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" });
}

test("Backlog を AI が変えた出来事にはそのターンのホップ＋1が付き、Service をわざと落とすと service.crashed で自動化が動き、banto が止まっていた間に落ちた分も繋がったときに届く", async ({
  page,
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-events-emitters-")));
  writeFileSync(join(root, "README"), "出来事の試験\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "最初"]);

  await withOwnHost(async (host) => {
    const headers = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${host.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };

    // ---- Module を入れ、Project を作る ------------------------------------------------------------------------
    for (const id of ["service", "backlog"]) {
      const installed = await call(`/api/modules/catalog/${id}`, { method: "POST", body: { name: id } });
      expect(installed.status, JSON.stringify(installed.body)).toBeLessThan(300);
    }
    const created = await call("/api/projects", { method: "POST", body: { name: "E2E 最初の出来事", root } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectId = created.body.id as string;
    expect((await call(`/api/projects/${projectId}/auto-approve`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
    const threadId = ((await call(`/api/projects/${projectId}/threads`, { method: "POST" })).body as { id: string }).id;
    const ctx = { projectId, threadId };
    await login(page, host);

    const api = `/api/projects/${projectId}/automations`;
    const byName = async (name: string) => ((await call(api)).body as { automations: Automation[] }).automations.find((a) => a.name === name)!;
    const delivered = async (name: string) => {
      const forkId = (await byName(name)).target.threadId!;
      const thread = (await call(`/api/threads/${forkId}`)).body as { messages: Delivered[] };
      return thread.messages.filter((m) => m.origin?.automation);
    };
    const create = async (name: string, event: string, where: Record<string, unknown>, instruction: string) => {
      const r = await call(api, { method: "POST", body: { name, instruction, source: { kind: "event", event, where, batchSeconds: 0 } } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    };
    const CRASH = "落ちた Service を見る";
    const READY = "ready になった項目を見る";
    await create(CRASH, "service.crashed", { service: ["crasher", "late"] }, "落ちた Service を調べて。" + fakeTurn({ sayContext: true }));
    await create(READY, "backlog.item-changed", { to: "ready" }, "ready になった項目を見て。" + fakeTurn({ sayContext: true }));
    const doneRuns = async (name: string) => (await byName(name)).runs.filter((r) => r.result === "done").map((r) => `${r.cause}:${r.received ?? 0}`);

    // ---- 1. Backlog を AI のターンが変えた出来事：そのターンのホップ＋1 -------------------------------------------
    await sendTurn(
      host,
      threadId,
      "タスクを足して。" + fakeTurn({ tools: [{ server: "backlog", name: "createItem", args: { kind: "task", title: "出来事の試験", status: "ready" } }] }),
    );
    await expect.poll(() => doneRuns(READY), { timeout: 180_000, message: "Backlog の出来事で自動化が動かない" }).toEqual(["event:1"]);
    const fromBacklog = (await delivered(READY))[0]!;
    // 人が送ったターン（ホップ 0）の呼び出しが起こした出来事——届けものはホップ 1
    expect(fromBacklog.origin!.hop).toBe(1);
    expect(fromBacklog.origin!.external).toEqual([
      expect.objectContaining({
        source: "event",
        body: expect.stringContaining("「出来事の試験」（task）ができました（ready）"),
        event: expect.objectContaining({
          name: "backlog.item-changed",
          title: "Backlog の項目ができた・状態が変わった",
          fields: expect.objectContaining({ title: "出来事の試験", kind: "task", to: "ready", labels: "" }),
        }),
      }),
    ]);
    expect(Object.keys(fromBacklog.origin!.external![0]!.event!.fields), "できたものに from が付いた").not.toContain("from");

    // ---- 2. Service をわざと落とす ------------------------------------------------------------------------------
    // 入れ子のコンテナでは logind に繋がらない——ユーザーの systemd を root で起こしておく（e2e の罠）
    const um = await callTool(host, `shell-${projectId}`, "runCommand", { command: "sudo -n systemctl start user@$(id -u).service" }, ctx);
    expect(um.isError, um.text).toBe(false);
    // 1回だけ落ちる（2回目からは動き続ける）——systemd の起こし直しで続けて落ちない
    const crasher = await callTool(
      host,
      `service-${projectId}`,
      "startService",
      { name: "crasher", command: "if [ -f .crasher-done ]; then exec sleep infinity; fi; touch .crasher-done; echo 落ちる前の行; exit 3" },
      ctx,
    );
    expect(crasher.isError, crasher.text).toBe(false);
    await expect.poll(() => doneRuns(CRASH), { timeout: 180_000, message: "Service が落ちても自動化が動かない" }).toEqual(["event:1"]);
    const fromCrash = (await delivered(CRASH))[0]!;
    // 起こした呼び出し（この Thread の、ホップ 0）の印を起動役が持ち越した
    expect(fromCrash.origin!.hop).toBe(1);
    expect(fromCrash.origin!.external).toEqual([
      expect.objectContaining({
        source: "event",
        body: expect.stringMatching(/Service「crasher」が落ちました（終了コード 3）。ログの末尾 \d+ 行：\n.*落ちる前の行/s),
        event: expect.objectContaining({ name: "service.crashed", title: "Service が落ちた", fields: { service: "crasher", exitCode: 3 } }),
      }),
    ]);
    // AI に渡った文：見出しは囲みの属性
    const said = (await call(`/api/threads/${(await byName(CRASH)).target.threadId}`)).body as { messages: Delivered[] };
    expect(said.messages.filter((m) => m.role === "assistant").at(-1)!.text).toContain('event="service.crashed" title="Service が落ちた"');

    // ---- 画面：自動化の一覧と会話の届いたカード -----------------------------------------------------------------
    await page.goto(`/p/${projectId}?bantoHost=${host.url}`);
    await openPaletteEntry(page, /^自動化/);
    await expect(page.getByTestId("automations")).toBeVisible({ timeout: 30_000 });
    const row = page.getByTestId("automation-row").filter({ hasText: CRASH });
    await expect(row.getByTestId("automation-summary")).toContainText("Service が落ちたとき（サービスの名前が「crasher」・「late」のどれか）");
    await row.getByRole("button", { name: CRASH }).click();
    await expect(row.getByTestId("automation-run").first()).toHaveAttribute("data-result", "done");
    await expect(row.getByTestId("automation-run").first().getByTestId("automation-run-received")).toHaveText("（出来事 1 件）");
    const readyRow = page.getByTestId("automation-row").filter({ hasText: READY });
    await expect(readyRow.getByTestId("automation-summary")).toContainText("Backlog の項目ができた・状態が変わったとき（新しい状態が「ready」）");

    await page.goto(`/p/${projectId}?fork=${(await byName(CRASH)).target.threadId}&bantoHost=${host.url}`);
    const card = page.locator('[data-testid="delivered-message"]').filter({ hasText: `自動化「${CRASH}」` });
    await expect(card, "届いたものが会話に出ない").toBeVisible({ timeout: 30_000 });
    const external = card.getByTestId("delivered-external");
    await expect(external).toContainText("外から来たもの（出来事を 1 件受けました）");
    await expect(external.getByTestId("delivered-external-event")).toHaveText("Service が落ちた（service.crashed）：service=crasher、exitCode=3");
    await expect(external.getByTestId("delivered-external-body")).toContainText("Service「crasher」が落ちました（終了コード 3）");

    // ---- 3. banto が止まっていた間に落ちた分は、繋がったときに届く --------------------------------------------------
    // 合図のファイル（Project の根）を置かれたら1回だけ落ちる。落ちる直前に印のファイルを残す
    const late = await callTool(
      host,
      `service-${projectId}`,
      "startService",
      {
        name: "late",
        command:
          "if [ -f .late-done ]; then exec sleep infinity; fi; while [ ! -f crash-now ]; do sleep 0.5; done; touch .late-done; echo 止まっている間に落ちます; exit 4",
      },
      ctx,
    );
    expect(late.isError, late.text).toBe(false);
    await host.stop("SIGKILL");
    writeFileSync(join(root, "crash-now"), "");
    // 落ちた（起動役は exit のすぐあとに箱へ書く）——banto はまだ止まっている
    await expect.poll(() => existsSync(join(root, ".late-done")), { timeout: 60_000, message: "止まっている間に Service が落ちない" }).toBe(true);
    await host.start();
    // Module は使われるまで起きない——起こす（繋がったら箱を古い順に出す）
    await expect
      .poll(async () => (await callTool(host, `service-${projectId}`, "listServices", {}, ctx).catch(() => ({ isError: true, text: "" }))).isError, {
        timeout: 120_000,
        message: "起き直したあと Service が答えない",
      })
      .toBe(false);
    await expect
      .poll(() => doneRuns(CRASH), { timeout: 180_000, message: "止まっていた間に落ちた分が、繋がっても届かない" })
      .toEqual(["event:1", "event:1"]);
    const afterRestart = (await delivered(CRASH)).at(-1)!;
    expect(afterRestart.origin!.external![0]!.event!.fields).toEqual({ service: "late", exitCode: 4 });
    expect(afterRestart.origin!.external![0]!.body).toContain("止まっている間に落ちます");
  });
});
