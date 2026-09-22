// **MCP Registry から Module を選ぶ**（追加・2026-09-21、ユーザー要望）。
//
// 見るのは3つ。**「タブが開いた」で終わらせない**（規則14——その画面が実際に
// 出している値まで一つずつ見る）：
//   1. **提供元が出しているものが先に出る**（ユーザー要望の本体）
//   2. **出所が札として出ている**——並び順だけに判断を預けない（規則13）
//   3. **押す前に、何が起きるかが出ている**（繋ぐのか・取ってくるのか・
//      その形式に対応しているのか）
//
// **registry は偽物**（`registry-fixture.ts`）。本物の一覧は毎日変わるので、
// 並び順の検査が外の都合で落ちる（規則6）。中身は 2026-09-21 に本物から写した。
import { test, expect } from "@playwright/test";
import { openApp } from "../helpers.js";
import { AUTH_TOKEN, CORE_BASE_URL, NPM_REGISTRY_BASE_URL } from "../config.js";

test.describe.configure({ mode: "serial" });
// 取得（npm）を含むので長め——**待ちを足しているのではなく、実際に取ってくる時間**
test.setTimeout(300_000);

async function openAddModule(page: import("@playwright/test").Page) {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  await expect(page.getByTestId("instance-modules"), "Module の一覧が出ない").toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Module を追加" }).click();
  // **registry は「カスタム」の中へ降ろした**（改訂・2026-09-22、ユーザー決定
  // 「あまりに玉石混交すぎて、そのままユーザに提示はつらい」）——主の面は
  // banto が選んだ目録で、registry は自分で探す人の道
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-registry").click();
}

/** 検索して、結果が出るまで待つ。**「提供元が先」は検索して初めて言える**（`rank.ts`）。 */
async function searchFor(page: import("@playwright/test").Page, q: string) {
  // **id で引く**——「検索」はサイドバーの Command Palette のボタンにも付いている
  await page.locator("#add-module-registry-search").fill(q);
  await expect(page.locator("[data-provenance]").first()).toBeVisible({ timeout: 30_000 });
}

