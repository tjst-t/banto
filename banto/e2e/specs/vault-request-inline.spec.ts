// **AI が秘密を求めたら、会話の中に入力欄が出る**（決定・2026-09-12、ユーザー提案）。
//
// 元は Elicitation で「設定画面の Vault から登録してください」と頼んでいたが、
//   1. 人を会話の外へ追い出していた
//   2. banto は Elicitation の応答を解決しない設計（アーキ仕様 §2.4.1 の帰結1）
//      なので、**人が答えても Module には届かず**、呼び出し側は60秒待つだけだった
//
// 見るのは4つ。**「カードが出た」で終わらせない**（規則14）：
//   1. AI が `requestAlias` を呼ぶと、会話の中に**本物の入力欄**が出る
//   2. そこに打った値が**実 Vault に届く**
//   3. **値は AI の文脈にもページにも出ない**
//   4. 登録後、AI は名前だけを `vault://aliases` で見つけられる
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Vault Request Inline";
const ALIAS = `e2e-inline-${Date.now()}`;
/** 「AI に渡ってしまったら分かる」一意な値。**出ないこと**を確かめるために使う。 */
const SECRET = `TYPED-BY-HUMAN-${Date.now()}`;

test("AI が秘密を求めると、会話の中の入力欄から人が登録できる（値は AI を通らない）", async ({
  page,
}) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-inline-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const composer = page.getByPlaceholder(/に送る/);
  // **どの Vault に頼むかは指定しない。** いま `vault` 役割の実装は2本あり
  // （`vault` と `vault-infisical`、2026-09-12）、**AI はどちらを選ぶ材料を
  // 持っていない**——実際、走らせるたびに選ぶ先が変わる。これは窓口
  // （`vault-directory`）が要ることの実物であって、試験で隠すものではない。
  // ここで見たいのは「どちらであれ、入力欄が出て、実 Vault に届くか」。
  await composer.fill(
    `requestAlias を、name に "${ALIAS}"、kind に "secret"、` +
      `hint に "E2E の確認用" を渡して1回だけ呼んでください。説明は要りません。`,
  );
  await composer.press("Enter");

  // ---- 1. 会話の中に本物の入力欄が出る --------------------------------------
  const frame = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(
    frame.getByText(`秘密を登録：${ALIAS}`),
    "requestAlias を呼んでも会話の中に入力欄が出ない",
  ).toBeVisible({ timeout: 180_000 });
  // **何を求められているか**が、答える前に見えている
  await expect(frame.getByText(/E2E の確認用/)).toBeVisible();

  // ---- 2. 打った値が実 Vault に届く -----------------------------------------
  await frame.locator("#value").fill(SECRET);
  await frame.locator("#scope").selectOption({ label: PROJECT_NAME });
  await frame.getByRole("button", { name: "登録する" }).click();
  await expect(
    frame.getByText(new RegExp(`「${ALIAS}」を登録しました`)),
    "登録できたと画面が言っていない",
  ).toBeVisible({ timeout: 120_000 });

  // **どちらの backend に入ったかは問わない**——VaultUI の横断一覧で確かめる
  const listed = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "listAliases", arguments: {} },
  });
  const body = await listed.text();
  expect(body, "画面は登録したと言ったのに、実 Vault に入っていない").toContain(ALIAS);
  expect(body, "Vault の一覧に値が入っている").not.toContain(SECRET);

  // ---- 3. 値は、会話にもページにも出ない ------------------------------------
  expect(await page.content(), "人が打った値がページに出ている").not.toContain(SECRET);

  // ---- 4. AI は名前だけを見つけられる ---------------------------------------
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({ timeout: 180_000 });
  // **目録も2つに割れている**（`vault` と `vault-infisical` がそれぞれ
  // `vault://aliases` を持つ）。片方だけ読むと見つからないので、ここでは
  // 「全部読んで」と明示する——**これも窓口が要ることの実物**
  await composer.fill(
    "繋がっている vault の resource `vault://aliases` を**全部**読んで、" +
      "登録されている alias の名前だけを挙げてください。",
  );
  await composer.press("Enter");
  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: ALIAS }),
    "登録した alias を AI が見つけられない",
  ).toBeVisible({ timeout: 180_000 });
  expect(await page.content(), "AI の返答に値が混ざっている").not.toContain(SECRET);

  // 後片づけ——このホストは他の spec と共有している。**どちらに入ったか
  // 分からない**ので、横断一覧から実装名を引いてから消す
  const where = JSON.parse(
    JSON.parse(body).content[0].text,
  ) as { aliases: Array<{ name: string; implementation: string }> };
  const impl = where.aliases.find((a) => a.name === ALIAS)?.implementation;
  if (impl) {
    await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      data: { server: "vault-directory", tool: "deleteAlias", arguments: { implementation: impl, name: ALIAS } },
    });
  }

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
