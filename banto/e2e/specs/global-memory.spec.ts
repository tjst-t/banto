// Global Memory（アーキ仕様§2.2、決定・2026-09-05）の回帰。
// /settings は大半がまだmockなので、**Global Memoryだけが出ていて、
// mockのセクションが出ていない**ことまで見る（規則13——繋がっていない入口を
// 画面に残さない。ここを見ないと、フラグを間違えてmock画面が復活しても気づけない）。
//
// **1つのファイルにまとめてある**（改訂・2026-09-07）。Global Memory は banto 全体で
// 1つなので、別ファイルに分けると「まだ無い」を見るテストと、足すテストの
// **走る順で結果が変わる**（実測：worker が2本あると順が入れ替わって落ちた）。
// 順番に意味があるものは同じファイルに置く（規則6——間欠にしない）。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Global Memory Mid Thread";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test("Global Memoryに人が足す→出る→取り消す→取り消し線になる", async ({ page }) => {
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);

  // 繋がっているセクションだけがnavに出る
  await expect(page.getByRole("button", { name: "Global Memory" })).toBeVisible({ timeout: 15_000 });
  // 「役割と Module」は 2026-09-15 に host へ繋がったので、ここには出る
  for (const mockSection of ["既定値", "資格情報", "通知"]) {
    await expect(page.getByRole("button", { name: mockSection })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Global Memory" }).click();
  await expect(page.getByText("まだ無い")).toBeVisible({ timeout: 10_000 });

  const draft = page.getByPlaceholder("覚えておいてほしいことを足す");
  await draft.fill("呼び方は「たくみ」");
  await page.getByRole("button", { name: "足す" }).click();

  const row = page.getByText("呼び方は「たくみ」");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).not.toHaveClass(/line-through/);

  await page.getByRole("button", { name: "この記憶を取り消す" }).click();
  await expect(row).toHaveClass(/line-through/, { timeout: 10_000 });
  // 取り消し済みは無効化のまま一覧に残る（物理削除ではない、規則3）
  await expect(page.getByRole("button", { name: "この記憶を取り消す" })).not.toBeVisible();
});

// **日本語入力の「変換確定」の Enter で足さない**（`memory-input-ime-enter`、2026-09-10）。
// Memory は追記オンリー（取り消し線でしか消せない）ので、まだ書き終えていない文が
// 入ると実害が残る。**変換中の Enter は「候補で確定する」という意味**でしかない。
test("変換確定の Enter では足さない——確定した後の Enter でだけ足す", async ({ page }) => {
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await page.getByRole("button", { name: "Global Memory" }).click();

  const draft = page.getByPlaceholder("覚えておいてほしいことを足す");
  const text = `変換中${Date.now()}`;
  await draft.fill(text);

  // 変換中の Enter（IME が出すのはこの形——`isComposing: true`）
  await draft.evaluate((el, key) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true }));
  }, "Enter");
  // 入力欄の中身は消えていない（打ちかけが失われない）
  await expect(draft).toHaveValue(text);

  // **「足されていない」は、足される側の往復を待ってから数える**（規則14）。
  // 直後に `toHaveCount(0)` を見るだけだと、**まだ届いていないだけ**でも通って
  // しまう（実測・2026-09-10——ガードを外しても、この試験は緑のままだった）。
  // 変換が終わってからの Enter で1件足し、**その1件しか無い**ことを見る
  await draft.press("Enter");
  await expect(page.getByText(text).first(), "確定後の Enter で足せない").toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(text), "変換確定の Enter でも足されている（2件になった）").toHaveCount(1);
});

test("走行中の Thread に Global Memory を足すと、その次のターンで届く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-gmem-"));
  // 会話の中に偶然現れない印（合言葉）
  const secret = `ゼブラ${Date.now()}`;

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

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
