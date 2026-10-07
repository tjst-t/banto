// **Vault の管理画面：グループを作る入口と「値を変える」**（2026-10-07、ユーザー。仕様 v4-modules.md §2.1
// 「紐付けの選択肢は2つ」・C節 `replaceSecretValue`・管理 Canvas）。
//
// 版を名乗る Vault（Infisical）と、参照・OAuth・SSH 鍵・ファイル・空の行を一度に並べたいので、vault-manage-variants と同じく
// **本物の画面の HTML と JS を本物の Chromium で**、偽の host の中で動かす（`fixtures/vault-manage-harness`）。見るのは
// 画面が出している中身（規則14）——出る欄・添え書き・押せるか・押したときに窓口へ渡る引数・閉じたあとの DOM に値が
// 残っていないこと。窓口・kit がそれを受けて作る・置き換えることは単体試験が押さえ、本物の banto を通した流れは
// vault-directory.spec.ts が押さえる
import { test, expect } from "../test-base.js";
import type { FrameLocator, Page } from "@playwright/test";
import { MANAGE_APP_HTML } from "../../packages/modules/vault-directory/dist/manage-app.js";
import { harnessHtml, variantState } from "../fixtures/vault-manage-harness/harness.mjs";

type Call = { name: string; args: Record<string, unknown> };

/** 版を名乗る Vault の置き場に、値を変える試験用の行を足した状態。 */
function editState() {
  const s = variantState();
  s.aliases.push(
    { name: "deploy", kind: "ssh-identity", implementation: "vault-infisical", group: "tools", scope: "unbound", projects: [] },
    { name: "conf", kind: "file", implementation: "vault-infisical", group: "tools", scope: "unbound", projects: [] },
    { name: "EMPTY", kind: "secret", implementation: "vault-infisical", group: "tools", scope: "unbound", projects: [], empty: true },
    // 参照（元は tools / CF_TOKEN）と、banto が置くログイン情報
    { name: "CF_REF", implementation: "vault-infisical", group: "homelab@prod", scope: "project", projects: ["P"], kind: "secret", linkTo: { group: "tools", name: "CF_TOKEN" } } as never,
    { name: "gh-login", kind: "oauth-token", implementation: "vault-infisical", group: "instance", scope: "shared", projects: [] },
  );
  return s;
}
const ROWS = editState().aliases.length;

async function openHarness(page: Page): Promise<FrameLocator> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 920, height: 680 });
  await page.setContent(harnessHtml());
  await page.evaluate(([html, state]) => (window as unknown as { __open: (h: string, s: unknown) => void }).__open(html, state), [
    MANAGE_APP_HTML,
    editState(),
  ] as const);
  const app = page.frameLocator("#app");
  await expect(app.locator("#target-filter option[value='all']")).toHaveCount(1, { timeout: 15_000 });
  await app.locator("#target-filter").selectOption("all");
  await expect(app.locator("tbody tr")).toHaveCount(ROWS);
  expect(errors).toEqual([]);
  return app;
}

const row = (app: FrameLocator, name: string) => app.locator("tbody tr").filter({ has: app.locator(".name-text", { hasText: new RegExp(`^${name}$`) }) });

async function rowAction(app: FrameLocator, name: string, label: string): Promise<void> {
  await row(app, name).getByRole("button", { name: /の操作$/ }).click();
  await app.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click();
}

function calls(page: Page, name: string): Promise<Call[]> {
  return page.evaluate((n) => ((window as unknown as { __calls: Call[] }).__calls).filter((c) => c.name === n), name);
}

/** 偽の host に、その tool を断らせる（null で戻す）。 */
function refuse(page: Page, tool: string, message: string | null): Promise<void> {
  return page.evaluate(([t, m]) => {
    const s = (window as unknown as { __state: { refuse?: Record<string, string | null> } }).__state;
    s.refuse = { ...(s.refuse || {}), [t as string]: m };
  }, [tool, message] as const);
}

/** 画面の中の入力欄・複数行の欄に、その文字列が残っていないか。 */
function valuesInDom(app: FrameLocator): Promise<string[]> {
  return app.locator("input, textarea").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).filter(Boolean));
}

