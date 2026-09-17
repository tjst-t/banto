// **banto 全体の Module を、人が画面から触れる**（追加・2026-09-15、§10 item 14 (a)）。
//
// 見るのは規則13・規則14 の意味で「繋がっていること」：
//   1. 画面が**本物の宣言**を見ている（同梱5本が役割ごとに出る）
//   2. **止めると、押す前に何が断るかが出る**（§6.1）
//   3. 止めた結果が**実 host に届く**（画面の自己申告を信じない・規則1）
//   4. **外から足した Module は消せる／同梱は消せない**
//   5. **「この Project のフォルダ」を渡したかで、どこに立つかが変わる**——聞かない
import { test, expect } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const ADDED = `e2e-weather-${Date.now()}`;

async function openModuleSettings(page: import("@playwright/test").Page) {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "役割と Module" }).click();
  await expect(page.getByTestId("instance-modules"), "Module の一覧が出ない").toBeVisible({
    timeout: 60_000,
  });
}

test("画面が本物の宣言を見ている——同梱が役割ごとに出る", async ({ page }) => {
  await openModuleSettings(page);
  // **実 host の宣言と突き合わせる**（画面の自己申告を信じない）
  const real = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string; origin: string }>;
  expect(real.length, "host が宣言を返していない").toBeGreaterThanOrEqual(5);

  for (const m of real) {
    await expect(page.locator(`[data-module="${m.name}"]`), `${m.name} が画面に出ていない`).toBeVisible();
  }
  // 同梱と外からを見分けられる
  await expect(page.locator('[data-module="vault-local"]')).toContainText("同梱");
  // どこに立つかが出ている
  await expect(page.locator('[data-module="shell"]')).toContainText("Project ごと");
  await expect(page.locator('[data-module="vault-directory"]')).toContainText("全体で1本");
});

