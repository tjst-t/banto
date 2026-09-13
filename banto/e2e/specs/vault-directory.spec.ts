// **VaultUI**——Vault の管理だけをまとめて行う Module（v4-modules.md §2.1 C節）。
//
// 見るのは、規則13・規則14 の意味で「繋がっていること」：
//   1. 入口（launcher）から、AI を介さず人が開ける
//   2. 開いた画面が**本物の Vault を見ている**（横断した実装の名前が出る）
//   3. 画面から登録すると、**中継の承認**を経て**実 Vault に届く**
//      ——ボタンが押せた・エラーが出なかった、では見たことにならない。
//      画面に出る中身（種別・対象・backend・用途）まで1つずつ見る
//   4. **値はどこにも出てこない**（画面にも、一覧にも）
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, expectProjectOpen, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E VaultUI Project";
const ALIAS = `e2e-vault-directory-${Date.now()}`;
/** 「画面に出てしまったら分かる」一意な値。**出ないことを確かめるため**に使う。 */
const SECRET = `MUST-NOT-APPEAR-${Date.now()}`;

test("VaultUI の入口から開いた画面が、実 Vault を横断して読み書きする", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-vault-directory-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  // ---- 1. 入口から開ける（AI には一言も頼んでいない）----------------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /Vault を管理/ });
  await expect(entry, "VaultUI の入口が Command Palette に出ていない").toBeVisible({ timeout: 60_000 });
  await entry.click();

  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  await expectProjectOpen(page, PROJECT_NAME, "Canvas を開いたら会話が消えた");

  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

  // ---- 2. 本物の Vault を見ている ----------------------------------------
  // **横断の相手は host に聞いている**——名前を決め打ちしていたら、ここは
  // 「繋がっていなくても出る」ので試験にならない
  await expect(canvas.getByText("接続している実装"), "画面が立ち上がっていない").toBeVisible({
    timeout: 60_000,
  });
  await expect(
    canvas.locator(".chip").filter({ hasText: "vault" }).first(),
    "vault を名乗る実装が1つも見えていない（横断の相手に届いていない）",
  ).toBeVisible({ timeout: 60_000 });
  // **空を前提にしない**——同じ実行の他の試験が、同じ instance の Vault に
  // alias を置く（Vault は banto 全体に1本）。見るのは「この試験が置いたもの」
  await expect(
    canvas.locator("tbody tr").filter({ hasText: ALIAS }),
    "まだ置いていない alias が最初から居る",
  ).toHaveCount(0);

  // ---- 3. 画面から登録する → 中継の承認 → 実 Vault に届く -----------------
  await canvas.getByRole("button", { name: "＋ alias を新規登録" }).click();
  await canvas.locator("#new-name").fill(ALIAS);
  await canvas.locator("#new-value").fill(SECRET);
  await canvas.locator("#new-note").fill("E2E が置いた");
  // **対象に「この Project」が名前で出ている**（人に UUID を選ばせない）
  await expect(canvas.locator("#new-scope")).toContainText(PROJECT_NAME);
  await canvas.locator("#new-scope").selectOption({ label: `この Project（${PROJECT_NAME}）だけ` });
  await canvas.getByRole("button", { name: "登録する" }).click();

  // ---- 4. 画面が出している中身を、1つずつ見る（規則14）-------------------
  const row = canvas.locator("tbody tr").filter({ hasText: ALIAS });
  await expect(row, "登録したのに一覧に出てこない").toBeVisible({ timeout: 120_000 });
  await expect(row, "種別が出ていない").toContainText("汎用シークレット");
  await expect(row, "対象が Project の名前で出ていない").toContainText(PROJECT_NAME);
  await expect(row, "どの backend のものか出ていない").toContainText("vault");
  await expect(row, "用途が出ていない").toContainText("E2E が置いた");
  // 絞り込みでも出る（画面が出している中身が、検索を通しても同じであること）
  await canvas.locator("#query").fill(ALIAS);
  await expect(canvas.locator("tbody tr"), "検索で絞ると出てこない").toHaveCount(1);
  await canvas.locator("#query").fill("");

  // **値はどこにも出ない**
  await expect(canvas.getByText(SECRET), "画面に秘密の値が出ている").toHaveCount(0);
  expect(await page.content()).not.toContain(SECRET);

  // **人が管理画面で押した管理操作は、聞き直さない**（決定・2026-09-12
  // ——v4-modules.md §2.1 C節が「未決」としていた承認ゲートの循環）。
  // 聞いていたら、画面は開いた瞬間の読み取りから会話の返事待ちで止まる
  await expect(
    page.locator('[data-role="judgment-card"]'),
    "人が開いた管理画面の操作で、承認カードが出ている",
  ).toHaveCount(0);

  // ---- 5. 実 Vault に届いている（画面の自己申告を信じない、規則1）--------
  const listed = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault", tool: "listAliases", arguments: {} },
  });
  expect(listed.status()).toBe(200);
  const body = await listed.text();
  expect(body, "実 Vault に alias が入っていない（画面だけが繋がったふりをしている）").toContain(ALIAS);
  expect(body, "Vault の一覧に値が入っている").not.toContain(SECRET);

  // **聞かないが、記録はする**（規則2——黙って通さない）
  const audit = await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
  expect(audit.status()).toBe(200);

  // ---- 6. 用途の書き直しも届く ------------------------------------------
  await row.getByRole("button", { name: "用途" }).click();
  await canvas.locator("#note-text").fill("書き直した");
  await canvas.getByRole("button", { name: "保存する" }).click();
  await expect(
    canvas.locator("tbody tr").filter({ hasText: ALIAS }),
    "用途の書き直しが一覧に反映されていない",
  ).toContainText("書き直した", { timeout: 120_000 });

  // ---- 7. 削除も届く -----------------------------------------------------
  await canvas.locator("tbody tr").filter({ hasText: ALIAS }).getByRole("button", { name: "削除" }).click();
  await canvas.getByRole("button", { name: "削除する" }).click();
  await expect(
    canvas.locator("tbody tr").filter({ hasText: ALIAS }),
    "削除したのに一覧に残っている",
  ).toHaveCount(0, { timeout: 120_000 });

  const after = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault", tool: "listAliases", arguments: {} },
  });
  expect(await after.text(), "画面からは消えたのに、実 Vault には残っている").not.toContain(ALIAS);

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("窓口が AI に見せるのは requestAlias 1本だけ——管理操作は1つも見えない", async () => {
  // **窓口になった**（改訂・2026-09-12）。以前は人専用で A 面を持たなかったが、
  // backend が2本になって「AI にはどちらの requestAlias？」が現実の問題になった
  // ので、**A 面は窓口が1本だけ持つ**（backend 側は module へ降格）。
  // **壊れていても静か**なので直接確かめる
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  /** AI の代理接続。**どの Project のターンかを host が渡す**（実運用と同じ形）。 */
  const connect = async (projectId?: string) => {
    const c = new Client({ name: "e2e-vault-directory-visibility", version: "0.0.0" }, { capabilities: {} });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/vault-directory`), {
        requestInit: {
          headers: {
            authorization: `Bearer ${AUTH_TOKEN}`,
            ...(projectId ? { "x-banto-project-id": projectId } : {}),
          },
        },
      }),
    );
    return c;
  };
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    expect(
      tools.map((t) => t.name),
      "AI に見せる道具が1本だけではない（管理操作か、2本目の入口が漏れている）",
    ).toEqual(["requestAlias"]);

    // **横断した目録は見える。ただし、どの金庫のものかは見せない**
    // ——見せれば、いつか AI に金庫を選ばせることになる
    const { resources } = await client.listResources();
    expect(
      resources.map((r) => r.uri).sort(),
      "AI に見せる資源が想定と違う",
    ).toEqual(["ui://banto-vault-directory/request", "vault://aliases"]);
    // **中身まで見る**（規則14）——空の一覧でも「金庫の名前が入っていない」は
    // 通ってしまう。実 Vault に置いた名前が、AI 側の目録に出ることを確かめる
    const probe = `e2e-probe-${Date.now()}`;
    await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        server: "vault",
        tool: "createAlias",
        arguments: { name: probe, kind: "secret", value: "probe-value" },
      }),
    });
    try {
      // **誰のためか分からない接続には、名前も見せない**（決定・2026-09-13、
      // fail closed）。host が Project を刻まない接続はここで止まる
      const blind = (await client.readResource({ uri: "vault://aliases" })).contents as { text: string }[];
      expect(blind[0]!.text, "誰のためか分からないのに一覧が出ている").toBe("[]");

      // **Project が分かれば、共通グループのものは見える**
      const withProject = await connect("e2e-some-project");
      try {
        const read = await withProject.readResource({ uri: "vault://aliases" });
        const text = (read.contents as { text: string }[])[0]!.text;
        expect(text, "窓口の目録に、実 Vault に置いた名前が出てこない（横断できていない）").toContain(probe);
        expect(text, "横断した目録に金庫の名前が入っている").not.toContain("implementation");
        expect(text, "使える範囲の内訳まで AI に見せている").not.toContain("group");
        expect(text, "目録に値が入っている").not.toContain("probe-value");
      } finally {
        await withProject.close();
      }
    } finally {
      await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          server: "vault",
          tool: "deleteAlias",
          arguments: { name: probe },
        }),
      });
    }
  } finally {
    await client.close();
  }
});

// **管理画面でも、種別で聞くことが変わる**（回帰・2026-09-13、ユーザー報告
// 「fullscreen の Vault 管理画面で作ろうとすると、ssh key pair なのに
// うまく選択肢が出てない」）。会話の中の入力欄では直したのに、**同じ規則を
// 2箇所に書いていたのでこちらは直っていなかった**（規則3）。
test("管理画面：鍵ペアを選ぶと、聞くことが変わって公開鍵まで出る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-vd-key-"));
  const name = `e2e-mgr-key-${Date.now()}`;
  await openApp(page);
  await createProject(page, "E2E Vault 管理の鍵", projectRoot);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  await page.getByRole("option", { name: /Vault を管理/ }).click();
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ alias を新規登録" }).click();
  await canvas.locator("#new-name").fill(name);

  // 汎用シークレットのうちは、1行の欄で「作る強さ」を聞く
  await canvas.locator("#new-kind").selectOption("secret");
  await canvas.locator("#new-source").selectOption("generated");
  await expect(canvas.locator("#new-generate-field")).toBeVisible();
  await expect(canvas.locator("#new-value-field"), "作らせるのに値を聞いている").toBeHidden();

  // **鍵ペアにすると「作る強さ」が消える**——鍵の強さは鍵の種類が決める
  await canvas.locator("#new-kind").selectOption("ssh-identity");
  await expect(
    canvas.locator("#new-generate-field"),
    "鍵ペアなのに「作る強さ（バイト数）」を聞いている",
  ).toBeHidden();
  await expect(canvas.locator("#new-ssh-note")).toBeVisible();

  // 貼る側に戻すと、秘密鍵は**複数行**の欄で受ける
  await canvas.locator("#new-source").selectOption("typed");
  await expect(canvas.locator("#new-value-multiline"), "秘密鍵を1行の欄で受けようとしている").toBeVisible();
  await expect(canvas.locator("#new-value")).toBeHidden();

  // 作る → 公開鍵が出る
  await canvas.locator("#new-source").selectOption("generated");
  await canvas.locator("#new-scope").selectOption({ label: "どの Project からでも" });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const pubkey = canvas.locator("#pubkey-text");
  await expect(pubkey, "公開鍵の画面が出ない").toBeVisible({ timeout: 120_000 });
  expect(await pubkey.inputValue(), "公開鍵の欄が空のまま出ている").toMatch(/^ssh-ed25519 AAAA/);
  await canvas.getByRole("button", { name: "閉じる" }).click();

  // 一覧に「鍵」として、付けた名前で出る（公開鍵に化けない）
  const row = canvas.locator("tbody tr").filter({ hasText: name });
  await expect(row, "登録したのに一覧に出てこない").toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("SSH 身元");
  await expect(row, "使える範囲が出ていない").toContainText("どこからでも");

  // 後片づけ
  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "deleteAlias", arguments: { name } },
  });
});
