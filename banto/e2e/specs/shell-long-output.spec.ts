// **長い出力で Shell が切れない**（決定・2026-09-29、v4-modules.md §2.3「長い出力」）。
//
// banto.tjstkm.net で、AI の `cp -al` がコンテナの外のディスクへ写そうとしてエラーを 12.1MB 出し、
// Shell が黙って消えた（MCP の stdio は1通 10 MiB まで。越えた返事で host が接続を閉じた）。
// 一緒に、Command Palette の「Module の入口」も全部消えた——入口の一覧は Project の Module 全部に聞くので、
// 1本が答えないと一覧ごと失敗した。
//
// 本番と同じ経路で見る：host → **コンテナの中の** Shell（`incus exec` の標準入出力）。見ること（規則14）：
//   - 返事は小さく、長いほうは頭と末尾・省いた量・保存先。短いほうはそのまま
//   - 保存先はコンテナの中の Shell のホームにあり、**次の runCommand で全体が読める**
//   - Shell はまだ繋がっている
//   - 会話のカードに、頭と末尾・保存先が出ている（12MB を描かない）
//   - Command Palette の入口が出る

import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Shell Long Output";
/** 1行 100 文字 × 120,000 行 = 12,000,000 文字を stderr へ（本番で落ちた大きさ）。最後に stdout へ終わりの印 */
const BIG_COMMAND = `yes '${"x".repeat(99)}' | head -n 120000 1>&2; echo rc=done`;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

interface Ran {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutFile?: string;
  stderrFile?: string;
}

/** AI を通さずに、AI が通る経路そのもの（代理サーバ）で runCommand を呼ぶ。返事の生の文字列も返す */
async function run(projectId: string, command: string): Promise<{ text: string; result: Ran }> {
  const client = new Client({ name: "e2e-shell-long-output", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/shell-${projectId}`), {
      requestInit: { headers: HEADERS },
    }),
  );
  try {
    const r = await client.callTool({ name: "runCommand", arguments: { command } }, undefined, { timeout: 120_000 });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    return { text, result: JSON.parse(text) as Ran };
  } finally {
    await client.close();
  }
}

async function projectIdOf(page: Page): Promise<string> {
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json()) as Array<{
    id: string;
    name: string;
  }>;
  return projects.find((p) => p.name === PROJECT_NAME)!.id;
}

async function assistantTexts(page: Page, threadId: string): Promise<string[]> {
  const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()) as {
    messages: { role: string; text: string }[];
  };
  return thread.messages.filter((m) => m.role === "assistant").map((m) => m.text);
}

test("12MB の出力でも Shell は切れず、全体はコンテナの中に残り、会話のカードと Command Palette の入口が出る", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-shell-long-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const id = await projectIdOf(page);
  const outputDir = join(DATA_DIR, "modules", `shell-${id}`, "home", ".cache", "banto-shell", "output");

  // ---- 1. 返事は小さく、長いほうは頭と末尾・省いた量・保存先 -----------------------------
  const big = await run(id, BIG_COMMAND);
  expect(big.text.length, "返事が大きいまま").toBeLessThan(20_000);
  expect(big.result.exitCode).toBe(0);
  expect(big.result.stdout, "短いほうはそのまま").toBe("rc=done\n");
  expect(big.result.stdoutFile).toBeUndefined();
  expect(big.result.stderrFile?.startsWith(`${outputDir}/`), `保存先: ${big.result.stderrFile}`).toBe(true);
  expect(big.result.stderr).toContain("省きました（全体 12,000,000 文字）");
  expect(big.result.stderr).toContain(`全体は ${big.result.stderrFile} にあります`);
  expect(big.result.stderr.endsWith(`${"x".repeat(99)}\n`), "末尾が本当の終わり").toBe(true);

  // ---- 2. 全体を、次の runCommand で読める（コンテナの中のファイル）--------------------------
  const wc = await run(id, `wc -c < '${big.result.stderrFile}'; tail -c 100 '${big.result.stderrFile}'`);
  expect(wc.result.exitCode, wc.result.stderr).toBe(0);
  expect(wc.result.stdout).toBe(`12000000\n${"x".repeat(99)}\n`);

  // ---- 3. Shell はまだ繋がっている -------------------------------------------------------
  expect((await run(id, "echo still-here")).result.stdout).toBe("still-here\n");

  // ---- 4. 会話のカードに、頭と末尾・保存先が出る（AI が同じものを受け取る）---------------------
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${id}/threads`, { headers: HEADERS })).json()) as {
    id: string;
  }[];
  const threadId = threads[0]!.id;
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("大きな出力を出して。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: BIG_COMMAND } }] }));
  await composer.press("Enter");
  // **成功したときにだけ現れるもの**を待つ（規則14）——偽 Runner は tool の返り値をそのまま発言にする
  await expect
    .poll(async () => (await assistantTexts(page, threadId)).join("\n"), { timeout: 120_000, message: "ターンが終わるまで" })
    .toContain("省きました（全体 12,000,000 文字）");
  const said = (await assistantTexts(page, threadId)).at(-1)!;
  const fromTurn = JSON.parse(said) as Ran;
  expect(fromTurn.exitCode).toBe(0);
  expect(fromTurn.stderrFile?.startsWith(`${outputDir}/`)).toBe(true);

  const group = page.locator('[data-slot="tool-group-trigger"]').first();
  const card = page.locator('[data-slot="tool-fallback-trigger"]', { hasText: "runCommand" }).first();
  const result = page.locator('[data-slot="tool-fallback-result"]').first();
  await expect(async () => {
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
    if ((await card.getAttribute("aria-expanded")) !== "true") await card.click();
    await expect(result).toContainText("省きました（全体 12,000,000 文字）", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(result).toContainText(fromTurn.stderrFile!);
  await expect(result).toContainText("rc=done");
  expect((await result.innerText()).length, "カードが 12MB を描いている").toBeLessThan(20_000);

  // ---- 5. Command Palette の入口が出る（一覧は Project の Module 全部に聞く）---------------------
  const launchers = await page.request.get(`${CORE_BASE_URL}/api/projects/${id}/ui-launchers`, { headers: HEADERS });
  expect(launchers.status()).toBe(200);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  await expect(page.getByText("Module の入口", { exact: true })).toBeVisible({ timeout: 30_000 });
  const entry = page.getByRole("option", { name: /ファイル/ });
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("この Project のファイルを見る・開く・編集する");
});
