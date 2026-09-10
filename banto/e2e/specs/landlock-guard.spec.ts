// 閉じ込めの最後の防波堤（`@banto/landlock` の `assertRulesetIsSafe`）が
// **本番の経路に繋がっている**ことを見る（`landlock-guard-wiring`）。
//
// 検査自体は前から実装・テスト済みだったが、host が呼んでいなかった
// ——人が Project の根に home を指定すると、home 全域が読み書き可のルールセットで
// Shell が起動していた。「有るのに配線されていない」を残さない（規則13の精神）。
//
// 規則14：「起動しなかった」で終わらせず、**人に理由が見えるところまで**見る
// ——受信箱のお知らせに、どのパスが問題かが出ていること。
import { test, expect } from "@playwright/test";
import { homedir } from "node:os";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Landlock Guard Project";

test("Project の根に home を指定すると、閉じ込める Module は起動せず、理由が受信箱に出る", async ({
  page,
}) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

  // **home を根にした Project**——ここが「弱いルールセットが書き出される」入口
  const project = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: PROJECT_NAME, root: homedir() },
    })
  ).json();

  // 画面から作った Project と同じ形にする（Base Thread が1本ある）
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });

  // Module を用意させる（ターンを走らせなくても、この口で起動を試みる）
  const prepared = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, { headers })
  ).json();

  // 閉じ込めを宣言している Module（Shell・FileSystem）は**繋がっていない**
  expect(prepared.connected).not.toContain("shell");
  expect(prepared.connected).not.toContain("filesystem");
  // 閉じ込めと関係ない Module（Vault）はそのまま使える——全部が止まるわけではない
  expect(prepared.connected).toContain("vault");

  // **理由が人に見える**（§5.4-0——会話は進み、受信箱に1件出る）
  const inbox = await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json();
  const notices = inbox.filter(
    (i: { kind: string; projectId?: string }) => i.kind === "notice" && i.projectId === project.id,
  );
  expect(notices.length).toBeGreaterThan(0);
  const detail = notices.map((n: { detail: string }) => n.detail).join("\n");
  expect(detail).toContain("禁止パス");
  expect(detail).toContain(homedir());

  // 画面でも読める（受信箱のお知らせ）
  await openApp(page);
  await page.getByRole("button", { name: "受信箱" }).first().click();
  const notice = page.locator('[data-testid="inbox-notice"]').first();
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice.getByText(/を繋げませんでした/)).toBeVisible();
  await expect(notice.getByText(/禁止パス/)).toBeVisible();

  // **出したものは片づける**——受信箱は banto 全体で1つなので、残すと
  // 他の spec の「受信箱に1件だけ」を壊す（実測・2026-09-10）。
  // **お知らせは Module ごとに非同期で出る**ので、1回取った一覧だけを消すと
  // 後から出た分が残る（実測・2026-09-10——shell を消した後に filesystem が出た）。
  // 「この Project の分が無くなるまで」消す
  await expect
    .poll(
      async () => {
        const open = await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json();
        const mine = open.filter((i: { projectId?: string }) => i.projectId === project.id);
        for (const item of mine) {
          await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
        }
        return mine.length;
      },
      { timeout: 20_000, message: "この Project のお知らせを片づけきれない" },
    )
    .toBe(0);
});
