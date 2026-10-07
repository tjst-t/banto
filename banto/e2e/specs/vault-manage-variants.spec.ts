// **Vault の管理画面：「移す」「参照を作る」で版（Infisical の環境）を選べる**（2026-10-07、ユーザー「Env の指定も
// できる必要があるかも」。仕様 v4-modules.md §2.1「グループの『版』」）。
//
// 版を名乗る Vault は E2E では立てられないので（`fixtures/vault-manage-harness` の頭を参照）、**本物の画面の HTML と JS を
// 本物の Chromium で**、偽の host の中で動かす。見るのは画面が出している中身（規則14）——版の欄が出る／出ない、
// グループ欄の選択肢の文言（Vault での本当の名前・この Project と Global の添え）、押す前の説明、そして**押したときに
// 窓口へ渡る置き場**（`g@prod`、既定の版なら `@` 無し）。窓口・kit がそれを受けて移す・置くことは単体試験
// （vault-directory・vault-kit の variants.test.ts）が押さえる
import { test, expect } from "../test-base.js";
import type { FrameLocator, Page } from "@playwright/test";
import { MANAGE_APP_HTML } from "../../packages/modules/vault-directory/dist/manage-app.js";
import { harnessHtml, variantState, PROJECT_GROUP } from "../fixtures/vault-manage-harness/harness.mjs";

type Call = { name: string; args: Record<string, unknown> };

async function openHarness(page: Page): Promise<FrameLocator> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 920, height: 680 });
  await page.setContent(harnessHtml());
  await page.evaluate(([html, state]) => (window as unknown as { __open: (h: string, s: unknown) => void }).__open(html, state), [
    MANAGE_APP_HTML,
    variantState(),
  ] as const);
  const app = page.frameLocator("#app");
  await expect(app.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 }); // 既定の絞り込み（この Project から使える）で HOST だけ
  await app.locator("#target-filter").selectOption("all");
  await expect(app.locator("tbody tr")).toHaveCount(3);
  expect(errors).toEqual([]);
  return app;
}

async function rowAction(app: FrameLocator, name: string, label: string): Promise<void> {
  await app.locator("tbody tr").filter({ hasText: name }).getByRole("button", { name: /の操作$/ }).click();
  await app.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click();
}

function calls(page: Page, name: string): Promise<Call[]> {
  return page.evaluate((n) => ((window as unknown as { __calls: Call[] }).__calls).filter((c) => c.name === n), name);
}

/** 選択肢の「値 => 見える文字」。素の select でも base-select でも、読み上げ・素の描画が使うのは textContent */
function optionTexts(app: FrameLocator, id: string): Promise<string[]> {
  return app.locator(`#${id} option`).evaluateAll((os) => os.map((o) => `${(o as HTMLOptionElement).value} => ${o.textContent}`));
}

