// **banto 全体の Module を、人が画面から触れる**（追加・2026-09-15、§10 item 14 (a)）。
//
// 見るのは規則13・規則14 の意味で「繋がっていること」：
//   1. 画面が**本物の宣言**を見ている（既定4本が役割ごとに出る）
//   2. **止めると、保存する前に何が断るかが出る**（§6.1。改訂・2026-09-19
//      ——押した瞬間ではなく、行の中と保存の差分で出る）
//   3. 止めた結果が**実 host に届く**（画面の自己申告を信じない・規則1）
//   4. **外から足した Module は消せる／同梱は消せない**
//   5. **「この Project のフォルダ」を渡したかで、どこに立つかが変わる**——聞かない
import { test, expect } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { installInfisical, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const ADDED = `e2e-weather-${Date.now()}`;

async function openModuleSettings(page: import("@playwright/test").Page) {
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  await expect(page.getByTestId("instance-modules"), "Module の一覧が出ない").toBeVisible({
    timeout: 60_000,
  });
}

test("画面が本物の宣言を見ている——既定が役割ごとに出る", async ({ page }) => {
  await openModuleSettings(page);
  // **実 host の宣言と突き合わせる**（画面の自己申告を信じない）
  const real = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string; origin: string }>;
  expect(real.length, "host が宣言を返していない").toBeGreaterThanOrEqual(4);

  for (const m of real) {
    await expect(page.locator(`[data-module="${m.name}"]`), `${m.name} が画面に出ていない`).toBeVisible();
  }
  // 同梱と外からを見分けられる（同梱には「外から」が付かない）
  await expect(page.locator('[data-module="vault-local"]')).not.toContainText("ユーザー追加");
  // どこに立つかが出ている（表の「動く場所」列・2026-09-18 から）
  await expect(page.locator('[data-module="shell"]')).toContainText("Project ごと");
  await expect(page.locator('[data-module="vault-directory"]')).toContainText("Global");
  // どこで動くか（「サンドボックス」列、2026-09-25 から置き場所を出す）：同梱の全体の Module は banto 本体、
  // Project の Module はその Project のコンテナ
  await expect(page.locator('[data-module="vault-directory"]').locator("td").nth(3)).toHaveText("banto 本体");
  await expect(page.locator('[data-module="shell"]').locator("td").nth(3)).toHaveText("Project のコンテナ");
});

test("止めるのはまとめて——保存の前に何が断るかが出て、保存すると実 host に届く", async ({ page }) => {
  // **押すたびに効かない**（改訂・2026-09-19、ユーザー要望）。Project の面と
  // 同じで、下書きを作って最後に保存する。だから見るのは3つ：
  //   (a) 押しても host にはまだ届いていない
  //   (b) **止めると何が断るか**が、保存の前に出る
  //   (c) 保存して初めて host に届く
  await openModuleSettings(page);

  const enabledOf = async (name: string) => {
    const list = (await (
      await page.request.get(`${CORE_BASE_URL}/api/modules`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      })
    ).json()) as Array<{ name: string; enabled: boolean }>;
    return list.find((m) => m.name === name)?.enabled;
  };

  // ---- **役割で見る**（追加・2026-09-19、ユーザー報告の誤報の回帰） ---------
  // `vault` の実装を2本にする（Infisical は既定に入っていない・2026-09-20）
  await installInfisical(page);
  await page.reload();
  await expect(page.locator('[data-module="vault-infisical"]')).toBeVisible({ timeout: 30_000 });
  // **1本無効にしても役割は満たされたまま**なので、
  // 警告は出ないのが正しい——出るなら、名前で見ていることになる
  await page.locator('[data-module="vault-local"]').getByRole("switch").click();
  await expect(
    page.getByTestId("module-state-vault-local"),
    "実装がもう1本あるのに「使えなくなります」と言っている（名前で見ている）",
  ).not.toContainText("使えなくなります");
  // **役割を満たすものが全部消えて初めて**言う
  await page.locator('[data-module="vault-infisical"]').getByRole("switch").click();
  await expect(
    page.getByTestId("module-state-vault-local"),
    "最後の1本まで無効にしたのに、何も言わない",
  ).toContainText("shell");
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByTestId("module-draft-bar")).toHaveCount(0);

  // ---- (b) 依存しているものの名前が、その場で行に出る -----------------------
  // `vault-directory` は1本しか無いので、無効にすれば必ず出る
  await page.locator('[data-module="vault-directory"]').getByRole("switch").click();
  await expect(
    page.getByTestId("module-state-vault-directory"),
    "止めると何が断るのか、行に出ていない",
  ).toContainText("shell");
  // **押した瞬間に確認は出ない**（確認は保存のとき1回）
  await expect(page.locator('[role="alertdialog"]'), "押した瞬間に確認が出ている").toHaveCount(0);

  // ---- (a) 押しただけでは host に届いていない ------------------------------
  expect(await enabledOf("vault-directory"), "押しただけで host に届いている").toBe(true);

  // 捨てると元どおり（覚えていない）
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByTestId("module-draft-bar")).toHaveCount(0);

  // ---- 依存が無いものを止めて、保存する ------------------------------------
  await page.locator('[data-module="filesystem"]').getByRole("switch").click();
  await expect(page.getByTestId("module-draft-bar")).toContainText("未保存の変更 1 件");
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "保存", exact: true }).click();

  const dialog = page.getByTestId("module-save-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText("filesystem");
  await expect(dialog, "依存が無いことを言っていない").toContainText("依存している Module はありません");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();

  // ---- (c) **画面が言うだけでなく、host に届いている** ----------------------
  await expect
    .poll(async () => enabledOf("filesystem"), {
      timeout: 30_000,
      message: "保存したのに host に届いていない",
    })
    .toBe(false);

  // **止めても一覧に残る**——消えたのか止めたのか分かる
  await expect(page.locator('[data-module="filesystem"]')).toBeVisible();
  await expect(page.getByTestId("module-state-filesystem")).toContainText("Stopped");

  // 戻す（次の試験と実機を汚さない）
  await page.locator('[data-module="filesystem"]').getByRole("switch").click();
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "保存", exact: true }).click();
  await page.getByTestId("module-save-dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("module-state-filesystem")).not.toContainText("Stopped", {
    timeout: 30_000,
  });
});

