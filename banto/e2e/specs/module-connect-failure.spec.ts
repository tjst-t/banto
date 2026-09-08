// Module が繋がらないときの伝え方（`module-connect-failure-surface`）。
//
// **壊れていることより、壊れ方が問題だった**（ユーザー報告・2026-09-06）：
//   - 失敗を覚えていないので、**人が発言するたびに**同じ起動を試して同じように落ち、
//     会話に毎ターン同じエラーが出ていた
//   - 一覧を組み立てる途中で例外になるため、**1本の設定ミスでその Project の
//     会話が丸ごと止まって**いた
//
// 安全側（繋がない・黙って緩めない）はそのままに、次の3つを見る：
//   1. 会話にエラーが出ない（2ターン送っても）
//   2. それでも会話は進む（繋がった Module だけで）
//   3. 人が気づける場所が1つある——受信箱に**1件だけ**
import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Module Connect Failure";
const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

test("Module が繋がらなくても、会話は進み、受信箱に1件だけ出る", async ({ page }) => {
  // **1本だけ**繋がらない状態を作る（Project の根まで壊すと会話自体が始まらず、
  // それは別の不具合になる——実測・2026-09-07）。ここでは filesystem の置き場に
  // ディレクトリではなくファイルを置いて、その1本の起動だけを失敗させる
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-modfail-"));

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // **壊してから開く**——Project を開いた時点で host は Module を用意するので
  // （決定・2026-09-07）、UI から作ると用意のほうが先になる。ここでは記録だけ
  // 先に作り、置き場を塞いでから画面で開く
  await openApp(page);
  const project = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers: HEADERS,
      data: { name: PROJECT_NAME, root: projectRoot },
    })
  ).json();
  const baseThread = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
  ).json();
  const threadId: string = baseThread.id;

  // **その Project の filesystem だけが起動できない**状態にする
  // （host は Module ごとの置き場を作ってから起動する——そこがファイルなら作れない）
  mkdirSync(join(DATA_DIR, "modules"), { recursive: true });
  writeFileSync(join(DATA_DIR, "modules", `filesystem-${project.id}`), "ディレクトリではない\n");

  await page.goto(`/p/${project.id}`);
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 30_000 });

  const assistantCount = async () => {
    const t = await (
      await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })
    ).json();
    return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
  };
  const noticeCount = async () => {
    const items = await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: HEADERS })).json();
    return (items as { kind: string; projectId?: string }[]).filter(
      (i) => i.kind === "notice" && i.projectId === project.id,
    ).length;
  };

  // ---- 1ターン目 -----------------------------------------------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("こんにちは。ひとことで返して。");
  await composer.press("Enter");
  await expect.poll(assistantCount, { timeout: 120_000 }).toBe(1);

  // **会話は進んでいる**（繋がった Module だけで動く）
  // **エラーは会話に出ていない**——起動の失敗はここには書かない
  const firstAnswer = await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })
  ).json();
  const texts = (firstAnswer.messages as { role: string; text: string }[]).map((m) => m.text).join("\n");
  expect(texts, "会話に起動失敗のエラーが混ざっている").not.toMatch(/Landlock|ENOENT|ENOTDIR|spawn|繋げませんでした/);

  const afterFirst = await noticeCount();
  expect(afterFirst, "Module が繋がらなかったのに、人に伝わる場所が無い").toBe(1);

  // ---- 2ターン目：**増えない**ことがこの spec の核心 -----------------------
  await composer.fill("もう一度、ひとことだけ。");
  await composer.press("Enter");
  await expect.poll(assistantCount, { timeout: 120_000 }).toBe(2);

  const afterSecond = await noticeCount();
  expect(afterSecond, "発言のたびにお知らせが積み増している（毎ターン試し直している）").toBe(1);

  const texts2 = (
    await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()
  ).messages
    .map((m: { text: string }) => m.text)
    .join("\n");
  expect(texts2, "2ターン目の会話にエラーが混ざっている").not.toMatch(/Landlock|ENOENT|ENOTDIR|spawn|繋げませんでした/);

  // ---- 受信箱に出ていて、確認したら消える ----------------------------------
  await page.getByRole("button", { name: "受信箱" }).click();
  const notice = page.locator('[data-testid="inbox-notice"]');
  await expect(notice, "受信箱にお知らせが出ていない").toHaveCount(1, { timeout: 15_000 });
  await expect(notice).toContainText(/繋げませんでした/);

  await notice.getByRole("button", { name: "確認した" }).click();
  await expect(notice, "確認しても消えない").toHaveCount(0, { timeout: 15_000 });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
