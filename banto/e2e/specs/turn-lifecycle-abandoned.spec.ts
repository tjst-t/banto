// 走行中のターンを画面から捨てたあと、その Thread が使えなくなっていないか。
//
// `live.done` は SSE の done/error を**自分で読んだときだけ**立つので、
// パネルがアンマウントされる（別 Project へ移る・Fork を畳む・Canvas を開く）と
// 「このブラウザはもう読んでいない」が記録されない。すると：
//   - `hasLiveRealRun()` が永久に true → 生きている判断待ちが復元されない
//   - 次の送信が「新しいターン」と見なされず、**host に届かないまま消える**
// （見直し・2026-09-06、docs/notes/2026-09-06-tool-approval-review.md）
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, expectProjectOpen, openApp, fakeTurn, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_A = "E2E Abandon A";
const PROJECT_B = "E2E Abandon B";

/** この spec 用——一時ディレクトリを作ってから Project を作り、その root を返す */
async function createProjectInTmp(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-abandon-"));
  await createProject(page, name, root);
  return root;
}

test("判断待ちを残したまま別 Project へ移って戻っても、答えられるし次も送れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProjectInTmp(page, PROJECT_A);

  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("この Project の直下を一覧してください。" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }] }));
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
  await createProjectInTmp(page, PROJECT_B);

  // A に戻る
  await page.goto(projectAUrl);
  await expectProjectOpen(page, PROJECT_A);

  // host 側では判断待ちは生きたまま
  const stillOpen = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  expect(stillOpen.some((i: { id: string }) => i.id === target.id)).toBe(true);

  // **答えられる状態で戻っていること**（いまはここが出ない＝誰も答えられない）
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "許可する" }).click();

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

  // 答えたあとの続きは、戻ってきた画面の本文にそのまま流れる（改訂・2026-09-26——走っているターンに乗る）。
  // **走っている間は、自分で送ったときと同じく送れない**（止めるボタンになり、Enter も効かない）。
  // **待つのは、そのターンが終わった印**——host の記録に返事が入るまで。「送るボタンが見える」では待たない：
  // 答えた直後の一瞬はまだ「判断待ち」の形で送るボタンが出ていて、その直後に走り出す（実測・2026-09-26、
  // ここで Enter を押して、走っている最中の送信として無視されていた）
  // （返事の件数では待たない——返事は書き終えるごとに記録に入る。2026-10-05）
  await waitTurnEnded(page, threadId, 1);
  await expect(page.getByRole("button", { name: "Send message" }), "ターンが終わったのに、画面が終わった形に戻らない").toBeVisible({
    timeout: 30_000,
  });

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
