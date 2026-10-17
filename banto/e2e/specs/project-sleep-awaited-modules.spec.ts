// **スリープの例外：出来事を待たれている Module とコンテナは止めない**（アーキ仕様 §2.2「出来事を待たれている Module は止めない」・
// §4.3 段2、v4-frontend.md §6.43、Backlog #357）。
//
// 同梱の Service と試験用の出来事の Module（`e2e-events`）を本物のコンテナの Project に入れる。Module を入れると全部の Project に
// 効くので、自前の host（`own-host.ts`）で。眠らせるのは画面のサイドバーから。見ること（規則14——host の記録・コンテナの中の
// プロセス・Module の接続・画面の文まで）：
//   1. Service でない Module（e2e-events）だけが待たれている：確かめの小窓に止まる Service と「e2e-events は自動化のため止めません」が
//      並ぶ。眠らせると e2e-events は繋がったまま・コンテナは動いたまま、Service は管理操作で止まり、ほかの Module は外れる
//   2. Service の出来事を待つ自動化がある：止まるものが無いので確かめずに眠る。Service の Module・Service のプロセス・コンテナは
//      動いたまま、待たれていない Module は止まる。行に自動化の印、「…」の一番上に理由。一覧の partlyAwake・資源の「一部起きています」
//   3. その自動化を一時停止すると、眠ったまま Service もコンテナも止まる。行の印が消える
// 起こしたときに Service が登録から戻る（1→2 の間）も見る
import { test, expect, type Locator, type Page } from "../test-base.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(900_000);
test.use({ viewport: { width: 1280, height: 900 } });

const NAME = "E2E 待たれたまま眠る";
const WITNESS = "E2E 待たれたまま眠る（開いておく側）";
const EVENTS = "e2e-events";
/** Service で動かすもの（コンテナの中で探す印） */
const SERVICE_MARK = "sleep 86397";
const ON_EVENTS = "e2e-events を待つ";
const ON_CRASH = "落ちた Service を見る";