test("グループを作る：移すの小窓——最後の選択肢で名前の欄と添え書きが出て、作ったグループが選ばれ、版はそのまま", async ({ page }) => {
  const app = await openHarness(page);
  await rowAction(app, "CF_TOKEN", "秘密を移動");
  await expect(app.locator("#dlg-move")).toBeVisible();
  await app.locator("#move-variant").selectOption("prod");
  await expect(app.locator("#move-newgroup"), "選ぶ前から名前の欄が出ている").toBeHidden();

  await app.locator("#move-group").selectOption("__new-group__");
  await expect(app.locator("#move-newgroup")).toBeVisible();
  await expect(app.locator("#move-newgroup-name")).toBeFocused();
  // Infisical が名乗った添え書き
  await expect(app.locator("#move-newgroup-note")).toHaveText("Infisical ではフォルダができます");
  // まだ行き先が無い——押させない、説明も出さない
  await expect(app.locator("#move-submit")).toBeDisabled();
  await expect(app.locator("#move-effect")).toHaveText("");

  // 名前が空なら、その小窓のエラー欄に言う
  await app.locator("#move-newgroup-create").click();
  await expect(app.locator("#move-error")).toHaveText("新しいグループの名前を入れてください");
  expect(await calls(page, "createGroup")).toEqual([]);

  // 作れなかったら、窓口の文言をそのまま小窓のエラー欄に出す（閉じない、作る欄も残る）
  await refuse(page, "createGroup", "グループ名に使えない文字があります: a/b");
  await app.locator("#move-newgroup-name").fill("a/b");
  await app.locator("#move-newgroup-create").click();
  await expect(app.locator("#move-error")).toHaveText("グループ名に使えない文字があります: a/b");
  await expect(app.locator("#dlg-move")).toBeVisible();
  await expect(app.locator("#move-group")).toHaveValue("__new-group__");
  await refuse(page, "createGroup", null);

  await app.locator("#move-newgroup-name").fill("cloudflare");
  await app.locator("#move-newgroup-create").click();
  await expect(app.locator("#move-error")).toBeHidden();
  expect((await calls(page, "createGroup")).at(-1)!.args).toEqual({ implementation: "vault-infisical", name: "cloudflare" });
  // 作ったグループを選んだ状態に。名前の欄は閉じる。版の欄は独立のまま（prod のまま）
  await expect(app.locator("#move-group")).toHaveValue("cloudflare");
  await expect(app.locator("#move-newgroup")).toBeHidden();
  await expect(app.locator("#move-variant")).toHaveValue("prod");
  await expect(app.locator('#move-group option[value="cloudflare"]')).toHaveText("cloudflare");
  await expect(app.locator("#move-group option").last(), "作る入口が最後に無い").toHaveText("＋ 新しいグループを作る…");
  await expect(app.locator("#move-effect")).toContainText("環境 prod の cloudflare はどの Project にも紐付いていないので");
  await expect(app.locator("#move-submit")).toBeEnabled();
  await app.locator("#move-submit").click();
  await expect(app.locator("#dlg-move"), "移せずに小窓が開いたまま").toBeHidden();
  expect((await calls(page, "migrateAlias")).at(-1)!.args).toMatchObject({ toImplementation: "vault-infisical", toGroup: "cloudflare@prod" });

  // 添え書きを名乗らない Vault（vault-local）では出さない
  await rowAction(app, "CF_TOKEN", "秘密を移動");
  await app.locator("#move-vault").selectOption("vault-local");
  await app.locator("#move-group").selectOption("__new-group__");
  await expect(app.locator("#move-newgroup")).toBeVisible();
  await expect(app.locator("#move-newgroup-note")).toBeHidden();
  // Enter で作る（小窓の送信に流れない）
  await app.locator("#move-newgroup-name").fill("local-b");
  await app.locator("#move-newgroup-name").press("Enter");
  await expect(app.locator("#move-group")).toHaveValue("local-b");
  await expect(app.locator("#dlg-move")).toBeVisible();
  expect((await calls(page, "createGroup")).at(-1)!.args).toEqual({ implementation: "vault-local", name: "local-b" });
});

