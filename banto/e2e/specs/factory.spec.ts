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
import { createProject, openApp, fakeTurn, waitForProjectModule } from "../helpers.js";

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

  await uiCall(page, "factory", "setSettings", {
    settings: { testCommand: "test -f a.txt", implementer: { agent: "fake" }, reviewer: { agent: "fake" } },
  });
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

test("テストが上限を越えて落ちると止まって会話に届き、answerFactory で指示を足すと直して入る", async ({ page }) => {
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

  // 止まったことで AI が起きたターンが終わるのを待ってから答える
  await expect.poll(async () => (await hostThread(page)).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
  await aiCalls(page, "factory", "answerFactory", { runId, item: "e2e-b", action: "continue", instruction: "[commit ok.txt] を足して" });
  await expect
    .poll(async () => (await deliveredTitles(page)).filter((t) => t.startsWith("Factory の実行が終わりました（取り込み 1／1 件）")).length, {
      timeout: 180_000,
      message: "答えたあと終わったことが届かない",
    })
    .toBe(2);
  expect(existsSync(join(root, "b.txt")) && existsSync(join(root, "ok.txt"))).toBe(true);
  expect(backlogStatus("e2e-b")).toBe("done");
});