// **人に見せる主の面は、banto が選んだ目録**（決定・2026-09-22、ユーザー）。
// registry をそのまま並べると、全 34,815 件のうち 67% が GitHub アカウント確認だけ、
// 23% は中身も読めない（実測、`curated.ts`）。**そこを人に選ばせない。**
test("おすすめの面：banto が選んだ目録が出て、なぜ載っているかが読める", async ({ page }) => {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  await expect(page.getByTestId("instance-modules")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Module を追加" }).click();

  // **既定で開くのは「おすすめ」**——registry ではない
  const curated = page.getByTestId("add-module-curated");
  await expect(curated, "おすすめの目録が出ていない").toBeVisible({ timeout: 30_000 });

  const stripe = page.getByTestId("add-module-curated-stripe");
  await expect(stripe, "目録に Stripe が無い").toBeVisible();
  // **なぜ載っているかを、そのまま出す**（規則2——根拠を隠さない）
  await expect(stripe, "載っている根拠が出ていない").toContainText("stripe.com の持ち主が公開");
  // **言えないことは言わない**——出所は確かめたが、コードは監査していない
  await expect(curated, "監査していないことを言っていない").toContainText("監査していません");

  // **registry は既定では出ていない**（奥へ降ろした）
  await expect(
    page.locator("#add-module-registry-search"),
    "registry の検索欄が、おすすめの面に出ている",
  ).toHaveCount(0);

  // **目録の1件は registry から引き直される**——目録は「registry のどれか」しか
  // 持っていない（起動の指定を写しで持つと、相手が版を上げたときに食い違う）。
  // **付く名前は `mcp` ではない**（実機で発覚・2026-09-22——`com.stripe/mcp` の
  // `/` の後ろをそのまま使って、Stripe の Module 名が `mcp` になっていた）
  await stripe.click();
  await expect(page.getByLabel("名前"), "Stripe の名前が「mcp」になっている").toHaveValue(
    "stripe",
    { timeout: 60_000 },
  );
  // URL に繋ぐ形なので、**どちらの面から選んでも承知を取る**
  await expect(
    page.getByTestId("add-module-egress-notice"),
    "目録から選んだ remote で、外へ出る承知が出ていない",
  ).toContainText("mcp.stripe.com");
});

// **検索するまで、それらしい一覧を出さない**（決定・2026-09-21、実データで測って変えた）。
// 空の検索で先頭を並べても、それは名前順の数千件の頭でしかなく、「提供元を優先」は
// 効かない（どの製品の話かが決まっていないため）。**効いていない並びを目録として
// 見せると、効いているように見える**（規則13）。
test("検索するまでは、一覧を出さずに検索を促す", async ({ page }) => {
  await openAddModule(page);
  await expect(
    page.getByTestId("add-module-registry-prompt"),
    "検索前なのに、それらしい一覧が出ている",
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-provenance]"), "検索前に一覧が出ている").toHaveCount(0);
});

test("MCP Registry のタブ：提供元が先に出て、出所と繋ぎ方が一件ずつ読める", async ({ page }) => {
  await openAddModule(page);
  await searchFor(page, "stripe");

  const rows = page.locator('[data-testid^="add-module-registry-"][data-provenance]');

  // ---- 1. 提供元が出しているものが先 ---------------------------------------
  // **`com.stripe` は stripe.com の持ち主が出している**＝この製品の提供元。
  // `io.github.*` は GitHub アカウントの確認だけ（偽 registry の中身も本物と同じ形）
  await expect(
    rows.first(),
    "提供元のものが先頭に出ていない（並び順が効いていない）",
  ).toHaveAttribute("data-testid", "add-module-registry-com.stripe/mcp");

  // **見出しが製品名になっている**（追加・2026-09-21、実ブラウザで発覚）。
  // `com.stripe/mcp` には `title` が無いので、`/` の後ろをそのまま出すと
  // **「mcp」という見出し**になる——人が最初に読むところなので、そこは製品名にする
  await expect(rows.first(), "見出しが「mcp」のままになっている").toContainText("stripe");

  // ---- 2. 出所は札で出る（並び順だけに預けない）-----------------------------
  await expect(rows.first()).toHaveAttribute("data-provenance", "vendor");
  await expect(rows.first(), "提供元の札が出ていない").toContainText("提供元");

  const individual = page.locator('[data-testid="add-module-registry-io.github.codespar/mcp-stripe"]');
  await expect(individual).toHaveAttribute("data-provenance", "github-account");
  await expect(individual, "個人のものが提供元のように見えている").toContainText("個人・GitHub");

  // ---- 3. 押す前に、何が起きるかが出ている ---------------------------------
  // remote は「こちらでは動かさない／外に出る」
  await expect(
    rows.first(),
    "remote なのに、どこへ繋ぐのか・外に出ることが書かれていない",
  ).toContainText("mcp.stripe.com に接続します");
  await expect(rows.first()).toContainText("会話の内容が外に出ます");

  // npm は「取ってきて、このサーバで動かす（閉じ込める）」
  await expect(individual, "取ってくる対象が出ていない").toContainText("mcp-stripe@1.0.0");
  await expect(individual, "閉じ込めることが書かれていない").toContainText("閉じ込めます");

  // **対応していない形式は、理由つきで出る**（黙って落とさない・規則2）。
  // 一覧から消すと、人には「そんなものは無い」に見える
  const python = page.locator('[data-testid="add-module-registry-io.github.CSOAI-ORG/stripe-billing-mcp"]');
  await expect(python, "対応していない形式が一覧から消えている").toBeVisible();
  await expect(python, "対応していない理由が出ていない").toContainText("uvx");

  // **押せるように見せない**（追加・2026-09-21、実機で発覚——対応していない
  // 形式でも押せてしまっていた。押せば host が断るが、**押せて見えること自体が誤り**）
  await python.click();
  await expect(
    page.getByTestId("add-module-registry-not-installable"),
    "入れられない理由が出ていない",
  ).toContainText("uvx");
  await expect(
    page.getByRole("button", { name: "追加", exact: true }),
    "入れられないのに押せてしまう",
  ).toBeDisabled();
});

test("選ぶと名前が決まり、繋ぐのに要るものが先に分かる", async ({ page }) => {
  await openAddModule(page);
  await searchFor(page, "secretful");
  const npmOne = page.locator('[data-testid="add-module-registry-io.github.someone/secretful"]');
  await expect(npmOne).toBeVisible({ timeout: 30_000 });
  await npmOne.click();

  // **逆 DNS をそのまま名前にしない**——`/` の後ろから作る
  await expect(page.getByLabel("名前"), "選んでも名前が入らない").toHaveValue("secretful");

  // **聞くのはその場で**（§6.1）——registry には値が無いので、ここで入れる
  const field = page.getByTestId("add-module-registry-input-STRIPE_API_KEY");
  await expect(field, "繋ぐのに要る欄が出ていない").toBeVisible();
  await expect(field, "必須だと分からない").toContainText("必須");
  // **registry が書いた説明をそのまま出す**（banto が言い換えない）
  await expect(field).toContainText("Stripe の秘密鍵");

  // **秘密は既定で Vault から**——直書きは宣言に残り、記録から消せない
  await expect(field, "秘密なのに Vault のことを言っていない").toContainText(
    "記録には名前だけが残ります",
  );

  // 直接入力に変えたら、**残り続けることを言う**（黙って受け取らない・規則2）
  // PillTabs は role="tab"——印で引く（既存の spec と同じ作法）
  await page.getByTestId("add-module-registry-source-STRIPE_API_KEY-plain").click();
  await expect(field, "直書きなのに、記録に残ることを言っていない").toContainText(
    "記録に残り続けます",
  );

  // **必須が空のうちは押せない**
  await expect(
    page.getByRole("button", { name: "追加", exact: true }),
    "必須が空でも押せてしまう",
  ).toBeDisabled();
});

test("検索すると、その語が registry まで届く", async ({ page }) => {
  await openAddModule(page);
  await searchFor(page, "stripe");

  await page.locator("#add-module-registry-search").fill("billing");
  // **成功したときにだけ現れるもの**を待つ（規則14——消えたことを見ても何も見ていない）
  await expect(
    page.locator('[data-testid="add-module-registry-io.github.CSOAI-ORG/stripe-billing-mcp"]'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="add-module-registry-com.stripe/mcp"]'),
    "絞り込んだのに、当たらないものが残っている",
  ).toHaveCount(0);
});

// **入れて、繋がるところまで**（追加・2026-09-21、ユーザー要望
// 「ローカルならインストールして、つなぐまで、一貫してできる手段が欲しい」）。
//
// **「一覧に出た」で終わらせない**（規則13）。見るのは、
//   1. host が**実際に取ってきた**（npm の配布物が置き場に入った）
//   2. **立って喋る**（AI が見る経路＝中継に tool が出る）
//   3. **人が入れた値が起動まで届いた**（受け取った側から確かめる・規則1）
//
// npm も registry も偽物（`npm-registry-fixture.ts`）——本物を叩くと外の都合で
// 落ちる試験になる（規則6）。配るのは**依存を持たない** MCP サーバ1本。
test("npm の Module を入れると、取ってきて立ち、AI から呼べる", async ({ page }) => {
  const GREETING = `e2e-greeting-${Date.now()}`;
  await openAddModule(page);
  await searchFor(page, "greeter");

  const row = page.locator('[data-testid="add-module-registry-com.banto-e2e/greeter"]');
  await expect(row, "偽 registry の1本が出ていない").toBeVisible({ timeout: 30_000 });
  await expect(row, "取ってくる対象が出ていない").toContainText("banto-e2e-mcp-module@1.2.3");
  await row.click();

  // 名前は `/` の後ろから決まる
  await expect(page.getByLabel("名前")).toHaveValue("greeter");

  // **必須の欄が空のうちは押せない**（規則2——空のまま起動しない）
  await expect(
    page.getByRole("button", { name: "追加", exact: true }),
    "必須が空でも押せてしまう",
  ).toBeDisabled();

  await page.locator("#add-module-registry-in-BANTO_E2E_GREETING").fill(GREETING);
  const add = page.getByRole("button", { name: "追加", exact: true });
  await expect(add).toBeEnabled();
  await add.click();

  // ---- 1. 一覧に出る（取得が終わって宣言が入った）--------------------------
  // **成功したときにだけ現れるもの**を待つ（規則14）
  const listRow = page.locator('[data-module="greeter"]');
  await expect(listRow, "入れたのに一覧に出ない").toBeVisible({ timeout: 180_000 });

  // ---- 2・3. 立って喋り、渡した値が届いている -----------------------------
  // **AI が見る経路そのもの**（中継）に聞く——画面の自己申告を信じない（規則1）
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
          headers,
          data: { server: "greeter", tool: "greet", arguments: { who: "banto" } },
        });
        if (!res.ok()) return `(まだ立っていない: ${res.status()})`;
        return await res.text();
      },
      { timeout: 180_000, message: "入れた Module が立って喋らない" },
    )
    .toContain(GREETING);

  // **後片づけ**——このホストは他の spec と共有している
  await page.request.delete(`${CORE_BASE_URL}/api/modules/greeter`, { headers });
});

