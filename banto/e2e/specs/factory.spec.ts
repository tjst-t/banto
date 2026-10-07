// **Factory——Backlog のタスクを手順どおりに main まで運ぶ**（v4-modules.md §4.5、2026-10-06。Backlog の factory-runtime）。
//
// 本物の Subagent・Backlog・Factory の Module を Project のコンテナで動かし、エージェントだけ偽物（fake-agent：[commit 名前]
// で worktree にコミットし、「レビュー役」の頼みには判定の JSON を返す）。見るもの（規則14）：
//   1. AI が runFactory で流すと、すぐ返り（承認はその会話で出る）、裏で実装→テスト→レビュー→main へ取り込み、Backlog が
//      done になり、worktree とブランチが片づき、「Factory の実行が終わりました」がその会話に届く
//   2. テストが上限を越えて落ちると止まり、「止まりました」が会話に届く。answerFactory で指示を足して続けると、直して入る
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, openNav, openProjectSettings, fakeTurn, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(480_000);

const PROJECT_NAME = "E2E Factory";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };

let projectId = "";
let threadId = "";
let root = "";
let turns = 0;

interface HostMessage {
  seq: number;
  role: string;
  text: string;
  origin?: { from: string; title: string };
}

async function hostThread(page: Page) {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: HostMessage[];
    lastTurn?: { outcome?: string };
  };
}

async function uiCall(page: Page, server: string, tool: string, args: Record<string, unknown>) {
  const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, { headers, data: { server, tool, arguments: args } });
  expect(res.ok(), `${server}.${tool} が呼べない：${await res.text()}`).toBe(true);
  const body = (await res.json()) as { content?: { text: string }[]; isError?: boolean };
  expect(body.isError, `${server}.${tool} が断った：${body.content?.[0]?.text}`).not.toBe(true);
  return body.content?.[0]?.text ?? "";
}

/** AI にその tool を呼ばせ、ターンが終わるまで承認を押し続ける。返すのは AI の最後の発言（tool の結果を含む） */
async function aiCalls(page: Page, server: string, name: string, args: Record<string, unknown>): Promise<string> {
  const composer = page.getByPlaceholder(/に送る/);
  const marker = `呼び出し ${++turns}：`;
  await composer.fill(`${marker}Factory を使って。` + fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server, name, args }] }));
  await composer.press("Enter");
  // **この発言のターンの返事**を待つ（届いたもので起きたターンが後ろに続いても数えを狂わせない）。終わるまで承認を押し続ける
  let reply: string | undefined;
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    const t = await hostThread(page);
    const mine = t.messages.find((m) => m.role === "user" && !m.origin && m.text.includes(marker));
    expect(mine, "送った発言がまだ記録に無い").toBeTruthy();
    const after = t.messages.filter((m) => m.seq > mine!.seq);
    const answer = after.find((m) => m.role === "assistant");
    expect(answer, "返事がまだ無い").toBeTruthy();
    // そのターンが終わった（後ろに別のものが積まれた・最後のターンが終わった）
    expect(after.some((m) => m.origin) || t.lastTurn?.outcome === "completed", "ターンがまだ終わっていない").toBe(true);
    reply = after.filter((m) => m.role === "assistant" && (!after.find((x) => x.origin) || m.seq < after.find((x) => x.origin)!.seq)).map((m) => m.text).join("\n");
  }).toPass({ timeout: 300_000, intervals: [1000] });
  return reply!;
}

async function deliveredTitles(page: Page): Promise<string[]> {
  return (await hostThread(page)).messages.filter((m) => m.origin).map((m) => m.origin!.title);
}

function backlogStatus(id: string): string | undefined {
  const raw = execFileSync("git", ["show", "backlog:tasks.json"], { cwd: root, encoding: "utf8" });
  return (JSON.parse(raw) as { items: Array<{ id: string; status: string }> }).items.find((i) => i.id === id)?.status;
}

