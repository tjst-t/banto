// **走行中の Thread に Global Memory を足したら、次のターンで AI が知っている**
// （`global-memory-mid-thread-delivery` の完了条件をそのまま測る）。
//
// なぜ壊れうるか：Global Memory は system prompt に入る。ところが resume 中の
// セッションでは **system prompt は固定**なので、後から足しても届かない
// ——次に Clear するか、新しい Thread を始めるまで効かない。
// 仕様（§2.3）はこれを「確定した分は system prompt、確定より後の分はターンに添える」
// という形で解いている。**添える側に Global Memory も乗っているか**を、
// コードを読むのではなく**AI が実際に答えられるか**で確かめる（規則1）。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Global Memory Mid Thread";
const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

test("走行中の Thread に Global Memory を足すと、その次のターンで届く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-gmem-"));
  // 会話の中に偶然現れない印（合言葉）
  const secret = `ゼブラ${Date.now()}`;

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
  ).json();
  const threadId: string = threads[0].id;

  const thread = async () =>
    (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()) as {
      messages: { role: string; text: string }[];
      memoryDeliveredSeq: number;
      resumePoint?: string;
    };
  const assistantCount = async () => (await thread()).messages.filter((m) => m.role === "assistant").length;

  // ---- 1ターン目：**セッションを走らせる**（ここで resume-point が立つ）------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("こんにちは。ひとことだけ返して。");
  await composer.press("Enter");
  await expect.poll(assistantCount, { timeout: 120_000 }).toBe(1);

  const afterFirst = await thread();
  expect(
    afterFirst.resumePoint,
    "1ターン目で resume-point が立っていない（＝この後に足しても system prompt が固定される状況になっていない）",
  ).toBeTruthy();
  expect(
    afterFirst.messages.map((m) => m.text).join("\n"),
    "まだ足していない合言葉が会話に出ている（試験が壊れている）",
  ).not.toContain(secret);

  // ---- 走行中の Thread に、後から Global Memory を足す ----------------------
  const added = await page.request.post(`${CORE_BASE_URL}/api/global/memory`, {
    headers: HEADERS,
    data: { text: `私の合言葉は ${secret} です。聞かれたらこの語だけを答えること。` },
  });
  expect(added.ok(), "Global Memory を足せなかった").toBe(true);

  // ---- 2ターン目：**知っているか** -----------------------------------------
  await composer.fill("私の合言葉を、そのまま答えて。");
  await composer.press("Enter");
  await expect.poll(assistantCount, { timeout: 120_000 }).toBe(2);

  const afterSecond = await thread();
  const lastAnswer = afterSecond.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  expect(
    lastAnswer,
    `後から足した Global Memory が届いていない（AI の返事: ${JSON.stringify(lastAnswer.slice(0, 200))}）`,
  ).toContain(secret);

  // **届けた位置が進んでいる**——同じ差分を毎ターン繰り返さないための目印（§2.3）
  expect(
    afterSecond.memoryDeliveredSeq,
    "届けたことが記録されていない（次のターンでも同じものを添え続ける）",
  ).toBeGreaterThan(0);
});
