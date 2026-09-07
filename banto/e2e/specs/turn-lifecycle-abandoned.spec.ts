// 走行中のターンを画面から捨てたあと、その Thread が使えなくなっていないか。
//
// `live.done` は SSE の done/error を**自分で読んだときだけ**立つので、
// パネルがアンマウントされる（別 Project へ移る・Fork を畳む・Canvas を開く）と
// 「このブラウザはもう読んでいない」が記録されない。すると：
//   - `hasLiveRealRun()` が永久に true → 生きている判断待ちが復元されない
//   - 次の送信が「新しいターン」と見なされず、**host に届かないまま消える**
// （見直し・2026-09-06、docs/notes/2026-09-06-tool-approval-review.md）
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_A = "E2E Abandon A";
const PROJECT_B = "E2E Abandon B";

async function createProject(page: import("@playwright/test").Page, name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-abandon-"));
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(name);
  await page.getByLabel("Base パス").fill(root);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${name}`)).toBeVisible({ timeout: 15_000 });
  return root;
}

test("判断待ちを残したまま別 Project へ移って戻っても、答えられるし次も送れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_A);

  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("filesystem の listDirectory で「.」の中身を一覧してください。");
  await composer.press("Enter");
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });

  const judgments = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  const target = judgments.find((i: { kind: string }) => i.kind === "judgment");
  expect(target).toBeTruthy();
  const threadId: string = target.threadId;

  // 戻る先を控えておく——**レールのリンクでは引かない**。E2Eの Project 名は
  // どれも「E」で始まるので、頭文字のアイコンでは別の Project を掴む
  // （実測・2026-09-06。2026-09-05 に踏んだ「別Projectのパネルに一致する」と同型）
  const projectAUrl = page.url();

  // 別 Project を作る＝A のパネルはアンマウントされ、走行中のターンは画面から捨てられる
  await createProject(page, PROJECT_B);

  // A に戻る
  await page.goto(projectAUrl);
  await expect(page.getByText(`Base Thread — ${PROJECT_A}`)).toBeVisible({ timeout: 30_000 });

  // host 側では判断待ちは生きたまま
  const stillOpen = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  expect(stillOpen.some((i: { id: string }) => i.id === target.id)).toBe(true);

  // **答えられる状態で戻っていること**（いまはここが出ない＝誰も答えられない）
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  await expect
    .poll(
      async () => {
        const now = await (
          await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return now.some((i: { id: string }) => i.id === target.id);
      },
      { timeout: 60_000 },
    )
    .toBe(false);

  // **次の発言が host に届くこと**——詰まっていると、送ったつもりで消える
  const before = await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  const userCountBefore = (before.messages as { role: string }[]).filter((m) => m.role === "user").length;

  await page.getByPlaceholder(/に送る/).fill("目印として「戻れた789」とだけ返してください。");
  await page.getByPlaceholder(/に送る/).press("Enter");

  await expect
    .poll(
      async () => {
        const t = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return (t.messages as { role: string }[]).filter((m) => m.role === "user").length;
      },
      { timeout: 90_000 },
    )
    .toBe(userCountBefore + 1);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