test("移す：版を名乗る Vault だけ版の欄が出て、選んだグループと版から g@版 を渡す（既定の版は @ 無し）", async ({ page }) => {
  const app = await openHarness(page);
  await rowAction(app, "CF_TOKEN", "秘密を移動");
  await expect(app.locator("#dlg-move")).toBeVisible();
  await expect(app.locator("#move-now")).toHaveText("いまは vault-infisical / tools");

  // グループ欄は既定の版の名前だけ。主は Vault での本当の名前（UUID も省かない）、この Project・Global は添え
  expect(await optionTexts(app, "move-group")).toEqual([
    "homelab => homelab — この Project",
    "instance => instance — Global",
    `${PROJECT_GROUP} => ${PROJECT_GROUP}`,
    "tools => tools",
  ]);
  // 添えは薄く（base-select では span のまま描かれる）
  await expect(app.locator('#move-group option[value="homelab"] .opt-tag')).toHaveCSS("opacity", "0.55");
  // 版の欄：Vault の名乗った呼び名と選択肢、最初はいまの置き場（tools の既定の版）
  const variant = app.locator("#move-variant");
  await expect(variant).toBeVisible();
  await expect(variant).toHaveAttribute("aria-label", "環境");
  expect(await optionTexts(app, "move-variant")).toEqual(["dev => dev（既定）", "staging => staging", "prod => prod"]);
  await expect(variant).toHaveValue("dev");
  await expect(app.locator("#move-group")).toHaveValue("tools");
  await expect(app.locator("#move-effect")).toHaveText("もう その置き場に在ります");
  await expect(app.locator("#move-submit")).toBeDisabled();

  // 版だけ変える：紐付いていない版付きの置き場は一覧に出なくなる——押す前に言う
  await variant.selectOption("staging");
  await expect(app.locator("#move-submit")).toBeEnabled();
  await expect(app.locator("#move-effect")).toContainText(
    "環境 staging の tools はどの Project にも紐付いていないので、紐付けるまで この一覧には出ません（Vault には在ります）",
  );
  // この Project の置き場（homelab の prod、紐付いている）を選ぶ——注意は出ず、この Project から使えると言う
  await app.locator("#move-group").selectOption("homelab");
  await variant.selectOption("prod");
  await expect(app.locator("#move-effect")).toHaveText("→ この Project からだけ使えます（素の名前で引けます）");
  await app.locator("#move-submit").click();
  await expect(app.locator("#dlg-move"), "移せずに小窓が開いたまま").toBeHidden();
  expect((await calls(page, "migrateAlias")).map((c) => c.args)).toEqual([
    { name: "CF_TOKEN", implementation: "vault-infisical", group: "tools", toImplementation: "vault-infisical", toGroup: "homelab@prod" },
  ]);

  // 既定の版を選んだら @ を付けない
  await rowAction(app, "CF_TOKEN", "秘密を移動");
  await app.locator("#move-group").selectOption("instance");
  await expect(app.locator("#move-variant")).toHaveValue("dev");
  await expect(app.locator("#move-effect")).toHaveText("→ どの Project からでも使えます（素の名前で引けます）");
  await app.locator("#move-submit").click();
  await expect(app.locator("#dlg-move")).toBeHidden();
  expect((await calls(page, "migrateAlias")).at(-1)!.args.toGroup).toBe("instance");

  // 版を名乗らない Vault に切り替えると版の欄は消え、グループ名そのまま。版を読めなかった Vault は理由を出す
  await rowAction(app, "CF_TOKEN", "秘密を移動");
  await app.locator("#move-vault").selectOption("vault-local");
  await expect(app.locator("#move-variant")).toBeHidden();
  await expect(app.locator("#move-variant-note")).toBeHidden();
  expect(await optionTexts(app, "move-group")).toEqual(["instance => instance", "local-a => local-a"]);
  await app.locator("#move-vault").selectOption("vault-broken");
  await expect(app.locator("#move-variant")).toBeHidden();
  await expect(app.locator("#move-variant-note")).toHaveText("版を読めませんでした（既定の版に置きます）：接続できませんでした");
  await app.locator("#move-submit").click();
  await expect(app.locator("#dlg-move")).toBeHidden();
  expect((await calls(page, "migrateAlias")).at(-1)!.args).toMatchObject({ toImplementation: "vault-broken", toGroup: "b" });
});

test("参照を作る：版の欄が出て、既定はこの Project の置き場（版まで）、選んだ版で g@版 を渡す", async ({ page }) => {
  const app = await openHarness(page);
  // 元は tools（どこにも紐付いていない）。置く先の既定は この Project の置き場＝homelab の prod
  await rowAction(app, "CF_TOKEN", "参照を作る");
  await expect(app.locator("#dlg-link")).toBeVisible();
  await expect(app.locator("#link-now")).toHaveText("元は vault-infisical / tools / CF_TOKEN");
  await expect(app.locator("#link-group")).toHaveValue("homelab");
  await expect(app.locator("#link-variant")).toBeVisible();
  await expect(app.locator("#link-variant")).toHaveValue("prod");
  await expect(app.locator("#link-effect")).toHaveText("→ この Project からだけ使えます（素の名前で引けます）");
  expect(await optionTexts(app, "link-group")).toContain("homelab => homelab — この Project");

  // 同じ名前がある置き場（homelab の prod には HOST がある）は押させない——版まで含めて比べる
  await app.locator("#link-name").fill("HOST");
  await expect(app.locator("#link-effect")).toHaveText("置く先に同じ名前があります（上書きしません）——名前を変えてください");
  await expect(app.locator("#link-submit")).toBeDisabled();
  await app.locator("#link-variant").selectOption("staging");
  await expect(app.locator("#link-submit")).toBeEnabled();
  await expect(app.locator("#link-effect")).toContainText("環境 staging の homelab はどの Project にも紐付いていないので");
  await app.locator("#link-submit").click();
  await expect(app.locator("#dlg-link"), "参照を作れずに小窓が開いたまま").toBeHidden();
  expect((await calls(page, "linkAlias")).map((c) => c.args)).toEqual([
    { name: "CF_TOKEN", implementation: "vault-infisical", group: "tools", toGroup: "homelab@staging", toName: "HOST" },
  ]);

  // 元が この Project の置き場にあるなら、既定は Global（既定の版）
  await rowAction(app, "HOST", "参照を作る");
  await expect(app.locator("#link-now")).toHaveText("元は vault-infisical / homelab（環境 prod） / HOST");
  await expect(app.locator("#link-group")).toHaveValue("instance");
  await expect(app.locator("#link-variant")).toHaveValue("dev");
  await app.locator("#link-submit").click();
  await expect(app.locator("#dlg-link")).toBeHidden();
  expect((await calls(page, "linkAlias")).at(-1)!.args).toMatchObject({ group: "homelab@prod", toGroup: "instance" });
});
