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
const KEY_ALIAS = `e2e-sshkey-${Date.now()}`;
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
  // **「対象」ではなく「どこから使えるようにするか」**（改訂・2026-09-13）。
  // "instance" は内部語なので画面に出さない（規則11）
  await frame.locator("#scope").selectOption({ label: `この Project（${PROJECT_NAME}）だけ` });
  // 秘密（`kind: "secret"`）では、鍵専用の案内を出さない——種類で画面が変わる
  await expect(frame.locator("#ssh-note")).toBeHidden();
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

// **鍵ペアは「秘密」とは聞くことが違う**（回帰・2026-09-13、ユーザー報告）。
// 報告されたのは3つで、どれも別の原因だった：
//   1. 種類を変えても画面が変わらない（`.field { display: grid }` が
//      `[hidden]` を打ち消していて、**hidden が全部効いていなかった**）
//   2. 公開鍵の欄が出るのに**空**（1 のせいで、返っていなくても箱が見えていた）
//   3. 一覧に出る名前が**公開鍵の断片**（Infisical の台帳が alias 名を
//      「置き場から導ける」としていたが、鍵の置き場は backend が決める）
//
// ここでは 1 と 2——**画面が種類に応じて変わり、公開鍵が本当に出ること**を見る。
// 3 は `vault-infisical` の統合試験（本物の Infisical）で押さえている。
test("鍵ペアを頼まれた入力欄は、秘密のときと聞くことが違う——公開鍵まで出る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-sshkey-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, "E2E Vault Request Key", projectRoot);

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    `requestAlias を、name に "${KEY_ALIAS}"、kind に "ssh-identity"、` +
      `hint に "E2E の鍵の確認用" を渡して1回だけ呼んでください。説明は要りません。`,
  );
  await composer.press("Enter");

  const frame = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(frame.getByText(`秘密を登録：${KEY_ALIAS}`)).toBeVisible({ timeout: 180_000 });

  // ---- 1. 種類で聞くことが変わっている --------------------------------------
  // 貼る側：**秘密鍵は1行に入らない**ので複数行の欄が出る
  await expect(frame.locator("#value-multiline"), "秘密鍵を1行の欄で受けようとしている").toBeVisible();
  await expect(frame.locator("#value")).toBeHidden();
  await expect(frame.getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeVisible();

  // 作る側：**鍵の強さは鍵の種類が決める**ので「作る強さ」は出ない
  await frame.locator("#source").selectOption("generated");
  await expect(
    frame.locator("#generate-field"),
    "鍵ペアなのに「作る強さ（バイト数）」を聞いている",
  ).toBeHidden();
  await expect(frame.locator("#ssh-note")).toBeVisible();
  // 値を貼る欄も消える（Vault の中で作るので、人は値に触らない）
  await expect(frame.locator("#value-field")).toBeHidden();

  // ---- 2. 作ると、公開鍵が本当に出る ----------------------------------------
  await frame.getByRole("button", { name: "登録する" }).click();
  await expect(frame.getByText(new RegExp(`「${KEY_ALIAS}」を登録しました`))).toBeVisible({
    timeout: 120_000,
  });
  await expect(
    frame.locator("#pubkey-missing"),
    "公開鍵が返らなかったのに、画面がそう言っていない",
  ).toBeHidden();
  const pubkey = await frame.locator("#pubkey").inputValue();
  expect(pubkey, "公開鍵の欄が空のまま出ている").toMatch(/^ssh-ed25519 AAAA/);

  // ---- 3. 一覧には、付けた名前で出る（公開鍵に化けない） --------------------
  const listed = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "listAliases", arguments: {} },
  });
  const aliases = (
    JSON.parse(JSON.parse(await listed.text()).content[0].text) as {
      aliases: Array<{ name: string; kind: string; implementation: string }>;
    }
  ).aliases;
  const mine = aliases.find((a) => a.name === KEY_ALIAS);
  expect(mine, `一覧に「${KEY_ALIAS}」が無い（出ている名前: ${aliases.map((a) => a.name).join(", ")}）`).toBeTruthy();
  expect(mine!.kind).toBe("ssh-identity");
  // **秘密鍵はどこにも出ない**
  expect(await page.content(), "秘密鍵が画面に出ている").not.toContain("PRIVATE KEY-----\n");

  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      server: "vault-directory",
      tool: "deleteAlias",
      arguments: { implementation: mine!.implementation, name: KEY_ALIAS },
    },
  });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