// **`server.json` を貼って入れる**（追加・2026-09-22、ユーザー要望
// 「server.json を貼り付けてインストール、というパターンもできるといいね」）。
//
// **貼る場所は増やさない。** 人は自分が持っているものを貼るだけで、
// `mcpServers` か `server.json` かを**人に判定させない**——画面が見分ける。
// 読めた1件は **registry から選んだときと同じ部品**で描く（規則3）。
test("server.json を貼ると、そのまま取ってきて立ち、AI から呼べる", async ({ page }) => {
  const GREETING = `e2e-pasted-${Date.now()}`;
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  await expect(page.getByTestId("instance-modules")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-json").click();

  // **偽 registry が配っているのと同じものを、手で貼る**——同じ npm の配布物を
  // 指しているので、取得から接続まで本当に通ったかが確かめられる
  const serverJson = JSON.stringify({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "com.banto-e2e/pasted-greeter",
    description: "貼り付けで入れる、依存を持たない MCP サーバ",
    version: "1.2.3",
    packages: [
      {
        registryType: "npm",
        registryBaseUrl: NPM_REGISTRY_BASE_URL,
        identifier: "banto-e2e-mcp-module",
        version: "1.2.3",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "BANTO_E2E_GREETING", description: "答えに混ぜる言葉", isRequired: true },
        ],
      },
    ],
  });
  await page.getByLabel("設定（JSON）").fill(serverJson);

  // **`server.json` として読めたことを言う**（黙って別の形で処理しない・規則2）
  const read = page.getByTestId("add-module-serverjson");
  await expect(read, "server.json として読まれていない").toBeVisible({ timeout: 60_000 });
  await expect(read, "出所を確かめていないことを言っていない").toContainText("確かめていません");

  // **registry から選んだときと同じ部品**——名前も要る設定も同じ形で出る
  await expect(page.getByLabel("名前")).toHaveValue("pasted-greeter", { timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "追加", exact: true }),
    "必須が空でも押せてしまう",
  ).toBeDisabled();
  await page.locator("#add-module-registry-in-BANTO_E2E_GREETING").fill(GREETING);

  const add = page.getByRole("button", { name: "追加", exact: true });
  await expect(add).toBeEnabled();
  await add.click();

  await expect(
    page.locator('[data-module="pasted-greeter"]'),
    "貼って入れたのに一覧に出ない",
  ).toBeVisible({ timeout: 180_000 });

  // **立って喋り、渡した値が届いている**（受け取った側から確かめる・規則1）
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
          headers,
          data: { server: "pasted-greeter", tool: "greet", arguments: { who: "banto" } },
        });
        if (!res.ok()) return `(まだ立っていない: ${res.status()})`;
        return await res.text();
      },
      { timeout: 180_000, message: "貼って入れた Module が立って喋らない" },
    )
    .toContain(GREETING);

  await page.request.delete(`${CORE_BASE_URL}/api/modules/pasted-greeter`, { headers });
});