test("グループを作る：参照を作る・置き場の変更の小窓にも同じ入口があり、作ったグループで押せる", async ({ page }) => {
  const app = await openHarness(page);
  // 参照を作る（Vault は元と同じに固定）
  await rowAction(app, "CF_TOKEN", "参照を作る");
  await expect(app.locator("#dlg-link")).toBeVisible();
  await app.locator("#link-group").selectOption("__new-group__");
  await expect(app.locator("#link-newgroup-note")).toHaveText("Infisical ではフォルダができます");
  await expect(app.locator("#link-submit")).toBeDisabled();
  await app.locator("#link-newgroup-name").fill("shared-tools");
  await app.locator("#link-newgroup-create").click();
  await expect(app.locator("#link-group")).toHaveValue("shared-tools");
  await expect(app.locator("#link-newgroup")).toBeHidden();
  // 版はこの Project の置き場の版（prod）のまま
  await expect(app.locator("#link-variant")).toHaveValue("prod");
  await expect(app.locator("#link-submit")).toBeEnabled();
  await app.locator("#link-submit").click();
  await expect(app.locator("#dlg-link")).toBeHidden();
  expect((await calls(page, "linkAlias")).at(-1)!.args).toMatchObject({ toGroup: "shared-tools@prod", toName: "CF_TOKEN" });

  // 置き場の変更
  await app.locator("#open-place").click();
  await expect(app.locator("#dlg-place")).toBeVisible();
  await expect(app.locator("#place-group")).toHaveValue("homelab");
  await app.locator("#place-group").selectOption("__new-group__");
  await expect(app.locator("#place-newgroup")).toBeVisible();
  await expect(app.locator("#place-newgroup-note")).toHaveText("Infisical ではフォルダができます");
  await expect(app.locator("#place-submit"), "グループを作っている途中なのに押せる").toBeDisabled();
  const plansBefore = (await calls(page, "planProjectPlacement")).length;
  await app.locator("#place-newgroup-name").fill("banto-dev");
  await app.locator("#place-newgroup-create").click();
  await expect(app.locator("#place-group")).toHaveValue("banto-dev");
  await expect(app.locator("#place-newgroup")).toBeHidden();
  // 作ったグループで見積もり直す
  await expect.poll(async () => (await calls(page, "planProjectPlacement")).length).toBeGreaterThan(plansBefore);
  expect((await calls(page, "planProjectPlacement")).at(-1)!.args).toMatchObject({ implementation: "vault-infisical", group: "banto-dev" });
  await expect(app.locator("#place-submit")).toBeEnabled();
  await app.locator("#place-submit").click();
  await expect(app.locator("#dlg-place")).toBeHidden();
  expect((await calls(page, "setProjectPlacement")).at(-1)!.args).toMatchObject({ implementation: "vault-infisical", group: "banto-dev", migrate: false });
});

