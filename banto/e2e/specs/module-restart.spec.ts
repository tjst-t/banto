// **止まった Module・黙った Module を、host が見つけて起こし直す**（決定・2026-09-30、
// v4-architecture.md §5.4-0「止まった Module は起こし直す」）。
//
// 2026-09-29 は Shell が切れたまま（`Not connected`）、2026-09-30 は自動更新が incusd を再起動して
// コンテナの中の Module が黙ったまま（`Request timed out`）になり、どちらも **banto を再起動するまで**
// Command Palette の入口と AI の道具が消えた。本物のコンテナで、2つの壊れ方をそのまま作る：
//   - **止まる**：Module のプロセスが終わる（接続が閉じる）
//   - **黙る**：プロセスも繋がりも残ったまま、答えなくなる（SIGSTOP——incusd の再起動のときと同じ見え方）
//
// 見ること（規則14）：
//   - 起こし直され、同じ口（AI が通る代理サーバ）から runCommand がまた通る
//   - 黙っている間も、Command Palette の入口（ほかの Module の分）は出ている
//   - 次のターンで AI の道具として使える
//   - **待たないコマンドは Shell が落ちても続き、起こし直された Shell に問い直して結果が届く**（決定・2026-10-17、Backlog #362。
//     アーキ仕様 §2.5「2.」の「banto は動いたまま、Module との接続だけが切れたとき」）——札は「途中で終わりました」に
//     ならず、待つ間は一覧に「接続が切れたあと続けています」。結果（出力の末尾）が同じ Thread に届く
//   - 続けられると名乗らない Module（試験用の `fixtures/ask-human-module`）は、今どおりすぐ「途中で終わりました」

import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule, waitTurnEnded } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Module Restart";
// 続けられると名乗らない試験用の Module（Backlog #362）
const PLAIN_MODULE = `e2e-plain-${Date.now()}`;
const PLAIN_SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ask-human-module/server.js");

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(PLAIN_MODULE)}`, { headers: HEADERS });
});

interface HostThread {
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string; keptAfter?: string }>;
}

async function hostThread(page: Page, threadId: string): Promise<HostThread> {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()) as HostThread;
}

async function baseThreadOf(page: Page, projectId: string): Promise<string> {
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers: HEADERS })).json()) as {
    id: string;
  }[];
  return threads[0]!.id;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

interface Ran {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** AI が通る経路そのもの（代理サーバ）で runCommand を呼ぶ。 */
async function run(projectId: string, command: string, timeoutMs = 30_000): Promise<Ran> {
  const client = new Client({ name: "e2e-module-restart", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/shell-${projectId}`), {
      requestInit: { headers: HEADERS },
    }),
  );
  try {
    const r = await client.callTool({ name: "runCommand", arguments: { command } }, undefined, { timeout: timeoutMs });
    return JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Ran;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** いま答えている Shell のプロセスの番号（コマンドの親 `$PPID`）。答えなければ理由の文字列 */
async function shellPid(projectId: string): Promise<string> {
  try {
    return (await run(projectId, "echo $PPID", 5_000)).stdout.trim();
  } catch (err) {
    return `（答えない：${err instanceof Error ? err.message : String(err)}）`;
  }
}

/**
 * **別のプロセスの Shell が答えるまで待つ**——「答えた」だけだと、シグナルが届く前の古い Shell が
 * 答えたのと見分けがつかない（実際に、それで通ってしまった）。番号が変わったことが、起こし直した印
 */
async function waitForNewShell(projectId: string, before: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await shellPid(projectId);
        return /^\d+$/.test(now) && now !== before ? "起こし直された" : now;
      },
      { timeout: 150_000, intervals: [2_000], message: "Shell が起こし直されない" },
    )
    .toBe("起こし直された");
}

/**
 * **Shell 自身に、自分のプロセスへシグナルを送らせる**。コマンドの親（`$PPID`）が Shell の
 * プロセス。1秒後に送るように後ろへ回し、この呼び出し自体は先に返す
 */
async function signalShellItself(projectId: string, signal: "TERM" | "STOP"): Promise<void> {
  const r = await run(projectId, `pid=$PPID; (sleep 1; kill -${signal} $pid) >/dev/null 2>&1 & echo scheduled`);
  expect(r.stdout).toBe("scheduled\n");
}