// **止めても消えない——外から足したものも**（追加・2026-09-19、ユーザー報告）。
// 実際に踏んだ：一覧を組み立てるとき、止めたものを**同梱の既定からしか**復元して
// いなかったので、**外から足した Module は止めた瞬間に一覧から消えていた**
// ——止めたのに消えたように見えるうえ、消えて見えるので**もう動かせない**。
test("外から足した Module を止めても、消えずに一覧へ残り、また動かせる", async ({ page }) => {
  const name = `e2e-disable-keep-${Date.now()}`;
  await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { mcpServers: { [name]: { command: "/bin/sh", args: ["-c", "true"] } } },
  });
  await openModuleSettings(page);

  const row = page.locator(`[data-module="${name}"]`);
  await expect(row, "足したのに一覧に出ない").toBeVisible({ timeout: 30_000 });

  // ---- 止める ------------------------------------------------------------
  await row.getByRole("switch").click();
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "保存", exact: true }).click();
  await page.getByTestId("module-save-dialog").getByRole("button", { name: "保存", exact: true }).click();

  // **消えない**——止めたと分かる形で残る（規則2・規則13）
  await expect(page.getByTestId(`module-state-${name}`), "止めたのに一覧から消えた").toContainText(
    "Stopped",
    { timeout: 30_000 },
  );
  // 開き直しても残っている（画面の覚えではなく、host が持っている）
  await page.reload();
  await expect(row, "開き直したら消えた").toBeVisible({ timeout: 30_000 });
  // host の一覧にも残っている（画面の自己申告を信じない・規則1）
  const list = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string; enabled: boolean }>;
  expect(list.find((m) => m.name === name), "host の一覧から消えた").toMatchObject({ enabled: false });

  // ---- また動かせる ------------------------------------------------------
  await row.getByRole("switch").click();
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "保存", exact: true }).click();
  await page.getByTestId("module-save-dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId(`module-state-${name}`), "動かし直せない").not.toContainText(
    "Stopped",
    { timeout: 30_000 },
  );

  // 片づける
  await page.request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
});