test.beforeAll(async ({ request }) => {
  for (const id of ["backlog", "factory"]) {
    const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/${id}`, { headers, data: { name: id } });
    if (!res.ok() && !(await res.text()).includes("その名前はもう使われています")) throw new Error(`${id} を目録から入れられませんでした: ${res.status()}`);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of ["factory", "backlog"]) await request.delete(`${CORE_BASE_URL}/api/modules/${id}`, { headers });
});

test("AI が流したタスクが、実装→テスト→レビュー→main へ取り込みまで進み、Backlog が done になって会話に届く", async ({ page }) => {
  root = mkdtempSync(join(tmpdir(), "banto-e2e-factory-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "e2e\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  await openApp(page);
  await createProject(page, PROJECT_NAME, root);
  for (const m of ["subagent", "backlog", "factory"]) await waitForProjectModule(page, PROJECT_NAME, m);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  // テストのコマンドが無ければ流さない
  await uiCall(page, "backlog", "boardCreateItem", { id: "e2e-a", kind: "task", title: "a を足す", body: "[commit a.txt]", status: "ready" });
  const refused = await aiCalls(page, "factory", "runFactory", { items: ["e2e-a"] });
  expect(refused).toContain("テストのコマンドが設定されていません");

  // **設定の画面**から入れる（Project の設定の Factory の節）
  await openProjectSettings(page);
  await page.getByRole("button", { name: "Factory", exact: true }).click();
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="factory"]');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const config = canvas.locator("iframe").contentFrame().frameLocator("iframe");
  await expect(config.getByTestId("factory-test")).toBeVisible({ timeout: 30_000 });
  await expect(config.getByText("テストのコマンドを入れると、Factory に流せるようになります")).toBeVisible();
  await config.getByTestId("factory-test").fill("test -f a.txt");
  await config.getByTestId("factory-config-implementer").selectOption("fake");
  await config.getByTestId("factory-config-reviewer").selectOption("fake");
  await config.getByTestId("factory-config-save").click();
  await expect(config.getByTestId("factory-config-note")).toContainText("に保存しました", { timeout: 30_000 });
  const savedSettings = JSON.parse(await uiCall(page, "factory", "getSettings", {})) as { settings: { testCommand: string; implementer: { agent: string } } };
  expect(savedSettings.settings).toMatchObject({ testCommand: "test -f a.txt", implementer: { agent: "fake" } });
  await page.goto(`/p/${projectId}?bantoHost=${CORE_BROWSER_URL}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });

  const started = await aiCalls(page, "factory", "runFactory", { items: ["e2e-a"] });
  expect(started, `流せていない：${started}`).toContain("流しました");

  await expect
    .poll(() => deliveredTitles(page), { timeout: 180_000, message: "終わったことが会話に届かない" })
    .toContainEqual(expect.stringContaining("Factory の実行が終わりました（取り込み 1／1 件）"));
  expect(existsSync(join(root, "a.txt")), "main（Project の作業ツリー）に入っていない").toBe(true);
  expect(backlogStatus("e2e-a")).toBe("done");
  expect(existsSync(join(root, ".worktrees", "factory-e2e-a")), "worktree が残っている").toBe(false);
  expect(execFileSync("git", ["branch", "--list", "factory/e2e-a"], { cwd: root, encoding: "utf8" }).trim()).toBe("");
});