interface HostProject {
  id: string;
  sleep?: { since: string; by: string };
  partlyAwake?: Array<{ module: string; automations: Array<{ id: string; name: string }> }>;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(host: OwnHost, connName: string, tool: string, args: Record<string, unknown>, ctx: { projectId: string; threadId: string }) {
  const client = new Client({ name: "e2e-project-sleep-awaited", version: "0.0.0" }, { capabilities: {} });
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

function containerState(projectId: string): string {
  return spawnSync("incus", ["list", `banto-${projectId}`, "-f", "csv", "-c", "s"], { encoding: "utf8", input: "" }).stdout.trim();
}
/**
 * コンテナの中で `pattern` に当たるプロセスの数（コンテナが止まっていれば 0）。**数えている sh 自身は外す**——sh のコマンド行にも
 * `pattern` が書いてあるので、`sleep 86397` のように文字どおり当たる形だと、何も動いていなくても 1 になる（pgrep が外すのは自分だけ）
 */
function processesInContainer(projectId: string, pattern: string): number {
  if (containerState(projectId) !== "RUNNING") return 0;
  const r = spawnSync("incus", ["exec", `banto-${projectId}`, "--", "sh", "-c", `pgrep -f '${pattern}' | grep -vx "$$" | wc -l`], { encoding: "utf8", input: "" });
  return Number(r.stdout.trim());
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" });
}

function awakeRow(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-project-name").filter({ hasText: name }).first().locator("xpath=ancestor::*[@data-sortable-id][1]");
}
function sleepingItem(page: Page, name: string): Locator {
  return page.locator("li").filter({ has: page.getByTestId("sidebar-sleeping-name").getByText(name, { exact: true }) });
}
async function openSleepSection(page: Page) {
  const heading = page.getByTestId("sidebar-sleep-heading");
  await expect(heading, "スリープ中の見出しが出ない").toBeVisible({ timeout: 30_000 });
  if ((await heading.getAttribute("data-open")) === null) await heading.getByRole("button", { name: "スリープ中を開く" }).click();
  await expect(heading).toHaveAttribute("data-open", "");
}
async function sleepByMenu(page: Page, name: string) {
  const row = awakeRow(page, name);
  await row.hover();
  await row.getByTestId("sidebar-item-more").first().click();
  await page.getByRole("menuitem", { name: "スリープにする" }).click();
}

test("出来事を待たれている Module とコンテナは眠らせても止めず、待たれていない Module は止め、自動化を一時停止するとコンテナまで止まる", async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-sleep-awaited-")));
  writeFileSync(join(root, "README"), "スリープの例外の試験\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "最初"]);

  await withOwnHost(async (host) => {
    const headers = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const call = async <T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${host.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
    };
    const ok = async <T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await call<T>(path, init);
      expect(res.status, `${init.method ?? "GET"} ${path}：${JSON.stringify(res.body)}`).toBeLessThan(300);
      return res.body;
    };

    // ---- 用意：Module を入れ、Project を作り、Service を1つ動かす ------------------------------------------------------
    for (const id of ["service", EVENTS]) await ok(`/api/modules/catalog/${id}`, { method: "POST", body: { name: id } });
    const projectId = (await ok<{ id: string }>("/api/projects", { method: "POST", body: { name: NAME, root } })).id;
    const threadId = (await ok<{ id: string }>(`/api/projects/${projectId}/threads`, { method: "POST" })).id;
    const witnessId = (await ok<{ id: string }>("/api/projects", { method: "POST", body: { name: WITNESS, root: mkdtempSync(join(tmpdir(), "banto-e2e-sleep-awaited-w-")) } })).id;
    await ok(`/api/projects/${witnessId}/threads`, { method: "POST" });
    const ctx = { projectId, threadId };
    const projectOf = async () => (await ok<HostProject[]>("/api/projects")).find((p) => p.id === projectId)!;
    /** 起こさずに、その Project の Module が繋がっているか */
    const connected = async () =>
      Object.fromEntries(
        (await ok<Array<{ name: string; connected: boolean }>>(`/api/projects/${projectId}/modules`)).map((m) => [m.name, m.connected]),
      );
    const automationsApi = `/api/projects/${projectId}/automations`;
    const createAutomation = async (name: string, event: string) =>
      (
        await ok<{ id: string }>(automationsApi, {
          method: "POST",
          body: { name, instruction: "起きた出来事を読んで。" + fakeTurn({ sayContext: true }), source: { kind: "event", event, batchSeconds: 0 } },
        })
      ).id;

    await ok(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
    // 入れ子のコンテナでは logind に繋がらない——ユーザーの systemd を root で起こしておく（e2e の罠）
    const um = await callTool(host, `shell-${projectId}`, "runCommand", { command: "sudo -n systemctl start user@$(id -u).service" }, ctx);
    expect(um.isError, um.text).toBe(false);
    const web = await callTool(host, `service-${projectId}`, "startService", { name: "web", command: `exec ${SERVICE_MARK}` }, ctx);
    expect(web.isError, web.text).toBe(false);
    await expect.poll(() => processesInContainer(projectId, SERVICE_MARK), { timeout: 60_000, message: "Service が動き出さない" }).toBe(1);

    await login(page, host);
    // 眠らせる側ではない Project を開いておく（眠らせる Project の画面を開いたままだと、画面が開き直したときに起こす）
    await page.goto(`/p/${witnessId}?bantoHost=${host.url}`);
    await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 60_000 });

    // ---- 1. Service でない Module だけが待たれている：Service は止め、その Module とコンテナは残す ----------------------------
    const onEvents = await createAutomation(ON_EVENTS, `${EVENTS}.happened`);
    await expect.poll(async () => (await connected())[EVENTS], { timeout: 120_000, message: "出来事を待たれた Module が起きない" }).toBe(true);
    const preview1 = await ok<{ stops: Array<{ label: string }>; keeps: Array<{ module: string }>; servicesKept: boolean }>(
      `/api/projects/${projectId}/sleep-preview`,
    );
    expect(preview1).toMatchObject({ stops: [{ label: "Service「web」が動いています" }], keeps: [{ module: EVENTS }], servicesKept: false });
    await sleepByMenu(page, NAME);
    const confirm = page.getByTestId("sleep-confirm");
    await expect(confirm, "止まるもの（Service）があるのに確かめない").toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByRole("heading")).toHaveText(`「${NAME}」をスリープにしますか`);
    await expect(confirm.getByText("眠っている間は止まります。公開中の URL には届きません。起こすと Service はまた動きます")).toBeVisible();
    await expect(confirm.getByTestId("sleep-confirm-stops").locator("li")).toHaveText(["Service「web」が動いています"]);
    await expect(confirm.getByTestId("sleep-confirm-keeps").locator("li")).toHaveText([`${EVENTS}は自動化のため止めません`]);
    await confirm.getByRole("button", { name: "スリープにする" }).click();
    await expect.poll(async () => (await projectOf()).sleep?.by, { timeout: 30_000, message: "眠らない" }).toBe("human");
    expect(containerState(projectId), "待たれている Module があるのにコンテナを止めた").toBe("RUNNING");
    await expect.poll(() => processesInContainer(projectId, SERVICE_MARK), { timeout: 30_000, message: "Service が止まらない" }).toBe(0);
    const after1 = await connected();
    expect([after1[EVENTS], after1.service, after1.shell, after1.filesystem], "待たれている Module だけが残っていない（e2e-events・service・shell・filesystem）").toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(processesInContainer(projectId, "modules/(shell|filesystem|service)/dist/server.js"), "外した Module のプロセスが残っている").toBe(0);
    expect((await projectOf()).partlyAwake).toEqual([{ module: EVENTS, automations: [{ id: onEvents, name: ON_EVENTS }] }]);
    await openSleepSection(page);
    const row = sleepingItem(page, NAME);
    await expect(row.getByTestId("sidebar-sleeping-partly-awake"), "一部起きている印が出ない").toBeVisible({ timeout: 30_000 });

    // 起こすと、Service は登録から戻る
    await ok(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
    expect((await projectOf()).sleep).toBeUndefined();
    await expect.poll(() => processesInContainer(projectId, SERVICE_MARK), { timeout: 120_000, message: "起こしても Service が戻らない" }).toBe(1);

    // ---- 2. Service の出来事を待つ自動化がある：Service の Module・Service・コンテナは動いたまま ---------------------------------
    await ok(`${automationsApi}/${onEvents}`, { method: "PATCH", body: { paused: true } });
    const onCrash = await createAutomation(ON_CRASH, "service.crashed");
    await expect.poll(async () => (await connected()).service, { timeout: 60_000, message: "Service の Module が繋がっていない" }).toBe(true);
    const preview2 = await ok<{ stops: unknown[]; keeps: Array<{ module: string }>; servicesKept: boolean }>(`/api/projects/${projectId}/sleep-preview`);
    expect(preview2).toMatchObject({ stops: [], keeps: [{ module: "service" }], servicesKept: true });
    await sleepByMenu(page, NAME);
    // 止まるものが無いので確かめずに眠る
    await expect.poll(async () => (await projectOf()).sleep?.by, { timeout: 30_000, message: "眠らない" }).toBe("human");
    await expect(page.getByTestId("sleep-confirm")).toHaveCount(0);
    expect(containerState(projectId), "Service の Module が待たれているのにコンテナを止めた").toBe("RUNNING");
    expect(processesInContainer(projectId, SERVICE_MARK), "Service の Module が待たれているのに Service を止めた").toBe(1);
    const after2 = await connected();
    expect([after2.service, after2[EVENTS], after2.shell, after2.filesystem], "待たれている Module だけが残っていない（service・e2e-events・shell・filesystem）").toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(processesInContainer(projectId, "modules/(shell|filesystem)/dist/server.js"), "待たれていない Module のプロセスが残っている").toBe(0);
    expect(processesInContainer(projectId, "modules/service/dist/server.js"), "Service の Module のプロセスが居ない").toBeGreaterThan(0);
    expect((await projectOf()).partlyAwake).toEqual([{ module: "service", automations: [{ id: onCrash, name: ON_CRASH }] }]);
    // 画面：行の印と「…」の一番上の理由
    await openSleepSection(page);
    await expect(row.getByTestId("sidebar-sleeping-partly-awake")).toBeVisible({ timeout: 30_000 });
    const reason = `自動化『${ON_CRASH}』がserviceの出来事を待っているので、serviceは起きたままです`;
    await expect(row.getByTestId("sidebar-sleeping-project")).toHaveAttribute("title", new RegExp(reason));
    await row.hover();
    await row.getByTestId("sidebar-sleeping-more").click();
    await expect(page.getByTestId("sidebar-sleeping-awake-reason")).toHaveText([reason]);
    await page.keyboard.press("Escape");
    // 資源の見張り：眠っていてもコンテナが動いていれば測り、「一部起きています」の印（asleep）
    await expect
      .poll(
        async () =>
          ((await ok<{ projects?: Array<{ projectId: string; asleep?: true }> } | null>("/api/admin/resources"))?.projects ?? []).find(
            (p) => p.projectId === projectId,
          )?.asleep,
        { timeout: 60_000, message: "資源の画面に一部起きていると出ない" },
      )
      .toBe(true);

    // ---- 3. 自動化を一時停止すると、眠ったまま Service もコンテナも止まる -----------------------------------------------------
    await ok(`${automationsApi}/${onCrash}`, { method: "PATCH", body: { paused: true } });
    await expect.poll(() => containerState(projectId), { timeout: 120_000, message: "待たれなくなってもコンテナが止まらない" }).toBe("STOPPED");
    const after3 = await projectOf();
    expect([after3.sleep?.by, after3.partlyAwake]).toEqual(["human", undefined]);
    expect((await connected()).service, "待たれなくなった Service の Module が残っている").toBe(false);
    await expect(row.getByTestId("sidebar-sleeping-partly-awake"), "待たれなくなったのに印が残っている").toHaveCount(0, { timeout: 30_000 });
  });
});