// **公式だが最初から入れないものを、「Module を追加」から入れる**
// （決定・2026-09-20、ユーザー）。
//
// `vault-infisical` は banto のコードだが**誰もが使うものではない**ので、既定に
// 入れない。要る人が目録から、好きな名前で何本でも入れる（接続先ごとに1本）。
//
// **画面から役割を打たせない**のがこの形の肝（`v4-security.md`「役割のなりすまし」）
// ——宣言を組み立てるのは host で、画面が送るのは目録の id と名前だけ。
// ここを人が打てるようにすると、**貼り付けた JSON が金庫の窓口を名乗る経路**が
// 画面から復活する。
test("「Module を追加」の公式モジュールのタブから、同じものを何本でも入れられる", async ({ page }) => {
  await openModuleSettings(page);

  // **既定に入っていないこと**は core の単体試験が見ている（既定は4本）。
  // ここは全 spec で core を共有するので、**一意な名前で入れて片づける**
  const names = [`e2e-infisical-${Date.now()}`, `e2e-infisical-${Date.now()}-b`];

  const install = async (name: string) => {
    await page.getByRole("button", { name: "Module を追加" }).click();
    // **開いたときの既定が公式モジュールのタブ**（いちばん楽な道を安全なほうに置く）
    await expect(page.getByTestId("add-module-bundled")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("add-module-bundled-vault-infisical").click();
    // **名前は埋まって出る**（人が考えなくてよい）。**同じ名前は勧めない**
    const nameField = page.getByLabel("名前", { exact: true });
    const suggested = await nameField.inputValue();
    expect(suggested, "名前が埋まっていない").not.toBe("");
    await expect(
      page.locator(`[data-module="${suggested}"]`),
      `もう在る名前を勧めている: ${suggested}`,
    ).toHaveCount(0);
    // **役割も起動の指定も聞かれない**（聞かれていたら、この形が崩れている）
    await expect(page.getByLabel("コマンド")).toHaveCount(0);
    await nameField.fill(name);
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await expect(page.locator(`[data-module="${name}"]`)).toBeVisible({ timeout: 30_000 });
  };

  await install(names[0]!);
  // **2本目も入る**（接続先ごとに1本——これが目録にした理由そのもの）
  await install(names[1]!);

  // **画面の言い分ではなく host に聞く**（規則1）
  const list = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string; origin: string; removable: boolean; satisfies: string[] }>;
  for (const name of names) {
    const stored = list.find((m) => m.name === name)!;
    // **banto のコードが走るので役割を名乗れる**が、**自分で入れた行なので消せる**
    expect(stored, `${name} が host に届いていない`).toMatchObject({
      origin: "bundled",
      removable: true,
    });
    expect(stored.satisfies, "役割が付いていない").toEqual(["vault"]);
  }

  // **それぞれ自分の設定画面を持つ**——別の接続先を入れる場所（目録にした目的）。
  // 左の見出しは Module 自身が名乗る（`Vault（Infisical：<名前>）`）ので、
  // **名前で引き当てられる**＝2本が別の面として並んでいる
  for (const name of names) {
    await expect(
      page.getByRole("button", { name: `Vault（Infisical：${name}）`, exact: true }),
      `${name} の設定画面への入口が出ない`,
    ).toBeVisible({ timeout: 30_000 });
  }

  // 片づける（行の「…」から消せる）
  for (const name of [...names].reverse()) {
    await page.getByTestId(`module-menu-${name}`).click();
    await page.getByRole("menuitem", { name: "削除" }).click();
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page.locator(`[data-module="${name}"]`), `${name} が消えていない`).toHaveCount(0, {
      timeout: 30_000,
    });
  }
});

// **既定には削除が出ない**——消せないのではなく、設定に消すものが無い
test("既定の行の「…」には削除が出ない", async ({ page }) => {
  await openModuleSettings(page);
  await page.getByTestId("module-menu-vault-local").click();
  await expect(
    page.getByRole("menuitem", { name: "削除" }),
    "既定に削除が出ている",
  ).toHaveCount(0);
});