test("テストが上限を越えて落ちると止まって会話に届き、入口の画面で指示を足して答えると直して入る", async ({ page }) => {
  await openApp(page);
  await page.goto(`/p/${projectId}?bantoHost=${CORE_BROWSER_URL}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await uiCall(page, "factory", "setSettings", {
    settings: {
      testCommand: "test -f ok.txt",
      implementer: { agent: "fake" },
      reviewer: { agent: "fake" },
      limits: { testRetries: 0 },
    },
  });
  await uiCall(page, "backlog", "boardCreateItem", { id: "e2e-b", kind: "task", title: "b を足す", body: "[commit b.txt]", status: "ready" });
  const started = await aiCalls(page, "factory", "runFactory", { items: ["e2e-b"] });
  const { runId } = JSON.parse(started.slice(started.indexOf("{"))) as { runId: string };

  await expect
    .poll(() => deliveredTitles(page), { timeout: 180_000, message: "止まったことが会話に届かない" })
    .toContainEqual(expect.stringContaining("Factory：b を足す が止まりました"));
  const runs = JSON.parse(await uiCall(page, "factory", "getRuns", {})) as { runs: Array<{ runId: string; items: Array<{ status: string; stopped?: { reason: string } }> }> };
  const item = runs.runs.find((r) => r.runId === runId)!.items[0]!;
  expect(item.status).toBe("stopped");
  expect(item.stopped?.reason).toContain("テストが 1 回続けて落ちました");

  // 止まったことで AI が起きたターンが終わるのを待ってから、**人が入口の画面で**答える
  await expect.poll(async () => (await hostThread(page)).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
  await openNav(page);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:factory:"]');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const row = inner.locator('[data-testid="factory-row"][data-item="e2e-b"]');
  await expect(row).toHaveAttribute("data-status", "stopped", { timeout: 60_000 });
  await expect(row).toContainText("テストが 1 回続けて落ちました");
  await row.click();
  const detail = inner.getByTestId("factory-detail");
  await expect(detail.getByTestId("factory-stopped-reason")).toContainText("テストが 1 回続けて落ちました", { timeout: 30_000 });
  await expect(detail.getByText(/最後のテスト：落ちた/)).toBeVisible();
  await expect(detail.getByText("テストが落ちた（終了コード 1）")).toBeVisible();
  await detail.getByTestId("factory-instruction").fill("[commit ok.txt] を足して");
  await detail.getByRole("button", { name: "指示を足して続ける" }).click();
  await expect(detail.getByTestId("factory-stopped-reason")).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(async () => (await deliveredTitles(page)).filter((t) => t.startsWith("Factory の実行が終わりました（取り込み 1／1 件）")).length, {
      timeout: 180_000,
      message: "答えたあと終わったことが届かない",
    })
    .toBe(2);
  expect(existsSync(join(root, "b.txt")) && existsSync(join(root, "ok.txt"))).toBe(true);
  expect(backlogStatus("e2e-b")).toBe("done");
  // 入口の画面にも終わったことが出る（開いたままの詳細に結果、一覧に戻ると「終わったもの」の中）
  await expect(detail.getByTestId("factory-result")).toHaveText("取り込みました", { timeout: 30_000 });
  await detail.getByRole("button", { name: "一覧に戻る" }).click();
  await inner.getByRole("button", { name: /終わったもの/ }).click({ timeout: 10_000 });
  await expect(inner.locator('[data-testid="factory-row"][data-item="e2e-b"]')).toHaveAttribute("data-status", "done", { timeout: 30_000 });
});

// **入口の画面から banto の別の面を開く**（`dev.banto/open-surface`、v4-frontend.md §6.2、2026-10-07）。
// 2件を同時に走らせ、**一覧の先頭でない方**の「経過を見る」を押す——Subagent の画面は何も選んでいなければ先頭（走っている
// うちの新しいもの）を開くので、先頭を押しても「選んで開いた」ことにはならない
test("入口の画面の「経過を見る」で Subagent の画面がその仕事を選んで開き、「設定を開く」で Project の設定の Factory の節が開く", async ({ page }) => {
  await openApp(page);
  await page.goto(`/p/${projectId}?bantoHost=${CORE_BROWSER_URL}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await uiCall(page, "factory", "setSettings", {
    settings: { testCommand: "test -f never.txt", implementer: { agent: "fake" }, reviewer: { agent: "fake" } },
  });
  for (const id of ["e2e-c", "e2e-d"]) {
    await uiCall(page, "backlog", "boardCreateItem", { id, kind: "task", title: `${id} を待たせる`, body: `[slow 600] ${id} の本文`, status: "ready" });
  }
  const started = await aiCalls(page, "factory", "runFactory", { items: ["e2e-c", "e2e-d"] });
  const { runId } = JSON.parse(started.slice(started.indexOf("{"))) as { runId: string };

  // 両方の実装役が走り出すのを待ち、Subagent の一覧で先頭でない方を選ぶ
  let target = { item: "", subagentRunId: "", first: "" };
  await expect(async () => {
    const runs = JSON.parse(await uiCall(page, "factory", "getRuns", {})) as { runs: Array<{ runId: string; items: Array<{ item: string; subagentRunId?: string }> }> };
    const items = runs.runs.find((r) => r.runId === runId)!.items;
    expect(items.every((i) => i.subagentRunId), "実装役がまだ走っていない").toBe(true);
    const listed = JSON.parse(await uiCall(page, "subagent", "listRuns", { limit: 10 })) as { runs: Array<{ id: string; status: string }> };
    const running = listed.runs.filter((r) => r.status === "running").map((r) => r.id);
    const second = items.find((i) => running.indexOf(i.subagentRunId!) === 1);
    expect(second, "2件とも Subagent の一覧で走っていない").toBeTruthy();
    target = { item: second!.item, subagentRunId: second!.subagentRunId!, first: running[0]! };
  }).toPass({ timeout: 120_000, intervals: [1000] });

  await openNav(page);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:factory:"]');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const row = inner.locator(`[data-testid="factory-row"][data-item="${target.item}"]`);
  await expect(row).toHaveAttribute("data-status", "running", { timeout: 60_000 });
  await row.click();
  const detail = inner.getByTestId("factory-detail");
  await expect(detail.getByText("いま：実装役が働いている")).toBeVisible({ timeout: 30_000 });
  await detail.getByTestId("factory-open-progress").click();

  // Subagent の入口の画面に替わり、その仕事が選ばれている（一覧の印と、右の中身の両方）
  await expect(page).toHaveURL(/canvas=subagent%3Aui%3A%2F%2Fbanto-subagent%2Fruns/, { timeout: 30_000 });
  await expect(page.getByText("Canvas — subagent")).toBeVisible();
  const runs = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(runs.locator(`[data-role="run"][data-run="${target.subagentRunId}"]`)).toHaveAttribute("aria-current", "true", { timeout: 30_000 });
  await expect(runs.locator(`[data-role="run"][data-run="${target.first}"]`)).not.toHaveAttribute("aria-current", "true");
  await expect(runs.locator('[data-role="detail"]')).toHaveAttribute("data-run", target.subagentRunId);
  await expect(runs.locator('[data-role="detail-prompt"]')).toContainText(`${target.item} の本文`);
  await expect(runs.locator('[data-role="detail-status"]')).toContainText("実行中");

  // Factory の入口に戻り、上の段の「設定を開く」——Project の設定の Factory の節が、入口の画面の上に開く
  await page.goBack();
  await expect(page).toHaveURL(/canvas=factory%3A/, { timeout: 30_000 });
  await inner.getByTestId("factory-open-settings").click();
  const settings = page.locator('[data-testid="module-settings-canvas"][data-module="factory"]');
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/settings=1/);
  await expect(page).toHaveURL(/section=project-module%3Afactory/);
  await expect(page).toHaveURL(/canvas=factory%3A/);
  const config = settings.locator("iframe").contentFrame().frameLocator("iframe");
  await expect(config.getByTestId("factory-test")).toHaveValue("test -f never.txt", { timeout: 30_000 });

  for (const item of ["e2e-c", "e2e-d"]) await uiCall(page, "factory", "cancelFactory", { runId, item, reason: "E2E の片づけ" });
});