test("止めるときは、押す前に何が断るかが出る——止めた結果は実 host に届く", async ({ page }) => {
  await openModuleSettings(page);

  await page.locator('[data-module="vault-directory"]').getByRole("switch").click();
  // **依存している Module の名前が、押す前に出る**（§6.1・規則2）
  await expect(page.getByText("vault-directory を止めますか")).toBeVisible();
  await expect(page.getByRole("alertdialog"), "何が断るようになるか出ていない").toContainText("shell");
  await page.getByRole("button", { name: "やめる" }).click();

  // 依存が無いものは、そう言う
  await page.locator('[data-module="filesystem"]').getByRole("switch").click();
  await expect(page.getByRole("alertdialog")).toContainText("依存している Module はありません");
  await page.getByRole("button", { name: "止める" }).click();

  // **画面が言うだけでなく、host に届いている**
  await expect
    .poll(
      async () => {
        const list = (await (
          await page.request.get(`${CORE_BASE_URL}/api/modules`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json()) as Array<{ name: string; enabled: boolean }>;
        return list.find((m) => m.name === "filesystem")?.enabled;
      },
      { timeout: 30_000, message: "止めたのに host に届いていない" },
    )
    .toBe(false);

  // **止めても一覧に残る**——消えたのか止めたのか分かる
  await expect(page.locator('[data-module="filesystem"]')).toBeVisible();
  await expect(page.getByTestId("module-state-filesystem")).toContainText("止めてあります");

  // 戻す（次の試験と実機を汚さない）
  await page.locator('[data-module="filesystem"]').getByRole("switch").click();
  await expect(page.getByTestId("module-state-filesystem")).not.toContainText("止めてあります", {
    timeout: 30_000,
  });
});

test("外から Module を足せる——どこに立つかは書いたもので決まり、同梱は消せない", async ({ page }) => {
  await openModuleSettings(page);

  await page.getByRole("button", { name: "Module を追加" }).click();

  // **既定は「貼り付ける」**（改訂・2026-09-16、ユーザー指摘「普通の人には
  // 使いづらい」）。人は README や Claude Code の設定から持ってくる
  await page.getByLabel("設定（JSON）").fill(
    JSON.stringify({
      mcpServers: { [ADDED]: { command: "/bin/sh", args: ["-c", "true"] } },
    }),
  );
  await expect(page.getByTestId("add-module-effect")).toContainText("banto 全体で1本");
  await page.getByRole("button", { name: "追加する" }).click();

  const row = page.locator(`[data-module="${ADDED}"]`);
  await expect(row, "足したのに一覧に出ない").toBeVisible({ timeout: 30_000 });
  await expect(row, "外から足したのに同梱扱い").toContainText("外から");
  // **外から繋ぐコードは必ず閉じ込める**
  await expect(row, "閉じ込めが掛かっていない").toContainText("閉じ込め");

  // **同梱には消すボタンが出ない**
  await expect(
    page.locator('[data-module="vault-local"]').getByRole("button", { name: /を消す/ }),
    "同梱に消すボタンが出ている",
  ).toHaveCount(0);

  // 外から足したものは消せる。**データは消さないと言ってから消す**
  await row.getByRole("button", { name: `${ADDED} を消す` }).click();
  await expect(page.getByRole("alertdialog")).toContainText("金庫に預けた秘密は消しません");
  await page.getByRole("button", { name: "消す" }).click();
  // **成功したときにだけ起きること**を待つ（規則14——押した直後に
  // 「エラーが出ていないこと」を見ても何も見ていない）。
  // 失敗しているなら、その理由をそのまま出す
  const gone = row.waitFor({ state: "detached", timeout: 30_000 }).then(() => "消えた");
  const failed = page
    .getByTestId("instance-modules-error")
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(async () => `消せませんでした：${await page.getByTestId("instance-modules-error").innerText()}`);
  expect(await Promise.race([gone, failed])).toBe("消えた");
});


// **手で書く道も残っている**（二番手）。「この Project のフォルダ」を渡したかで
// どこに立つかが変わることは、押す前に出る——聞かない（決定・2026-09-15）
test("自分で書く道もあり、Project のフォルダを渡すと表示が変わる", async ({ page }) => {
  await openModuleSettings(page);
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByRole("tab", { name: "自分で書く" }).click();
  await page.getByLabel("コマンド").fill("npx");
  await page.getByLabel("引数（空白区切り）").fill("-y @modelcontextprotocol/server-weather");
  await expect(page.getByTestId("add-module-effect")).toContainText("banto 全体で1本");
  await page.getByRole("button", { name: "＋ この Project のフォルダを渡す" }).click();
  await expect(page.getByTestId("add-module-effect")).toContainText("Project ごとに1本");
  // **閉じ込めは外せない**と、どちらの場合も言う
  await expect(page.getByTestId("add-module-effect")).toContainText("必ず閉じ込めます");
});

// **手で書く道でも API キーを入れられる**（追加・2026-09-16）。既定は「金庫から」
// ——直書きは記録に残り続けるので、楽な道を安全なほうに置く
test("API キーは既定で金庫から引く——直接入力を選ぶと、記録に残ると言う", async ({ page }) => {
  const name = `e2e-secret-ui-${Date.now()}`;
  await openModuleSettings(page);
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByRole("tab", { name: "自分で書く" }).click();

  // 既定は金庫から
  await expect(page.getByTestId("add-module-secret-note")).toContainText("記録には名前だけ");
  // 直接入力に切り替えると、消せないことを言う
  await page.getByRole("tab", { name: "直接入力" }).click();
  await expect(page.getByTestId("add-module-secret-note")).toContainText("後から消せません");
  await page.getByRole("tab", { name: "金庫から" }).click();

  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.getByLabel("コマンド").fill("/bin/sh");
  await page.getByLabel("引数（空白区切り）").fill("-c true");
  await page.getByLabel("API キー（要るときだけ）").fill("WEATHER_API_KEY");
  await page.getByLabel("金庫に入れた名前").fill("weather-key");
  await page.getByRole("button", { name: "追加する" }).click();

  await expect(page.locator(`[data-module="${name}"]`), "足したのに一覧に出ない").toBeVisible({
    timeout: 30_000,
  });

  // **画面の言い分ではなく、保存された宣言を見る**（規則1）
  const exported = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules/export`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  expect(exported.mcpServers[name]?.env?.WEATHER_API_KEY, "金庫からの参照になっていない").toBe(
    "${secret:weather-key}",
  );

  // 片づける
  await page.request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
});

// **URL に繋ぐ形は、まだ受けられないとはっきり言う**（黙って無視しない・規則2）
test("URL に繋ぐ設定を貼ったら、理由を言って断る", async ({ page }) => {
  await openModuleSettings(page);
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByLabel("設定（JSON）").fill(
    JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } }),
  );
  await page.getByRole("button", { name: "追加する" }).click();
  await expect(page.getByTestId("add-module-error"), "断った理由が出ていない").toContainText(
    "URL に繋ぐ形",
  );
});

// **いまの設定を mcpServers の形で取り出せる**（他のクライアントへ持っていける）
test("設定を mcpServers の形で取り出せる", async ({ page }) => {
  await openApp(page);
  const res = await page.request.get(`${CORE_BASE_URL}/api/modules/export`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { mcpServers: Record<string, Record<string, unknown>> };
  const vault = body.mcpServers["vault-local"];
  expect(vault, "同梱が出ていない").toBeTruthy();
  // **他のクライアントが読める形**——中身はトップレベル
  expect(vault!.type).toBe("stdio");
  expect(typeof vault!.command).toBe("string");
  // **banto の追加は _meta に入る**（知らないクライアントは無視する）
  expect((vault!._meta as Record<string, unknown>)["dev.banto/module"]).toBeTruthy();
});