test("外から Module を足せる——どこに立つかは書いたもので決まり、同梱は消せない", async ({ page }) => {
  await openModuleSettings(page);

  await page.getByRole("button", { name: "Module を追加" }).click();

  // **外から繋ぐときは「貼り付ける」**（改訂・2026-09-16、ユーザー指摘「普通の
  // 人には使いづらい」）。人は README や Claude Code の設定から持ってくる
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-json").click();
  await page.getByLabel("設定（JSON）").fill(
    JSON.stringify({
      mcpServers: { [ADDED]: { command: "/bin/sh", args: ["-c", "true"] } },
    }),
  );
  await expect(page.getByTestId("add-module-effect")).toContainText("banto 全体で1本");
  await page.getByRole("button", { name: "追加", exact: true }).click();

  const row = page.locator(`[data-module="${ADDED}"]`);
  await expect(row, "足したのに一覧に出ない").toBeVisible({ timeout: 30_000 });
  await expect(row, "ユーザー追加なのに組み込み扱い").toContainText("ユーザー追加");
  // **外から繋ぐコードは必ず閉じ込める**（表の「サンドボックス」列）——banto 全体の Module なら全体用のコンテナ
  await expect(row.locator("td").nth(3), "閉じ込めが掛かっていない").toHaveText("全体のコンテナ");

  // **同梱には消すボタンが出ない**
  // 外から足したものは消せる。**データは消さないと言ってから消す**
  await page.getByTestId(`module-menu-${ADDED}`).click();
  await page.getByRole("menuitem", { name: "削除" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Vault に保存した認証情報は削除されません");
  await page.getByRole("button", { name: "削除", exact: true }).click();
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
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-manual").click();
  await page.getByLabel("コマンド").fill("npx");
  await page.getByLabel("引数（空白区切り）").fill("-y @modelcontextprotocol/server-weather");
  await expect(page.getByTestId("add-module-effect")).toContainText("banto 全体で1本");
  await page.getByRole("button", { name: "＋ この Project のフォルダを渡す" }).click();
  await expect(page.getByTestId("add-module-effect")).toContainText("Project ごとに1本");
  // **閉じ込めは外せない**と、どちらの場合も言う
  await expect(page.getByTestId("add-module-effect")).toContainText("必ず閉じ込めます");
});

// **手で書く道でも API キーを入れられる**（追加・2026-09-16）。既定は「Vault から」
// ——直書きは記録に残り続けるので、楽な道を安全なほうに置く
test("API キーは既定で Vault から引く——直接入力を選ぶと、記録に残ると言う", async ({ page }) => {
  const name = `e2e-secret-ui-${Date.now()}`;
  await openModuleSettings(page);
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-manual").click();

  // 既定は Vault から
  await expect(page.getByTestId("add-module-secret-note")).toContainText("記録には名前だけ");
  // 直接入力に切り替えると、消せないことを言う
  await page.getByTestId("add-module-secret-source-plain").click();
  await expect(page.getByTestId("add-module-secret-note")).toContainText("後から消せません");
  await page.getByTestId("add-module-secret-source-vault").click();

  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.getByLabel("コマンド").fill("/bin/sh");
  await page.getByLabel("引数（空白区切り）").fill("-c true");
  await page.getByLabel("API キー（要るときだけ）").fill("WEATHER_API_KEY");
  await page.getByLabel("Vault に入れた名前").fill("weather-key");
  await page.getByRole("button", { name: "追加", exact: true }).click();

  await expect(page.locator(`[data-module="${name}"]`), "足したのに一覧に出ない").toBeVisible({
    timeout: 30_000,
  });

  // **画面の言い分ではなく、保存された宣言を見る**（規則1）
  const exported = (await (
    await page.request.get(`${CORE_BASE_URL}/api/modules/export`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  expect(exported.mcpServers[name]?.env?.WEATHER_API_KEY, "Vault からの参照になっていない").toBe(
    "${secret:weather-key}",
  );

  // 片づける
  await page.request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
});

// **URL に繋ぐ形は、押す前に「外へ出る」と言い、承知するまで押せない**
// （改訂・2026-09-17。以前はここで断っていた）
test("URL に繋ぐ設定を貼ったら、相手の名前を出し、承知するまで追加させない", async ({ page }) => {
  await openModuleSettings(page);
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-json").click();
  await page.getByLabel("設定（JSON）").fill(
    JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } }),
  );

  // **どこへ出るのかが、相手の名前で出ている**（規則14——中身まで見る）
  const ack = page.getByTestId("add-module-egress-ack");
  await expect(ack, "外へ出ることを言っていない").toBeVisible();
  await expect(page.getByTestId("add-module-egress-notice"), "相手の名前が出ていない").toContainText(
    "example.com",
  );
  // **閉じ込められないことも、隠さずに言う**
  await expect(page.getByTestId("add-module-effect")).toContainText("閉じ込められません");
  // 承知するまで押せない（既定は止める側・規則2）
  await expect(page.getByRole("button", { name: "追加", exact: true }), "承知していないのに押せる").toBeDisabled();

  await ack.check();
  await expect(page.getByRole("button", { name: "追加", exact: true })).toBeEnabled();
});

// **手で書く道でも URL に繋げる**（追加・2026-09-17）
test("自分で書く道で URL に繋ぐと、立つ場所と閉じ込めの説明が変わる", async ({ page }) => {
  await openModuleSettings(page);
  await page.getByRole("button", { name: "Module を追加" }).click();
  await page.getByTestId("add-module-tabs-custom").click();
  await page.getByTestId("add-module-custom-tabs-manual").click();
  await expect(page.getByTestId("add-module-effect")).toContainText("必ず閉じ込めます");

  await page.getByTestId("add-module-connect-remote").click();
  // コマンド欄は消え、URL 欄になる（繋がっていない欄を残さない・規則13）
  await expect(page.getByLabel("コマンド")).toHaveCount(0);
  await page.getByLabel("URL", { exact: true }).fill("https://weather.example.org/mcp");
  await expect(page.getByTestId("add-module-effect")).toContainText("プロセスは立てません");
  await expect(page.getByTestId("add-module-egress-notice")).toContainText("weather.example.org");
  // API キーは**ヘッダ**になる
  await expect(page.getByLabel("API キー（ヘッダ名／要るときだけ）")).toBeVisible();
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
