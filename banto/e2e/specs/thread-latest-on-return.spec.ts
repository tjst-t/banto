// **ほかの Project へ行って戻ったら、会話は最新になっている**（直し・2026-10-15、ユーザー報告「ターンは終わっているのに
// 最新の返事が出ず、リロードしないと出ない」）。
//
// Project を開くと、その Project の開いている会話の記録を取り直して手元の写しを書き換える（`refreshRealProjectThreads`）。
// 同じとき、開いた会話の面は「最新を出す」（`latest-state.ts`）で記録を取り、写しと比べて違えば組み直す。写しの取り直しが
// 先に返ると、面は古い写しから組み立てられたままなのに「写しと記録が同じ＝もう最新」と見て組み直さず、戻る前の会話が
// 出たまま止まっていた。走っているターンへの乗り直しを確かめる `/stream` を遅らせて、取り直しが先に返る順番を作る
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";

test.setTimeout(180_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

async function baseThreadId(projectName: string): Promise<string> {
  const projects = await (await fetch(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === projectName);
  return (await (await fetch(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json())[0].id;
}

test("ほかの Project にいる間に終わったターンの返事が、戻ったときに出ている", async ({ page }) => {
  const first = "E2E Latest On Return A";
  const second = "E2E Latest On Return B";
  await openApp(page);
  await createProject(page, first, mkdtempSync(join(tmpdir(), "banto-e2e-latest-return-a-")));
  await expect(page.getByPlaceholder(`${first} の Base Thread に送る`)).toBeVisible();
  const threadId = await baseThreadId(first);
  await createProject(page, second, mkdtempSync(join(tmpdir(), "banto-e2e-latest-return-b-")));
  await expect(page.getByPlaceholder(`${second} の Base Thread に送る`)).toBeVisible();

  // ほかの Project にいる間に、最初の Project の会話でターンが走って終わる（別の画面・届いたもので起きた等）
  const reply = "戻ったら見えるはずの返事。おしまい。";
  const res = await fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "留守の間に送った発言。" + fakeTurn({ say: reply }) }),
  });
  expect(res.ok).toBe(true);
  await res.text();

  // 乗り直しの確かめ（`/stream`）を遅らせる——Project を開いたときの写しの取り直しが先に返る
  let delayed = 0;
  await page.route(
    (url) => url.pathname === `/api/threads/${threadId}/stream`,
    async (route) => {
      delayed += 1;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    },
  );

  await page.getByTestId("sidebar-project-name").filter({ hasText: first }).click();
  await expect(page.getByPlaceholder(`${first} の Base Thread に送る`)).toBeVisible();
  await expect.poll(() => delayed, { message: "会話の面が最新を確かめに来ていない（試験の前提が崩れた）" }).toBeGreaterThan(0);

  await expect(page.locator('[data-role="user"]').filter({ hasText: "留守の間に送った発言" }), "戻っても人の発言が出ない").toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: reply }), "戻っても AI の返事が出ない").toBeVisible({ timeout: 20_000 });
});
