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

import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Module Restart";

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
