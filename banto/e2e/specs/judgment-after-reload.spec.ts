// 判断待ちが立っている最中にページを再読み込みしたら、承認カードは戻るか。
// ——ユーザー報告（2026-09-06、実インスタンスで「承認が出なかった」のに
// host側には判断待ちが生きたまま残っていた）の再現を試みる計測用。
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, expectProjectOpen, openApp, fakeTurn, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Reload Judgment";

test("判断待ちの最中にリロードしても、承認カードは戻ってくる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-reload-"));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("この Project の直下を一覧してください。" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }] }));
  await composer.press("Enter");

  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });

  // ここでリロード——host側の判断待ちは生きたまま（hold-the-line）
  await page.reload();
  await expectProjectOpen(page, PROJECT_NAME);

  const open = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  expect(open.some((i: { kind: string }) => i.kind === "judgment")).toBe(true);
  const threadId: string = open.find((i: { kind: string }) => i.kind === "judgment").threadId;

  // 会話の画面に、答えられる承認カードが戻っているか
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("tool呼び出しの承認: mcp__filesystem__listDirectory")).toBeVisible();

  // 実際に答えられて、止まっていたターンが動き出すところまで見る（規則14）
  const target = open.find((i: { kind: string }) => i.kind === "judgment");
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
      { timeout: 30_000 },
    )
    .toBe(false);

  // 答えたあとの続き（このブラウザにはSSEが無い）が、hostの記録から画面に入る。
  // 「何か出た」で済ませず、**hostが記録した最後の返事の本文そのもの**が
  // 画面に出ていることを見る（規則14）
  // ターンが最後まで終わってから、記録の返事を読む（返事は書き終えるごとに記録に入る——途中の文で比べない。2026-10-05）
  const ended = await waitTurnEnded(page, threadId, 1, 120_000);
  const lastAssistantText = ended.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  expect(lastAssistantText, "ターンが終わったのに返事の文が無い").not.toBe("");

  // **見出しやコード片で要素が分かれても落ちない形で比べる**（改訂・2026-09-10）。
  // 以前は「記録した本文の先頭30字が1つのテキストノードにある」ことを見ていたため、
  // AI がその範囲に `パス` のようなコード片を書いた回だけ落ちた
  // （実測・2026-09-10：同じ spec が通ったり落ちたりした）。見たいのは
  // 「host が記録した返事が画面に出ていること」なので、描画後の文字列同士で比べる
  // ——記法の文字と空白を落として突き合わせる（規則6——間欠を待ち時間で誤魔化さない）
  const normalize = (text: string) => text.replace(/[`*_#>~-]/g, "").replace(/\s+/g, "");
  await expect
    .poll(async () => normalize(await page.locator("body").innerText()), { timeout: 60_000 })
    .toContain(normalize(lastAssistantText.slice(0, 30)));
});