// 動いているものがある間は3秒ごとに読み直して丸ごと描き直す——詳細の本文を下へスクロールしても、読み直しのあとに
// 先頭へ戻されない（2026-10-07、ユーザー報告。Subagent の入口と同じ作り）
test("入口の画面：動いている1件の詳細の本文をスクロールしても、読み直しで先頭へ戻らない", async ({ page }) => {
  // 低い画面にして、詳細の本文をはみ出させる
  await page.setViewportSize({ width: 1280, height: 480 });
  await openApp(page);
  await page.goto(`/p/${projectId}?bantoHost=${CORE_BROWSER_URL}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await uiCall(page, "factory", "setSettings", { settings: { testCommand: "true", implementer: { agent: "fake" }, reviewer: { agent: "fake" } } });
  await uiCall(page, "backlog", "boardCreateItem", { id: "e2e-e", kind: "task", title: "e をゆっくり足す", body: "[slow 60]", status: "ready" });
  const started = await aiCalls(page, "factory", "runFactory", { items: ["e2e-e"] });
  const { runId } = JSON.parse(started.slice(started.indexOf("{"))) as { runId: string };

  await openNav(page);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  await page.locator('[role="option"][data-value^="launcher:factory:"]').click();
  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const row = inner.locator('[data-testid="factory-row"][data-item="e2e-e"]');
  await expect(row).toHaveAttribute("data-status", "running", { timeout: 60_000 });
  await row.click();
  const body = inner.getByTestId("factory-detail").locator(".d-body");
  await expect(body.locator(".d-title")).toHaveText("e をゆっくり足す", { timeout: 30_000 });
  await expect(body.getByText(/いま：実装役が働いている/)).toBeVisible({ timeout: 30_000 });

  const top = await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dataset.probe = "before";
    return el.scrollTop;
  });
  expect(top, "詳細の本文がスクロールできない（画面が高すぎる）").toBeGreaterThan(0);
  // 読み直しで作り直された（印を付けた要素が入れ替わった）ことを確かめてから、位置を見る
  await expect(body).not.toHaveAttribute("data-probe", "before", { timeout: 10_000 });
  await page.waitForTimeout(3_500);
  await expect(row).toHaveAttribute("data-status", "running");
  expect(await body.evaluate((el) => el.scrollTop), "詳細の本文が先頭へ戻された").toBe(top);

  await uiCall(page, "factory", "cancelFactory", { runId, item: "e2e-e", reason: "試験の片づけ" });
});
