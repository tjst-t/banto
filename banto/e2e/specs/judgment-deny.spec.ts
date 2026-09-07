// 拒否（deny）の経路の回帰（見直し・2026-09-06 で「一度も通っていない」と判明）。
//
// §2.4.1 の MUST「断る／取り消す手段を明確に出す」に対応する。
// 規則14：「拒否できた」で終わらせず、**拒否したものが実行されていない**ことを
// 中身で確かめる——読ませなかったファイルの中身が画面に出ないこと。
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Deny Project";

test("拒否すると tool は実行されず、その事実が画面に出る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-deny-"));
  // 「拒否したのに読まれたら必ず画面に出る」一意な中身
  const secret = `禁則事項${Date.now()}`;
  writeFileSync(join(projectRoot, "secret.txt"), `${secret}\n`);

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("filesystem の readFile で secret.txt を読んで、中身をそのまま見せてください。");
  await composer.press("Enter");

  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });

  // **何を承認しようとしているか**が、答える前に**承認カードの中に**見えている
  // （§6.0「サーバを呼ぶ前に人に見せる」・決定・2026-09-06）
  const card = page.locator('[data-role="judgment-card"]').first();
  await expect(card.getByText(/secret\.txt/)).toBeVisible({ timeout: 15_000 });

  const before = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  const target = before.find((i: { kind: string }) => i.kind === "judgment");
  expect(target).toBeTruthy();
  const threadId: string = target.threadId;

  await page.getByRole("button", { name: "拒否する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  // host 側で決着する
  await expect
    .poll(
      async () => {
        const open = await (
          await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return open.some((i: { id: string }) => i.id === target.id);
      },
      { timeout: 60_000 },
    )
    .toBe(false);

  await expect(page.getByText("回答：拒否する")).toBeVisible({ timeout: 60_000 });

  // 拒否のあともターンは正しく終わる（AIがエラーを受けて返事を書く）
  await expect
    .poll(
      async () => {
        const t = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);

  // **読まれていないこと**——拒否したのに実行されていたら、必ずここに出る
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  const thread = await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  expect(
    (thread.messages as { text: string }[]).some((m) => m.text.includes(secret)),
    "拒否したのにファイルの中身が会話に入っている",
  ).toBe(false);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