test("値を変える：secret は1行の欄で置き換え、閉じたら値は DOM に残らない。行に値を変えた日時が出る", async ({ page }) => {
  const app = await openHarness(page);
  // 行のメニューの並び：用途の次
  await row(app, "CF_TOKEN").getByRole("button", { name: /の操作$/ }).click();
  expect(await app.getByRole("menu").getByRole("menuitem").allInnerTexts()).toEqual([
    "用途を編集", "値を変える", "秘密を移動", "参照を作る", "削除",
  ]);
  await app.getByRole("menu").getByRole("menuitem").first().press("Escape");
  // まだ変えていない行には日時を出さない
  await expect(row(app, "CF_TOKEN").locator(".updated-line")).toHaveCount(0);

  await rowAction(app, "CF_TOKEN", "値を変える");
  await expect(app.locator("#dlg-value")).toBeVisible();
  await expect(app.locator("#value-target")).toHaveText("vault-infisical / tools / CF_TOKEN");
  await expect(app.locator("#value-label")).toHaveText("新しい値");
  await expect(app.locator("#value-input")).toBeVisible();
  await expect(app.locator("#value-input")).toHaveAttribute("type", "password");
  await expect(app.locator("#value-multiline")).toBeHidden();
  await expect(app.locator("#value-source-field"), "SSH 鍵でないのに作り方を聞いている").toBeHidden();
  await expect(app.locator("#value-ssh-warn")).toBeHidden();
  await expect(app.locator("#value-effect")).toHaveText("これを使うコマンドは、次から新しい値で動きます。前の値は残りません");

  // 空のまま押したら言う（窓口を呼ばない）
  await app.locator("#value-submit").click();
  await expect(app.locator("#value-error")).toHaveText("新しい値を入力してください");
  expect(await calls(page, "replaceSecretValue")).toEqual([]);

  // やめたら、打ったものは DOM から消える
  await app.locator("#value-input").fill("TYPED-THEN-CANCELLED");
  await app.locator("#value-cancel").click();
  await expect(app.locator("#dlg-value")).toBeHidden();
  expect(await valuesInDom(app)).not.toContain("TYPED-THEN-CANCELLED");

  await rowAction(app, "CF_TOKEN", "値を変える");
  await expect(app.locator("#value-input")).toHaveValue("");
  await expect(app.locator("#value-error")).toBeHidden();
  await app.locator("#value-input").fill("NEW-SECRET-VALUE");
  await app.locator("#value-submit").click();
  await expect(app.locator("#dlg-value"), "置き換えられずに小窓が開いたまま").toBeHidden();
  expect((await calls(page, "replaceSecretValue")).map((c) => c.args)).toEqual([
    { implementation: "vault-infisical", name: "CF_TOKEN", group: "tools", value: "NEW-SECRET-VALUE" },
  ]);
  expect(await valuesInDom(app)).not.toContain("NEW-SECRET-VALUE");
  // 一覧を読み直すと、値を変えた日時が名前の下に出る（偽の host は 2026-10-07T05:04Z を返す）
  const updated = row(app, "CF_TOKEN").locator(".updated-line");
  const expected = await page.evaluate(() =>
    "値を変更 " + new Date("2026-10-07T05:04:00.000Z").toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
  );
  await expect(updated).toHaveText(expected);
  expect(expected).toMatch(/^値を変更 2026\/10\/07 \d\d:04$/);
  // 他の行には出ない
  await expect(row(app, "deploy").locator(".updated-line")).toHaveCount(0);

  // 失敗したら小窓のエラー欄に出して閉じない
  await refuse(page, "replaceSecretValue", "tools/CF_TOKEN を書けませんでした");
  await rowAction(app, "CF_TOKEN", "値を変える");
  await app.locator("#value-input").fill("x");
  await app.locator("#value-submit").click();
  await expect(app.locator("#value-error")).toHaveText("tools/CF_TOKEN を書けませんでした");
  await expect(app.locator("#dlg-value")).toBeVisible();
});

test("値を変える：ファイルは複数行、空の秘密は「いまは空」と言う", async ({ page }) => {
  const app = await openHarness(page);
  await rowAction(app, "conf", "値を変える");
  await expect(app.locator("#value-label")).toHaveText("新しいファイルの中身");
  await expect(app.locator("#value-multiline")).toBeVisible();
  await expect(app.locator("#value-input")).toBeHidden();
  await app.locator("#value-multiline").fill("a=2\nb=3\n");
  await app.locator("#value-submit").click();
  await expect(app.locator("#dlg-value")).toBeHidden();
  expect((await calls(page, "replaceSecretValue")).at(-1)!.args).toEqual({ implementation: "vault-infisical", name: "conf", group: "tools", value: "a=2\nb=3\n" });
  expect(await valuesInDom(app)).not.toContain("a=2\nb=3\n");

  await rowAction(app, "EMPTY", "値を変える");
  await expect(app.locator("#value-effect")).toHaveText(
    "いまは空です。値を入れると使えるようになります。これを使うコマンドは、次から新しい値で動きます。前の値は残りません",
  );
});