async function projectIdOf(page: Page): Promise<string> {
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json()) as Array<{
    id: string;
    name: string;
  }>;
  return projects.find((p) => p.name === PROJECT_NAME)!.id;
}

async function expectFileLauncherInPalette(page: Page): Promise<void> {
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  await expect(page.getByText("Module の入口", { exact: true })).toBeVisible({ timeout: 30_000 });
  const entry = page.getByRole("option", { name: /ファイル/ });
  await expect(entry, "ほかの Module の入口まで消えた").toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("この Project のファイルを見る・開く・編集する");
  await page.keyboard.press("Escape");
}

test("プロセスが終わった Shell は、起こし直されてまた使える", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-module-restart-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const id = await projectIdOf(page);
  const before = await shellPid(id);
  expect(before).toMatch(/^\d+$/);

  await signalShellItself(id, "TERM");
  await waitForNewShell(id, before);
});

test("黙った Shell（繋がりは残ったまま答えない）も見つけて起こし直し、その間も入口は消えない", async ({ page }) => {
  await openApp(page);
  const id = await projectIdOf(page);
  await page.goto(`/p/${id}`);
  // 前の試験で起こし直した Shell が答えるまで待ってから始める
  await expect.poll(() => shellPid(id), { timeout: 60_000, intervals: [1_000] }).toMatch(/^\d+$/);
  const before = await shellPid(id);

  await signalShellItself(id, "STOP");
  // 黙ったことを確かめる——答えないまま上限で失敗するようになるまで待つ（シグナルは1秒後に届く）
  await expect.poll(() => shellPid(id), { timeout: 30_000, intervals: [1_000] }).toMatch(/答えない.*timed out/i);

  // ---- 黙っている間も、ほかの Module の入口は出ている ----------------------------------------
  const launchers = await page.request.get(`${CORE_BASE_URL}/api/projects/${id}/ui-launchers`, { headers: HEADERS });
  expect(launchers.status(), "1本が黙っただけで入口の一覧が丸ごと落ちた").toBe(200);
  expect(((await launchers.json()) as Array<{ server: string }>).map((l) => l.server)).toContain("filesystem");
  await expectFileLauncherInPalette(page);

  // ---- 見つけて起こし直す（ping に答えない→落として起こし直す）----------------------------------
  await waitForNewShell(id, before);

  // ---- 次のターンで、AI の道具として使える -------------------------------------------------
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${id}/threads`, { headers: HEADERS })).json()) as {
    id: string;
  }[];
  const threadId = threads[0]!.id;
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "Shell で印を出して。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: "echo AI-REACHED-SHELL" } }] }),
  );
  await composer.press("Enter");
  await expect
    .poll(
      async () => {
        const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()) as {
          messages: { role: string; text: string }[];
        };
        return thread.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.text)
          .join("\n");
      },
      { timeout: 120_000, message: "AI の道具として Shell が戻っていない" },
    )
    .toContain("AI-REACHED-SHELL");
  await expectFileLauncherInPalette(page);
});

test("待たないコマンドは Shell が落ちても続き、起こし直された Shell に問い直して結果が届く（「途中で終わりました」にしない）", async ({ page }) => {
  const label = "Shell が落ちても続くコマンド";
  await openApp(page);
  const id = await projectIdOf(page);
  await page.goto(`/p/${id}`);
  await expect.poll(() => shellPid(id), { timeout: 60_000, intervals: [1_000] }).toMatch(/^\d+$/);
  const threadId = await baseThreadOf(page, id);
  const fromShell = async () => (await hostThread(page, threadId)).messages.filter((m) => m.origin?.from === "shell").map((m) => m.origin!.title);
  const already = await fromShell();
  const turns = (await hostThread(page, threadId)).messages.filter((m) => m.role === "assistant").length;

  // 出力にだけ出る語（コマンドの文字には無い）——届いたものがコマンドの出力を運んだことを見る
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "長いコマンドを待たずに流して。" +
      fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: "sleep 30; echo after-cut-$((6*7))", runInBackground: true, label } }] }),
  );
  await composer.press("Enter");
  await waitTurnEnded(page, threadId, turns + 1);
  await expect.poll(async () => (await hostThread(page, threadId)).awaitingReplies?.map((r) => r.moduleName), { timeout: 30_000 }).toEqual(["shell"]);

  // ---- Shell が落ちる（接続が閉じる）。札は待つ ------------------------------------------------------------
  const before = await shellPid(id);
  await signalShellItself(id, "TERM");
  await expect
    .poll(async () => (await hostThread(page, threadId)).awaitingReplies?.map((r) => r.keptAfter), {
      timeout: 30_000,
      message: "接続が切れた札が「接続が切れたあと続けています」にならない",
    })
    .toEqual(["disconnect"]);
  // 画面：サイドバーの裏の仕事の行から一覧を開くと、その1件に「接続が切れたあと続けています」
  const workLine = page.locator('[data-sidebar="sidebar"]').getByTestId("thread-background");
  await expect(workLine).toHaveText(label, { timeout: 30_000 });
  await workLine.click();
  const item = page.getByTestId("background-list").getByTestId("background-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(label);
  await expect(item.getByTestId("background-item-kept")).toHaveText(/^接続が切れたあと続けています（(いま|\d+分前)から）$/);
  await page.keyboard.press("Escape");

  await waitForNewShell(id, before);
  // ---- 起こし直された Shell に問い、コマンドが終わると結果が届く -----------------------------------------------
  await expect
    .poll(fromShell, { timeout: 120_000, intervals: [2_000], message: "Shell が落ちたあと、続けたコマンドの結果が届かない" })
    .toEqual([...already, `コマンドが終わりました：${label}`]);
  const delivered = (await hostThread(page, threadId)).messages.filter((m) => m.origin?.from === "shell").at(-1)!;
  expect(delivered.text).toContain("after-cut-42");
  expect(delivered.text).toContain('"exitCode":0');
  await expect.poll(async () => (await hostThread(page, threadId)).awaitingReplies ?? [], { timeout: 30_000 }).toEqual([]);
  // 画面にも同じ結果が1件。「途中で終わりました」は出ない
  const card = page.getByTestId("delivered-message").filter({ hasText: `コマンドが終わりました：${label}` });
  await expect(card, "届いた結果が画面に出ない").toHaveCount(1, { timeout: 60_000 });
  await expect(card.getByTestId("delivered-title")).toHaveText(`コマンドが終わりました：${label}`);
  await card.getByRole("button", { name: "届いた中身をすべて見る" }).click();
  await expect(card.getByTestId("delivered-body")).toContainText("after-cut-42");
  await expect(page.getByTestId("delivered-message").filter({ hasText: "shell の仕事は途中で終わりました" })).toHaveCount(0);
  await expect(workLine, "届いたのに裏の仕事の行が残っている").toHaveCount(0, { timeout: 30_000 });
});

test("続けられると名乗らない Module は、接続が切れたら今どおりすぐ「途中で終わりました」", async ({ page }) => {
  const added = await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers: { ...HEADERS, "content-type": "application/json" },
    data: { mcpServers: { [PLAIN_MODULE]: { command: "${nodeExec}", args: [PLAIN_SERVER] } } },
  });
  expect(added.status(), `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);
  await openApp(page);
  const id = await projectIdOf(page);
  await page.goto(`/p/${id}`);
  const threadId = await baseThreadOf(page, id);
  const turns = (await hostThread(page, threadId)).messages.filter((m) => m.role === "assistant").length;
  // 答えを返した1秒後に Module が自分で終わる（"exit"）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("承認を頼んで。" + fakeTurn({ tools: [{ server: PLAIN_MODULE, name: "askHuman", args: { what: "exit" } }] }));
  await composer.press("Enter");
  await waitTurnEnded(page, threadId, turns + 1);
  const lostTitle = `${PLAIN_MODULE} の仕事は途中で終わりました`;
  await expect
    .poll(async () => (await hostThread(page, threadId)).messages.filter((m) => m.origin?.from === PLAIN_MODULE).map((m) => m.origin!.title), {
      timeout: 30_000,
      message: "名乗らない Module が止まっても「途中で終わりました」が届かない",
    })
    .toEqual([lostTitle]);
  const lost = (await hostThread(page, threadId)).messages.find((m) => m.origin?.from === PLAIN_MODULE)!;
  expect(lost.text).toContain("もう届きません——Module が止まったため");
  expect((await hostThread(page, threadId)).awaitingReplies ?? []).toEqual([]);
  const card = page.getByTestId("delivered-message").filter({ hasText: lostTitle });
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card.getByTestId("delivered-title")).toHaveText(lostTitle);
});
