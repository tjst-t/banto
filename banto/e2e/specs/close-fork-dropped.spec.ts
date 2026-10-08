// **AI が予約した「この Fork を閉じる」を閉じなかったとき、そのターンの会話に印が出る**（決定・2026-10-08、ユーザー。
// アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. close_fork を呼んだあとで裏の仕事（試験用 Module `fixtures/ask-human-module` の人の答え待ち）を頼んだターン：開いている
//      画面の、そのターンの AI の吹き出しに「（この Fork を閉じるのをやめました——閉じると予約したあとで裏の仕事を頼んだため。
//      残っている仕事：「題」。予約の理由：…）」が出る（再読み込みせずに）。読み直しても同じ吹き出しに出る
//   2. close_fork を呼んだあとで失敗したターン：同じく「…ターンが途中で終わったため。予約の理由：…）」が出る
//   どちらも Fork は閉じず（帯は出ず、入力欄が残り、host でも開いている）、受信箱にお知らせは出ない
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { confirmForkDialog, createProject, fakeTurn, openApp, settleProjectsInbox, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const STAMP = Date.now();
const MODULE = `e2e-close-dropped-ask-${STAMP}`;
const PROJECT_NAME = "E2E Close Fork Dropped";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ask-human-module/server.js");

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

async function openNamedFork(page: Page, title: string): Promise<string> {
  await page.getByRole("button", { name: "Fork を開く" }).first().click();
  await confirmForkDialog(page, { title });
  await page.waitForURL(/[?&]fork=[0-9a-f-]+/);
  return new URL(page.url()).searchParams.get("fork")!;
}

async function hostStatus(page: Page, threadId: string): Promise<string> {
  return ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as { status: string }).status;
}

/** その Project の、閉じる件のお知らせ（以前は受信箱に出していた） */
async function closeNotices(page: Page, projectId: string): Promise<string[]> {
  const items = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{
    kind: string;
    projectId?: string;
    title?: string;
  }>;
  return items.filter((i) => i.kind === "notice" && i.projectId === projectId && /Fork を閉じ/.test(i.title ?? "")).map((i) => i.title!);
}

/** 閉じなかった Fork の画面：帯は出ず、入力欄が残り、host でも開いている */
async function expectStillOpen(page: Page, forkId: string): Promise<void> {
  const forkLayer = page.locator('[data-layer="fork"]');
  await expect(forkLayer.getByTestId("fork-closed-banner"), "閉じていないのに帯が出た").toHaveCount(0);
  await expect(page.getByPlaceholder("この Fork Thread に送る"), "閉じていないのに入力欄が消えた").toBeVisible();
  expect(await hostStatus(page, forkId), "閉じなかったはずが host で閉じている").toBe("active");
}

test("close_fork のあとに裏の仕事を頼んだターン・失敗したターン：開いている画面のそのターンの吹き出しに「閉じるのをやめました」が出る", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const added = await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers,
    data: { mcpServers: { [MODULE]: { command: "${nodeExec}", args: [SERVER] } } },
  });
  expect(added.status(), `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-close-dropped-")));
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const projectId = projects.find((p) => p.name === PROJECT_NAME)?.id ?? "";
  const forkLayer = page.locator('[data-layer="fork"]');
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  const ai = () => forkLayer.locator('[data-role="assistant"]');

  // ---- 1. 予約のあとに裏の仕事を頼んだ ------------------------------------------------------------------
  const REFUSED_REASON = "引き継ぎを送った";
  const REFUSED_NOTE = `（この Fork を閉じるのをやめました——閉じると予約したあとで裏の仕事を頼んだため。残っている仕事：「試験の承認：閉じたあと」。予約の理由：${REFUSED_REASON}）`;
  const refusedId = await openNamedFork(page, "閉じたあとに頼む");
  await forkComposer.fill(
    "閉じて、そのあと承認も頼んで。" +
      fakeTurn({
        tools: [
          { server: "banto-thread", name: "close_fork", args: { reason: REFUSED_REASON } },
          { server: MODULE, name: "askHuman", args: { what: "閉じたあと" } },
        ],
        then: "閉じて、頼みました。",
      }),
  );
  await forkComposer.press("Enter");
  // **成功したときにだけ現れるもの**——印そのものを待つ（規則14）。askHuman は承認を聞くので、出たら許可する
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    await expect(ai().filter({ hasText: REFUSED_NOTE }), "開いている画面に印が出ない").toHaveCount(1, { timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await waitTurnEnded(page, refusedId, 1);
  // 同じターンの吹き出しの後ろに続く（別の吹き出しにならない）
  await expect(ai()).toHaveCount(1);
  await expect(ai().first()).toContainText("閉じて、頼みました。");
  await expectStillOpen(page, refusedId);

  // 読み直しても同じ吹き出しに出る（記録から組み直す道）
  await page.reload();
  await expect(ai().filter({ hasText: REFUSED_NOTE }), "読み直すと印が消えた").toHaveCount(1, { timeout: 30_000 });
  await expect(ai()).toHaveCount(1);
  await expectStillOpen(page, refusedId);

  // ---- 2. 失敗したターン ------------------------------------------------------------------------------
  const FAILED_REASON = "調べ終えた";
  const FAILED_NOTE = `（この Fork を閉じるのをやめました——ターンが途中で終わったため。予約の理由：${FAILED_REASON}）`;
  await page.getByRole("button", { name: /Base Thread に戻る$/ }).first().click();
  await expect(page).not.toHaveURL(/[?&]fork=/, { timeout: 15_000 });
  const failedId = await openNamedFork(page, "失敗する");
  await forkComposer.fill(
    "閉じて。" +
      fakeTurn({
        tools: [{ server: "banto-thread", name: "close_fork", args: { reason: FAILED_REASON } }],
        then: "閉じます。",
        fail: "API が途中で落ちた",
      }),
  );
  await forkComposer.press("Enter");
  await expect(ai().filter({ hasText: FAILED_NOTE }), "失敗したターンで、開いている画面に印が出ない").toHaveCount(1, { timeout: 60_000 });
  // 同じターンの吹き出しの後ろに続く
  await expect(ai().first()).toContainText("閉じます。");
  await expect(ai()).toHaveCount(1);
  await expect.poll(async () => hostStatus(page, failedId)).toBe("active");
  await expectStillOpen(page, failedId);

  await page.reload();
  await expect(ai().filter({ hasText: FAILED_NOTE }), "読み直すと印が消えた").toHaveCount(1, { timeout: 30_000 });
  await expectStillOpen(page, failedId);

  // 受信箱には出さない
  expect(projectId, "Project の id が取れない（試験の前提が崩れた）").not.toBe("");
  expect(await closeNotices(page, projectId), "受信箱に閉じる件のお知らせが出た").toEqual([]);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