test("値を変える：SSH 鍵は注意を出し、貼る／作り直すを選べて、作り直すと新しい公開鍵が出る", async ({ page }) => {
  const app = await openHarness(page);
  await rowAction(app, "deploy", "値を変える");
  await expect(app.locator("#value-source-field")).toBeVisible();
  await expect(app.locator("#value-ssh-warn")).toContainText("相手（GitHub など）に登録した公開鍵と合わなくなります");
  // 貼る：秘密鍵は複数行
  await expect(app.locator("#value-source")).toHaveValue("typed");
  await expect(app.locator("#value-label")).toHaveText("新しい秘密鍵（-----BEGIN OPENSSH PRIVATE KEY----- から）");
  await expect(app.locator("#value-multiline")).toBeVisible();
  await app.locator("#value-multiline").fill("-----BEGIN OPENSSH PRIVATE KEY-----\npasted\n");
  // 作り直す：値の欄は消える（貼りかけの値は送らない）
  await app.locator("#value-source").selectOption("generated");
  await expect(app.locator("#value-input-field")).toBeHidden();
  await expect(app.locator("#value-effect")).toHaveText("Vault の中で新しい鍵ペアを作り、いまの鍵と入れ替えます。終わったら新しい公開鍵が出ます");
  await app.locator("#value-submit").click();
  await expect(app.locator("#dlg-value")).toBeHidden();
  expect((await calls(page, "replaceSecretValue")).at(-1)!.args).toEqual({ implementation: "vault-infisical", name: "deploy", group: "tools", regenerate: true });
  expect(await valuesInDom(app)).not.toContain("-----BEGIN OPENSSH PRIVATE KEY-----\npasted\n");
  // 新しい公開鍵を出してコピーできる
  await expect(app.locator("#dlg-pubkey")).toBeVisible();
  await expect(app.locator("#pubkey-title")).toHaveText("新しい公開鍵：deploy");
  await expect(app.locator("#pubkey-text")).toHaveValue("ssh-ed25519 AAAANEWKEY");
  await app.locator("#pubkey-copy").click();
  await expect(app.locator("#pubkey-copied")).toHaveText(/コピーしました|コピーできませんでした/);
  await app.getByRole("button", { name: "閉じる", exact: true }).click();

  // 貼る道：貼った秘密鍵を送る
  await rowAction(app, "deploy", "値を変える");
  await expect(app.locator("#value-source"), "開き直したら貼る道に戻っていない").toHaveValue("typed");
  await app.locator("#value-multiline").fill("-----BEGIN OPENSSH PRIVATE KEY-----\nmine\n");
  await app.locator("#value-submit").click();
  await expect(app.locator("#dlg-pubkey")).toBeVisible();
  expect((await calls(page, "replaceSecretValue")).at(-1)!.args).toEqual({
    implementation: "vault-infisical", name: "deploy", group: "tools", value: "-----BEGIN OPENSSH PRIVATE KEY-----\nmine\n",
  });
});

test("値を変える：参照とログイン情報（OAuth）の行では入力欄を出さず、理由と元の場所を言う", async ({ page }) => {
  const app = await openHarness(page);
  await rowAction(app, "CF_REF", "値を変える");
  await expect(app.locator("#dlg-value")).toBeVisible();
  await expect(app.locator("#value-refuse")).toHaveText(
    "参照なので、ここでは値を変えられません。値は元の場所（vault-infisical/tools/CF_TOKEN）で変えてください",
  );
  await expect(app.locator("#value-form")).toBeHidden();
  await expect(app.locator("#value-submit")).toBeHidden();
  await expect(app.locator("#value-cancel")).toHaveText("閉じる");
  await app.locator("#value-cancel").click();
  await expect(app.locator("#dlg-value")).toBeHidden();

  await rowAction(app, "gh-login", "値を変える");
  await expect(app.locator("#value-refuse")).toHaveText(
    "banto が置くログイン情報（OAuth）は、手では変えられません——置いた Module からログインし直すと置き換わります",
  );
  await expect(app.locator("#value-form")).toBeHidden();
  await expect(app.locator("#value-submit")).toBeHidden();
  await app.locator("#value-cancel").click();

  // 変えられる行を開き直したら、入力欄と「値を変える」が戻る
  await rowAction(app, "CF_TOKEN", "値を変える");
  await expect(app.locator("#value-refuse")).toBeHidden();
  await expect(app.locator("#value-form")).toBeVisible();
  await expect(app.locator("#value-submit")).toBeVisible();
  await expect(app.locator("#value-cancel")).toHaveText("やめる");
  expect(await calls(page, "replaceSecretValue")).toEqual([]);
});