// **貼り間違いを、黙って別の形で処理しない**（規則2）
test("mcpServers を server.json のつもりで貼っても、今までどおり受ける", async ({ page }) => {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  await expect(page.getByTestId("instance-modules")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-json").click();

  await page.getByLabel("設定（JSON）").fill(
    JSON.stringify({ mcpServers: { "e2e-paste-plain": { command: "/bin/sh", args: ["-c", "true"] } } }),
  );
  // **`server.json` の面は出ない**——`mcpServers` は今までの道で処理する
  await expect(page.getByTestId("add-module-serverjson")).toHaveCount(0);
  await expect(page.getByTestId("add-module-serverjson-error")).toHaveCount(0);
  await expect(page.getByTestId("add-module-effect"), "今までの説明が消えている").toBeVisible();
  await expect(page.getByRole("button", { name: "追加", exact: true })).toBeEnabled();
});

// **読めない理由は、人が読む言葉で出す**（改訂・2026-09-22、実機で発覚——
// `banto host /api/… が 400 を返しました: {"error":"…"}` と内部がそのまま出ていた）
test("読めない server.json は、直せる言葉で断る", async ({ page }) => {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  await expect(page.getByTestId("instance-modules")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-json").click();

  await page
    .getByLabel("設定（JSON）")
    .fill('{"name":"com.example/x","version":"1.0.0","description":"繋ぎ方が無い"}');

  const err = page.getByTestId("add-module-serverjson-error");
  await expect(err, "読めない理由が出ていない").toBeVisible({ timeout: 30_000 });
  await expect(err, "何が足りないかを言っていない").toContainText("繋ぎ方が書かれていません");
  // **口の名前と状態番号を人に見せない**——人が直せるのは JSON の中身のほう
  await expect(err, "内部の経路が画面に出ている").not.toContainText("/api/");
  await expect(err, "状態番号が画面に出ている").not.toContainText("400");
});
