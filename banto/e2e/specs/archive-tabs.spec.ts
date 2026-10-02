// 履歴（Archive）は**見るときはタブで分かれ、探すときは横断する**
// （改訂・2026-09-12、ユーザー要望。`docs/specs/v4-frontend.md` §6.20）。
//
// 見るのは「タブが押せた」ではなく**何が出ているか**（規則14）——タブを切り替えた
// ときに、出ているべきものが出て、出ていないはずのものが消えているところまで。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../test-base.js";
import { createProject, openApp, openNav, openProjectSettings, confirmForkDialog } from "../helpers.js";

test.setTimeout(300_000);

test("履歴は、タブで Fork と Project を分け、検索は両方から出す", async ({ page }) => {
  await openApp(page);

  // ---- 閉じた Project を1つ用意する ---------------------------------------
  // 名前に「Fork」を入れておく——**検索が横断していること**を、1つの言葉で
  // 両方に当てて確かめるため
  await createProject(page, "Fork たち", mkdtempSync(join(tmpdir(), "banto-e2e-archive-a-")));
  await openProjectSettings(page, "一般");
  await page.getByRole("button", { name: "この Project を Close する" }).click();
  // **host が畳み終えるまで待つ**（追加・2026-10-01）。設定のボタンは押した瞬間に消えるので、それだけ見ると
  // 畳む要求がまだ返っていないうちに次へ進む——前の Project のコンテナが冷えていて画面の準備が遅い回で、
  // 次の「新しい Project」が畳む前の設定画面と重なって落ちた
  const closed = page.waitForResponse(
    (r) => /\/api\/projects\/[^/]+\/close$/.test(r.url()) && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Close する" }).click();
  expect((await closed).ok(), "Project を畳む要求が失敗した").toBe(true);
  await expect(
    page.getByRole("button", { name: "この Project を Close する" }),
    "Close したのに設定が残っている",
  ).toHaveCount(0, { timeout: 20_000 });

  // ---- 見る側の Project と、閉じた Fork Thread -----------------------------
  await createProject(page, "アーカイブの spec", mkdtempSync(join(tmpdir(), "banto-e2e-archive-b-")));
  const forkBack = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  await expect(forkBack, "Fork が開かない").toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "この Fork Thread を Close" }).click();
  await expect(forkBack).not.toBeVisible();

  // ---- 履歴を開く ---------------------------------------------------------
  await openNav(page);
  await page.getByRole("button", { name: "履歴", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const forkRow = dialog.getByText(/^Fork \d+$/);
  const projectRow = dialog.getByText("Fork たち", { exact: true });

  // 既定は Fork のタブ——**この Project のもの**が出て、Project は出ていない
  await expect(page.getByTestId("archive-tab-forks"), "Fork のタブが選ばれていない").toHaveAttribute(
    "data-state",
    "active",
    { timeout: 15_000 },
  );
  await expect(forkRow.first(), "閉じた Fork Thread が出ていない").toBeVisible();
  await expect(projectRow, "Fork のタブなのに閉じた Project が出ている").toHaveCount(0);

  // ---- Project のタブへ ---------------------------------------------------
  await page.getByTestId("archive-tab-projects").click();
  await expect(projectRow, "閉じた Project が出ていない").toBeVisible({ timeout: 15_000 });
  await expect(forkRow, "Project のタブなのに Fork が出ている").toHaveCount(0);

  // ---- 検索は横断する -----------------------------------------------------
  await dialog.getByPlaceholder("名前で検索").fill("fork");
  await expect(dialog.getByText("この Project の閉じた Fork Thread"), "Fork の見出しが出ない").toBeVisible();
  await expect(dialog.getByText("閉じた Project", { exact: true }), "Project の見出しが出ない").toBeVisible();
  await expect(forkRow.first(), "検索したのに Fork が出ない").toBeVisible();
  await expect(projectRow, "検索したのに Project が出ない").toBeVisible();
  // **検索中は、どちらのタブも選ばれていない**（結果が横断なので）
  await expect(page.getByTestId("archive-tab-forks")).toHaveAttribute("data-state", "inactive");
  await expect(page.getByTestId("archive-tab-projects")).toHaveAttribute("data-state", "inactive");

  // タブを押すと検索はやめて、その一覧に戻る
  await page.getByTestId("archive-tab-forks").click();
  await expect(dialog.getByPlaceholder("名前で検索")).toHaveValue("");
  await expect(projectRow, "タブに戻ったのに Project が残っている").toHaveCount(0);
  await expect(forkRow.first()).toBeVisible();
});
