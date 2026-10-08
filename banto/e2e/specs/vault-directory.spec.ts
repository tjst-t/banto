// **VaultUI**——Vault の管理だけをまとめて行う Module（v4-modules.md §2.1 C節）。
//
// 見るのは、規則13・規則14 の意味で「繋がっていること」：
//   1. 入口（launcher）から、AI を介さず人が開ける
//   2. 開いた画面が**本物の Vault を見ている**（横断した実装の名前が出る）
//   3. 画面から登録すると、**中継の承認**を経て**実 Vault に届く**
//      ——ボタンが押せた・エラーが出なかった、では見たことにならない。
//      画面に出る中身（種別・対象・backend・用途）まで1つずつ見る
//   4. **値はどこにも出てこない**（画面にも、一覧にも）
import { test, expect } from "../test-base.js";
import type { FrameLocator, Locator } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, expectProjectOpen, openApp, openPaletteEntry } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E VaultUI Project";
const ALIAS = `e2e-vault-directory-${Date.now()}`;
/** 「画面に出てしまったら分かる」一意な値。**出ないことを確かめるため**に使う。 */
const SECRET = `MUST-NOT-APPEAR-${Date.now()}`;
/** Vault を「またぐ」ことを試すための2本目（同じ vault-local を別の置き場で）。 */
const SECOND_VAULT = "vault-local-2";

/**
 * **行の操作は「…」のメニューから**（改訂・2026-10-05、ユーザー指摘——操作を並べていたら表が
 * 横にはみ出した）。開くと最初の項目に焦点が来るまで待ってから押す——メニューが出たことを見る。
 */
async function rowAction(canvas: FrameLocator, row: Locator, label: string): Promise<void> {
  await row.getByRole("button", { name: /の操作$/ }).click();
  const menu = canvas.getByRole("menu");
  await expect(menu, "行のメニューが開かない").toBeVisible();
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(menu, "項目を選んでもメニューが閉じない").toHaveCount(0);
}

/** 行のメニューに並ぶ項目（開いて読み、Esc で閉じる）。 */
async function rowMenuItems(canvas: FrameLocator, row: Locator): Promise<string[]> {
  await row.getByRole("button", { name: /の操作$/ }).click();
  const items = await canvas.getByRole("menu").getByRole("menuitem").allInnerTexts();
  await canvas.getByRole("menu").getByRole("menuitem").first().press("Escape");
  await expect(canvas.getByRole("menu")).toHaveCount(0);
  return items;
}

/**
 * **見えていることを、畳まれた中で見る**——toBeVisible は overflow で切られた分を見ない。
 * 印や「→」がセルの外（切れた先）にあれば、画面には出ていない。
 */
async function expectWithin(child: Locator, container: Locator, message: string): Promise<void> {
  await expect(child, message).toBeVisible();
  const c = await child.boundingBox(), box = await container.boundingBox();
  expect(c && box && c.width > 0 && c.x >= box.x - 0.5 && c.x + c.width <= box.x + box.width + 0.5, message).toBe(true);
}

/**
 * **badge がセルの中身の幅に収まっている**（追加・2026-10-06）。セルの右の余白（padding）まで食い込むと、
 * 隣の列の字に触れて見える——「シークレット」が隣の列へはみ出していた。比べるのは余白を引いた右端
 */
async function expectFitsCell(badge: Locator, cell: Locator, message: string): Promise<void> {
  await expect(badge, message).toBeVisible();
  const b = await badge.boundingBox(), c = await cell.boundingBox();
  const padRight = await cell.evaluate((e) => parseFloat(getComputedStyle(e).paddingRight));
  expect(
    b && c && b.x >= c.x - 0.5 && b.x + b.width <= c.x + c.width - padRight + 0.5,
    `${message}（badge ${b && Math.round(b.x + b.width)}px / セルの中身の右端 ${c && Math.round(c.x + c.width - padRight)}px）`,
  ).toBe(true);
}

/** 見えている要素の数（hidden・display:none を数えない）。 */
function visibleCount(loc: Locator): Promise<number> {
  return loc.evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);
}

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
    canvas.locator(".chip").filter({ hasText: "vault-local" }).first(),
    "vault を名乗る実装が1つも見えていない（横断の相手に届いていない）",
  ).toBeVisible({ timeout: 60_000 });
  // **空を前提にしない**——同じ実行の他の試験が、同じ instance の Vault に
  // alias を置く（Vault は banto 全体に1本）。見るのは「この試験が置いたもの」
  await expect(
    canvas.locator("tbody tr").filter({ hasText: ALIAS }),
    "まだ置いていない alias が最初から居る",
  ).toHaveCount(0);

  // ---- 3. 画面から登録する → 中継の承認 → 実 Vault に届く -----------------
  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(ALIAS);
  await canvas.locator("#new-value").fill(SECRET);
  await canvas.locator("#new-note").fill("E2E が置いた");
  // **保存先に「この Project」が名前で出ている**（人に UUID を選ばせない）。
  // **backend は聞かない**——保存先を選べば Vault は決まる（改訂・2026-09-14）
  await expect(canvas.locator("#new-impl"), "backend をまだ聞いている").toHaveCount(0);
  await expect(canvas.locator("#new-scope")).toContainText(PROJECT_NAME);
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await expect(canvas.locator("#new-scope-effect")).toContainText("この Project からだけ");
  await canvas.getByRole("button", { name: "登録する" }).click();

  // ---- 4. 画面が出している中身を、1つずつ見る（規則14）-------------------
  const row = canvas.locator("tbody tr").filter({ hasText: ALIAS });
  await expect(row, "登録したのに一覧に出てこない").toBeVisible({ timeout: 120_000 });
  await expect(row, "種別が出ていない").toContainText("シークレット");
  // **使える範囲は4つだけ**（改訂・2026-10-06、ユーザー指示）——この Project の行は Project 名ではなく「この Project」
  await expect(row.locator("td").nth(2), "使える範囲が「この Project」で出ていない").toHaveText("この Project");
  await expect(row, "どの backend のものか出ていない").toContainText("vault-local");
  await expect(row, "用途が出ていない").toContainText("E2E が置いた");
  // **グループの列は、backend での本当の名前**（改訂・2026-09-20、ユーザー指示）。
  // 言い換え（「この Project 専用（…）」）だと、人が Infisical を開いたときに
  // 突き合わせられない。**保存先の表示と同じ文字列が出ること**で確かめる
  const placedGroup = (await canvas.locator("#place-summary").innerText()).split(" / ").pop()!.trim();
  expect(placedGroup, "保存先のグループが読めていない").not.toBe("");
  await expect(row.locator("td").nth(4), "グループが backend での名前で出ていない").toHaveText(placedGroup);
  // **長い名前でも、折り返さずに畳む**（追加・2026-09-20、ユーザー指摘——
  // 名前が1文字ずつ縦に流れていた）。**中身は全文のまま**（切るのは CSS）
  // 畳むのは名前の文字そのもの（.name-text）——参照の行では、前に置く印を畳まないため（2026-10-05）
  await expect(row.locator(".name-text"), "名前が畳まれていない").toHaveCSS("text-overflow", "ellipsis");
  await expect(row.locator(".name-text"), "名前が折り返されている").toHaveCSS("white-space", "nowrap");
  await expect(row.locator("td").nth(1), "コピーすると切れた名前が取れる").toHaveText(ALIAS);
  // **実際に1行に収まっていること**（規則14——CSS が当たっていることと、
  // 見た目が1行であることは別）。畳む前は名前が1文字ずつ縦に流れて、
  // 行の高さが10行分まで伸びていた
  const box = await row.boundingBox();
  expect(box, "行の寸法が取れない").not.toBeNull();
  expect(box!.height, `行が縦に伸びている: ${box!.height}px`).toBeLessThan(44);

  // **既定は「この Project から使える」**（追加・2026-09-20）。Vault は banto 全体に
  // 1本なので、絞らないと他の Project の秘密が全部並ぶ
  await expect(canvas.locator("#target-filter"), "既定の絞り込みが当たっていない").toHaveValue("usable");
  // 絞り込みでも出る（画面が出している中身が、検索を通しても同じであること）
  await canvas.locator("#query").fill(ALIAS);
  // **行の数で待つ**（改訂・2026-10-05）。以前は「行の文字に改行が無い」で1件を見ていたが、
  // 名前のセルが行（ブロック）を持つようになり、1行の中にも改行が入る
  await expect(canvas.locator("tbody tr"), "検索で絞ったのに1件にならない").toHaveCount(1, { timeout: 10_000 });
  const rows = await canvas.locator("tbody tr").allInnerTexts();
  expect(rows, `検索で絞ると1件にならない: ${JSON.stringify(rows)}`).toHaveLength(1);
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
    data: { server: "vault-local", tool: "listAliases", arguments: {} },
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
  await rowAction(canvas, row, "用途を編集");
  await canvas.locator("#note-text").fill("書き直した");
  await canvas.getByRole("button", { name: "保存する" }).click();
  await expect(
    canvas.locator("tbody tr").filter({ hasText: ALIAS }),
    "用途の書き直しが一覧に反映されていない",
  ).toContainText("書き直した", { timeout: 120_000 });

  // ---- 7. 削除も届く -----------------------------------------------------
  await rowAction(canvas, canvas.locator("tbody tr").filter({ hasText: ALIAS }), "削除");
  await canvas.getByRole("button", { name: "削除する" }).click();
  await expect(
    canvas.locator("tbody tr").filter({ hasText: ALIAS }),
    "削除したのに一覧に残っている",
  ).toHaveCount(0, { timeout: 120_000 });

  const after = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-local", tool: "listAliases", arguments: {} },
  });
  expect(await after.text(), "画面からは消えたのに、実 Vault には残っている").not.toContain(ALIAS);

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("窓口が AI に見せるのは2本だけ——管理操作は1つも見えない", async () => {
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
    // **公開鍵は秘密ではない**ので AI が読んでよい（追加・2026-09-13）。
    // 管理操作が混ざっていないことが要点
    expect(
      tools.map((t) => t.name).sort(),
      "AI に見せる道具が想定と違う（管理操作が漏れている可能性）",
    ).toEqual(["getPublicKey", "requestAlias"]);

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
        server: "vault-local",
        tool: "createAlias",
        arguments: { name: probe, kind: "secret", value: "probe-value" },
      }),
    });
    try {
      // **誰のためか分からない接続には、名前も見せない**（決定・2026-09-13、
      // fail closed）。host が Project を刻まない接続はここで止まる
      const blind = JSON.parse(
        ((await client.readResource({ uri: "vault://aliases" })).contents as { text: string }[])[0]!.text,
      );
      expect(blind.aliases, "誰のためか分からないのに一覧が出ている").toEqual([]);
      // **「無い」ではなく「決められない」と言う**（改訂・2026-09-15）。
      // 空だけ返すと、配線の壊れが「まだ何も登録されていません」に化ける
      expect(blind.warning, "読めていない理由を言っていない").toContain("読めていない");

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
          server: "vault-local",
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
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
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
  await canvas.locator("#new-scope").selectOption({ index: 1 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const pubkey = canvas.locator("#pubkey-text");
  await expect(pubkey, "公開鍵の画面が出ない").toBeVisible({ timeout: 120_000 });
  expect(await pubkey.inputValue(), "公開鍵の欄が空のまま出ている").toMatch(/^ssh-ed25519 AAAA/);
  const created = await pubkey.inputValue();
  await canvas.getByRole("button", { name: "閉じる" }).click();

  // 一覧に「鍵」として、付けた名前で出る（公開鍵に化けない）
  const row = canvas.locator("tbody tr").filter({ hasText: name });
  await expect(row, "登録したのに一覧に出てこない").toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("SSH 鍵");
  // **badge は1語**（改訂・2026-09-20、ユーザー指示）——説明を足さない
  await expect(row.locator("td").nth(2), "使える範囲が出ていない").toHaveText("Global");
  // **グループは backend での本当の名前**（改訂・2026-09-20）。Global の置き場は
  // 画面の案内に出ているので、そこと突き合わせる（決め打ちにしない）
  const sharedGroup = (await canvas.locator("#shared-hint").innerText()).split(" / ").pop()!.split("（")[0]!.trim();
  expect(sharedGroup, "Global の置き場が読めていない").not.toBe("");
  await expect(row.locator("td").nth(4), "グループが backend での名前で出ていない").toHaveText(sharedGroup);

  // **あとからでも公開鍵を見られる**（追加・2026-09-13、ユーザー要望）。
  // 以前は作った直後の1回きりで、閉じたら二度と見られなかった
  await rowAction(canvas, row, "公開鍵を表示");
  await expect(pubkey, "一覧から公開鍵を開けない").toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => pubkey.inputValue(), { timeout: 30_000, message: "公開鍵が出るまで" })
    .toBe(created);
  // コピーの口があること（押せることまで見る——押して例外が出ないこと）
  await canvas.getByRole("button", { name: "コピーする" }).click();
  await expect(canvas.locator("#pubkey-error"), "公開鍵の取得でエラーが出ている").toBeHidden();
  await canvas.getByRole("button", { name: "閉じる" }).click();

  // 後片づけ
  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "deleteAlias", arguments: { name } },
  });
});

// **置き場は「Vault とグループの組」で1つ**（改訂・2026-09-14、ユーザー指摘
// 「まだバックエンドごとに選ぶ仕様になっている」）。以前は backend の chip から
// 開いていたので、**同じ問いを backend の数だけ聞いていた**——「この Project の
// 秘密は結局どこに行くのか」が画面から読めなかった。
// **共通の置き場の設定は Canvas に無い**（改訂・2026-09-14、ユーザー指摘
// 「こういうのは Canvas よりも設定画面でやったほうがいい」）——値が動かないので設定。
// Project の置き場だけは、変えると秘密が実際に移るのでここに在る（下の試験）。
test("管理 Canvas に共通の置き場の設定を置かない——見る・作る・消すための面", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-noplace-"));
  await openApp(page);
  await createProject(page, "E2E 置き場なし", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await expect(canvas.getByRole("button", { name: "秘密の置き場…" }), "設定が Canvas に残っている").toHaveCount(0);
  await expect(canvas.getByRole("button", { name: "グループ" }), "backend ごとの入口が残っている").toHaveCount(0);
});

// **置き場を変えるのは操作**（決定・2026-09-14、ユーザー指示）。値が動くので、
// 設定画面ではなくここ（管理 Canvas）に置く。見るのは2つ：
//   1. **変える前に、何が起きるか出る**（移さないと使えなくなるもの）
//   2. **移行ありなら、秘密も一緒に動く**——値は失われない
test("この Project の置き場を変えられる——移行の有無を選べて、結果が先に分かる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-move-"));
  const alias = `e2e-move-${Date.now()}`;
  await openApp(page);
  await createProject(page, "E2E 置き場を変える", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  // この Project に1つ置く（保存先＝この Project）
  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(alias);
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.locator("#new-value").fill("move-me");
  await canvas.getByRole("button", { name: "登録する" }).click();
  await expect(canvas.locator("tbody tr").filter({ hasText: alias })).toBeVisible({ timeout: 60_000 });

  // 移し先のグループを先に用意する（**移す先が同じなら「移すものはありません」**）
  const dest = `e2e-moved-${Date.now()}`;
  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "createGroup", arguments: { implementation: "vault-local", name: dest } },
  });

  // **いまどこに保存しているかが、開かなくても読める**（改訂・2026-09-14、
  // ユーザー指摘「一覧の見出しの真ん中にあるのは変」——「接続している実装」の
  // 段に移し、ボタンだけでなく**いまの置き場を出す**ようにした）
  await expect(canvas.locator("#place-summary"), "いまの置き場が画面に出ていない").toContainText(
    "この Project の保存先は vault-local /",
  );

  // 置き場を変える画面を開く
  await canvas.getByRole("button", { name: "変更…" }).click();
  await expect(canvas.getByText("この Project の秘密の置き場を変える")).toBeVisible();
  await expect(canvas.locator("#place-now"), "いまどこかを言っていない").toContainText("いまは");
  await canvas.locator("#place-group").selectOption(dest);

  // **移さないと、どうなるかが先に分かる**
  await canvas.locator("#place-migrate").selectOption("no");
  await expect(canvas.locator("#place-effect")).toContainText("使えなくなります");

  // **移すなら、そう言う**
  await canvas.locator("#place-migrate").selectOption("yes");
  await expect(canvas.locator("#place-effect")).toContainText("一緒に移します");

  await canvas.getByRole("button", { name: "変える" }).click();
  // **「エラーが出ていない」を押した直後に見ない**（訂正・2026-09-14）。
  // 押した瞬間にエラー欄は一度消されるので、その後に失敗しても、先に見た
  // 「消えている」で通ってしまう——実際 `refresh()`（存在しない関数）で
  // 落ちていたのに、この試験は通り続けていた。
  // **成功したときにしか起きないこと＝ダイアログが閉じること**を待つ（規則14）
  await expect(canvas.locator("#dlg-place"), "変えられずにダイアログが開いたまま").toBeHidden();
  await expect(canvas.locator("#place-error"), "変えるときにエラーが出た").toBeHidden();

  // **秘密も一緒に動いた**（使える範囲は Project のまま）
  const row = canvas.locator("tbody tr").filter({ hasText: alias });
  await expect(row, "移したのに一覧から消えた").toBeVisible({ timeout: 60_000 });
  await expect(row.locator("td").nth(2), "移したのに使えなくなっている").toHaveText("この Project");
  // **変えたことが、そのまま画面に映る**（古い置き場を出したままにしない・規則3）
  await expect(canvas.locator("#place-summary"), "置き場の表示が古いまま").toContainText(dest);

  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "deleteAlias", arguments: { implementation: "vault-local", name: alias } },
  });
});

// ---- 2026-09-15 のレビューで直したもの ---------------------------------------

// **コピーは一度も動いていなかった**（訂正・2026-09-15）。sandbox iframe に
// Permissions Policy でクリップボードが渡っておらず、`void` で投げっぱなし
// だったので**失敗も成功も画面が何も言わなかった**——人は押して、何も起きず、
// コピーされたと思い込む。押した結果が出ることまで見る（規則14——押せた、では
// 見たことにならない）。
test("公開鍵のコピーは、押した結果を人に言う", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-copy-"));
  const keyAlias = `e2e-copy-key-${Date.now()}`;
  await openApp(page);
  await createProject(page, "E2E コピー", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(keyAlias);
  await canvas.locator("#new-kind").selectOption("ssh-identity");
  await canvas.locator("#new-source").selectOption("generated");
  await canvas.getByRole("button", { name: "登録する" }).click();
  // 作った直後は公開鍵のダイアログが自動で開く——いったん閉じて、
  // **行の「公開鍵」から開き直したものでコピーを試す**（後から見られること込み）
  await expect(canvas.locator("#pubkey-text"), "作った直後に公開鍵が出ない").toHaveValue(/^ssh-/, {
    timeout: 120_000,
  });
  await canvas.getByRole("button", { name: "閉じる" }).click();
  const row = canvas.locator("tbody tr").filter({ hasText: keyAlias });
  await expect(row, "鍵ペアが一覧に出ない").toBeVisible({ timeout: 120_000 });

  await rowAction(canvas, row, "公開鍵を表示");
  await expect(canvas.locator("#pubkey-text"), "公開鍵が出ていない").toHaveValue(/^ssh-/, { timeout: 60_000 });
  await canvas.getByRole("button", { name: "コピーする" }).click();
  // **黙って失敗しない**——成功なら「コピーしました」、駄目なら次の手を言う
  await expect(canvas.locator("#pubkey-copied"), "コピーの結果を何も言っていない").toContainText(
    "コピーしました",
    { timeout: 10_000 },
  );

  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "deleteAlias", arguments: { implementation: "vault-local", name: keyAlias } },
  });
});

// **キャンセルした秘密鍵が DOM に残っていた**（訂正・2026-09-15）。
// このファイルの冒頭は「値はこの画面のどこにも残らない」と宣言している。
test("秘密鍵を貼ってやめたら、次に開いたときに残っていない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-leftover-"));
  const leaked = `LEFTOVER-PRIVATE-KEY-${Date.now()}`;
  await openApp(page);
  await createProject(page, "E2E 貼ってやめる", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-kind").selectOption("ssh-identity");
  await canvas.locator("#new-value-multiline").fill(leaked);
  // **同じ名前のボタンが複数のダイアログにある**——閉じたい相手を名指しする。名前は完全一致で（2026-10-07）
  // ——選択欄の中の <button><selectedcontent>（customizable select）を Playwright は button と数え、その名前は
  // 選んでいる選択肢（「この Project（E2E 貼ってやめる）」）になる。Chromium の読み上げの木では combobox 1つのまま
  await canvas.locator("#dlg-new").getByRole("button", { name: "やめる", exact: true }).click();
  await expect(canvas.locator("#dlg-new"), "やめるを押しても閉じない").toBeHidden();

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await expect(canvas.locator("#new-value-multiline"), "やめたのに前回の秘密鍵が残っている").toHaveValue("");
  expect(await page.content(), "ページの DOM に秘密鍵が残っている").not.toContain(leaked);
});

// **どこにも紐付いていない秘密の、削除以外の出口**（追加・2026-09-15）
test("一覧の行から、別の置き場へ移せる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-rowmove-"));
  const alias = `e2e-rowmove-${Date.now()}`;
  const dest = `e2e-rowdest-${Date.now()}`;
  await openApp(page);
  await createProject(page, "E2E 行から移す", projectRoot);
  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-directory", tool: "createGroup", arguments: { implementation: "vault-local", name: dest } },
  });
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(alias);
  await canvas.locator("#new-value").fill("row-move-me");
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const row = canvas.locator("tbody tr").filter({ hasText: alias });
  await expect(row).toBeVisible({ timeout: 120_000 });

  await rowAction(canvas, row, "秘密を移動");
  await expect(canvas.locator("#move-now"), "いまの置き場を言っていない").toContainText("いまは vault-local");
  await canvas.locator("#move-group").selectOption(dest);
  // **移した先からどう引けるようになるかを、押す前に出す**
  await expect(canvas.locator("#move-effect")).toContainText("頭に付けて引きます");
  await canvas.locator("#move-submit").click();
  await expect(canvas.locator("#dlg-move"), "移せずにダイアログが開いたまま").toBeHidden({ timeout: 60_000 });

  // **移った先が一覧に出る**（値が生きていることは backend に直接聞く）
  const listed = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: "vault-local", tool: "listAliases", arguments: {} },
  });
  const outer = JSON.parse(await listed.text()) as { content: { text: string }[] };
  const found = (JSON.parse(outer.content[0]!.text) as Array<{ name: string; group: string }>).find(
    (a) => a.name === alias,
  );
  expect(found?.group, `移した先が違う: ${JSON.stringify(found)}`).toBe(dest);

  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      server: "vault-directory",
      tool: "deleteAlias",
      arguments: { implementation: "vault-local", name: alias, group: dest },
    },
  });
});

// **選択欄**（2026-10-07、ユーザー——実機の暗い配色で「移す」の移す先を開いて）。
//   1. 選択肢の主は **Vault での本当のグループ名**（Project の既定グループは UUID をそのまま、省かない）。この Project・
//      Global の置き場は「— この Project」「— Global」の添え。以前の言い換え（「この Project 専用（…）」）を出さない
//   2. 開いた一覧は customizable select（appearance: base-select）で、行の「…」メニューと同じ host の色——明るい・暗い
//      両方で、一覧の地と字が host の地と字になっていること。閉じた欄は選んだものを … で畳み、▼ を押し出さない
//   3. キーボードは素の select のまま（↑で開き、↑ Enter で選ぶ）
// 開いたところを tmp-shots/ に写す（worktree の頭）
test("選択欄：グループは Vault での本当の名前（この Project・Global は添え）、開いた一覧は base-select で host の色", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-select-"));
  const alias = `e2e-select-${Date.now()}`;
  const shots = join(import.meta.dirname, "../../../tmp-shots");
  mkdirSync(shots, { recursive: true });
  await openApp(page);
  await createProject(page, "E2E 選択欄", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(alias);
  await canvas.locator("#new-value").fill("select-me");
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const row = canvas.locator("tbody tr").filter({ hasText: alias });
  await expect(row).toBeVisible({ timeout: 120_000 });
  await expect(canvas.locator("#place-summary")).toContainText(" / ");
  const projectGroup = (await canvas.locator("#place-summary").innerText()).split(" / ").pop()!.trim();
  const sharedGroup = /vault-local \/ (.+?)（/.exec(await canvas.locator("#shared-hint").innerText())?.[1];
  expect(sharedGroup, "Global の置き場が読めていない").toBeTruthy();

  // ---- 1. 文言 -------------------------------------------------------------------------------
  await rowAction(canvas, row, "秘密を移動");
  await expect(canvas.locator("#dlg-move")).toBeVisible();
  await expect(canvas.locator("#move-now")).toHaveText(`いまは vault-local / ${projectGroup} — この Project`);
  const group = canvas.locator("#move-group");
  const texts = await group.locator("option").evaluateAll((os) =>
    os.map((o) => [(o as HTMLOptionElement).value, o.textContent] as const),
  );
  const textOf = new Map(texts);
  expect(textOf.get(projectGroup), "この Project の置き場の選択肢").toBe(`${projectGroup} — この Project`);
  expect(textOf.get(sharedGroup!), "Global の置き場の選択肢").toBe(`${sharedGroup} — Global`);
  // 最後はグループを作る入口（2026-10-07）。それ以外の選択肢の主はグループ名
  expect(texts.at(-1), "グループを作る入口が最後に無い").toEqual(["__new-group__", "＋ 新しいグループを作る…"]);
  for (const [value, text] of texts.slice(0, -1)) {
    expect(text!.startsWith(value), `選択肢の主がグループ名ではない: ${text}`).toBe(true);
    expect(text, "言い換えが残っている").not.toMatch(/専用/);
  }
  // グループは名前の順（2026-10-08、ユーザー——以前はフォルダを読んだ順で決まっていなかった）
  const names = texts.slice(0, -1).map(([v]) => v);
  expect(names, "グループが名前の順に並んでいない").toEqual(
    [...names].sort((a, b) => a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" })),
  );
  // 版を名乗らない Vault（vault-local）には版の欄を出さない
  await expect(canvas.locator("#move-variant")).toBeHidden();
  // 最初はいまの置き場を選んでおく——動かないので押させない
  await expect(group).toHaveValue(projectGroup);
  await expect(canvas.locator("#move-effect")).toHaveText("もう その置き場に在ります");
  await expect(canvas.locator("#move-submit")).toBeDisabled();

  // ---- 2. 見た目（閉じた欄）-------------------------------------------------------------------
  expect(await group.evaluate((e) => getComputedStyle(e).appearance), "base-select が効いていない").toBe("base-select");
  // 閉じた欄は選んだもの（主と添え）を出し、長いと … で畳む。▼ は欄の中に残る
  const shown = group.locator("selectedcontent");
  await expect(shown).toHaveText(`${projectGroup} — この Project`);
  await expect(shown).toHaveCSS("text-overflow", "ellipsis");
  const sb = (await group.boundingBox())!, cb = (await shown.boundingBox())!;
  expect(cb.x + cb.width, "選んだものが欄からはみ出して ▼ を押し出している").toBeLessThan(sb.x + sb.width - 12);

  /** 開いた一覧の地と字が、小窓（host の地と字）と同じか。 */
  async function expectPickerInHostColors(label: string): Promise<void> {
    await group.click();
    await expect.poll(() => group.evaluate((e) => e.matches(":open")), `${label}：一覧が開かない`).toBe(true);
    const shared = group.locator(`option[value="${sharedGroup}"]`);
    await expect(shared, `${label}：開いた一覧の項目が見えない`).toBeVisible();
    await expect(shared.locator(".opt-tag")).toHaveCSS("opacity", "0.55");
    const [picker, option, dialog] = await group.evaluate((e) => {
      const p = getComputedStyle(e, "::picker(select)");
      const o = getComputedStyle(e.querySelector("option")!);
      const d = getComputedStyle(e.closest("dialog")!);
      return [[p.backgroundColor, p.color, p.borderTopLeftRadius], [o.color], [d.backgroundColor, d.color]] as const;
    });
    expect(picker[0], `${label}：開いた一覧の地が host の地ではない`).toBe(dialog[0]);
    expect(picker[1], `${label}：開いた一覧の字が host の字ではない`).toBe(dialog[1]);
    expect(option[0], `${label}：項目の字が host の字ではない`).toBe(dialog[1]);
    expect(picker[2], `${label}：一覧の角が「…」メニューと揃っていない`).toBe("8px");
  }

  // ---- 2. 見た目（開いた一覧・明るい）----------------------------------------------------------
  await expectPickerInHostColors("明るい");
  const light = await group.evaluate((e) => getComputedStyle(e, "::picker(select)").backgroundColor);
  await page.screenshot({ path: join(shots, "vault-select-light.png") });
  // Esc は一覧だけ閉じる（小窓は開いたまま）
  await page.keyboard.press("Escape");
  await expect.poll(() => group.evaluate((e) => e.matches(":open"))).toBe(false);
  await expect(canvas.locator("#dlg-move")).toBeVisible();

  // ---- 3. キーボード：↑で開き、↑（先頭なら ↓）Enter で隣を選ぶ -------------------------------
  // グループは名前の順（2026-10-08）。この Project のグループ（UUID）はその回の名前次第で先頭にも来るので、
  // 「1つ上」を前提にしない（以前はその前提で 4回に1〜2回落ちていた）
  const values = texts.map(([v]) => v);
  const at = values.indexOf(projectGroup);
  expect(values.length, "試験の前提：この Project の置き場のほかに選べるグループがある").toBeGreaterThan(2);
  const step = at > 0 ? "ArrowUp" : "ArrowDown";
  const neighbour = values[at > 0 ? at - 1 : at + 1]!;
  await group.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => group.evaluate((e) => e.matches(":open")), "↑で一覧が開かない").toBe(true);
  await page.keyboard.press(step);
  await page.keyboard.press("Enter");
  await expect(group, "キーボードで選べない").toHaveValue(neighbour);
  await expect.poll(() => group.evaluate((e) => e.matches(":open"))).toBe(false);
  await expect(canvas.locator("#move-submit")).toBeEnabled();
  await group.selectOption(projectGroup);

  // ---- 2. 見た目（開いた一覧・暗い）------------------------------------------------------------
  await page.getByRole("button", { name: "明暗を切り替え" }).click();
  await page.getByRole("menuitem", { name: "ダーク" }).click();
  await expect(canvas.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectPickerInHostColors("暗い");
  const dark = await group.evaluate((e) => getComputedStyle(e, "::picker(select)").backgroundColor);
  expect(dark, "暗くしても開いた一覧の地が変わらない").not.toBe(light);
  await page.screenshot({ path: join(shots, "vault-select-dark.png") });
  await page.keyboard.press("Escape");
  await canvas.locator("#dlg-move").getByRole("button", { name: "やめる" }).click();
  await expect(canvas.locator("#dlg-move")).toBeHidden();

  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      server: "vault-directory",
      tool: "deleteAlias",
      arguments: { implementation: "vault-local", name: alias, group: projectGroup },
    },
  });
});

// **Vault をまたいで移す**（追加・2026-09-20、ユーザー報告「移すを押しても反応しない」）。
//
// 既存の「一覧の行から、別の置き場へ移せる」は **同じ Vault の中**で移していて、
// `#move-vault` を**一度も触っていなかった**——人が実際にやるのは
// 「vault-local に置いたものを Infisical へ移す」なので、そこが抜けていた。
test("一覧の行から、別の Vault へ移せる（Vault の選択を切り替える）", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-crossmove-"));
  const alias = `e2e-crossmove-${Date.now()}`;
  // **2本目の Vault を用意する**（追加・2026-09-20）。2026-09-20 に
  // vault-infisical を既定から外したので、**この実行には Vault が1本しか無い**
  // ——「またぐ」経路が一度も走らない状態だった。docker に依存しないよう、
  // 同じ vault-local をもう1本（別の置き場で）立てる。**同梱のコードなので
  // `bundled` として扱われる**（`sameCode` の判定は command と args）
  await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      name: SECOND_VAULT,
      launch: {
        command: "${nodeExec}",
        args: ["${monorepoRoot}/packages/modules/vault-local/dist/server.js"],
        env: { BANTO_VAULT_DATA_DIR: "${dataDir}/vault-2" },
      },
      meta: { satisfies: ["vault"], dependsOn: [], isolation: "subprocess", scope: "instance", handlesSecrets: true },
    },
  });
  await openApp(page);
  await createProject(page, "E2E Vault をまたぐ", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(alias);
  await canvas.locator("#new-value").fill("cross-move-me");
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const row = canvas.locator("tbody tr").filter({ hasText: alias });
  await expect(row).toBeVisible({ timeout: 120_000 });

  await rowAction(canvas, row, "秘密を移動");
  await expect(canvas.locator("#dlg-move")).toBeVisible();

  // **移す先の Vault を切り替える**——ここが今まで一度も通っていなかった
  const vaults = await canvas
    .locator("#move-vault option")
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(vaults, `移せる先の Vault が1本しかない: ${JSON.stringify(vaults)}`).toContain(SECOND_VAULT);
  await canvas.locator("#move-vault").selectOption(SECOND_VAULT);

  // **押せる状態になっていること**——押しても何も起きない、を先に captured する
  await expect(canvas.locator("#move-group"), "移す先のグループが選べない").toBeEnabled();
  await expect(canvas.locator("#move-submit"), "「移す」が押せない（押しても反応しない）").toBeEnabled();
  const toGroup = await canvas.locator("#move-group").inputValue();
  expect(toGroup, "移す先のグループが空のまま").not.toBe("");

  await canvas.locator("#move-submit").click();
  // **成功したときにしか起きないこと＝ダイアログが閉じること**（規則14）
  await expect(canvas.locator("#move-error"), "移すときにエラーが出た").toBeHidden();
  await expect(canvas.locator("#dlg-move"), "移せずにダイアログが開いたまま").toBeHidden({ timeout: 60_000 });

  // **本当に移った**（値が生きていることは backend に直接聞く）
  const listed = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: { server: SECOND_VAULT, tool: "listAliases", arguments: {} },
  });
  const outer = JSON.parse(await listed.text()) as { content: { text: string }[] };
  const found = (JSON.parse(outer.content[0]!.text) as Array<{ name: string; group: string }>).find(
    (a) => a.name === alias,
  );
  expect(found, `移した先（${SECOND_VAULT}）に無い`).toBeTruthy();
  expect(found!.group).toBe(toGroup);

  await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      server: "vault-directory",
      tool: "deleteAlias",
      arguments: { implementation: SECOND_VAULT, name: alias, group: toGroup },
    },
  });
  // **足した Module を片づける**（規則7 の裏——置いていくと後続の spec の前提が変わる）。
  // 実際に踏んだ：2本目を残したまま走らせたら、**後の spec（会話の中の入力欄）が
  // 落ちた**。宣言は instance 全体のもので、core は実行を通して1つ
  await page.request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(SECOND_VAULT)}`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
});

// **参照**（決定・2026-10-04、ユーザー。仕様 §2.1 C節「参照」）。
// どこにも紐付いていないグループの秘密を、値を写さずにこの Project の置き場から使えるようにする。
// 見るのは：小窓が出している中身（題・固定された Vault・既定の名前と置き場・説明）、作った参照の行
// （→ 元のグループ / 名前・元から導いた種別・使える範囲）、元を消す確認の件数、元を消したあとの
// 「元がありません」——そして**値がどこにも出ない**こと（規則14）
test("一覧の行から参照を作ると、参照の行に「→ 元」が出て、元を消すと「元がありません」になる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-link-"));
  const stamp = Date.now();
  const origin = `e2e-link-origin-${stamp}`;
  // **長い名前で試す**——実機では名前が畳まれて「→ 元」が見えなかった（2026-10-05）
  const linkName = `${origin}-REFERENCE_WITH_A_LONG_NAME_LIKE_CLOUDFLARE_API_TOKEN_FOR_PRODUCTION`;
  const srcGroup = `e2e-linksrc-${stamp}`;
  const secret = `LINK-MUST-NOT-APPEAR-${stamp}`;
  const call = (server: string, tool: string, args: Record<string, unknown>) =>
    page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      data: { server, tool, arguments: args },
    });

  await openApp(page);
  await createProject(page, "E2E 参照", projectRoot);
  // 元は**どこにも紐付いていないグループ**に置く（この Project からは見えない）
  await call("vault-directory", "createGroup", { implementation: "vault-local", name: srcGroup });
  const created = await call("vault-directory", "createAlias", {
    implementation: "vault-local",
    name: origin,
    kind: "secret",
    value: secret,
    group: srcGroup,
  });
  expect(created.ok(), `元を置けなかった: ${await created.text()}`).toBe(true);

  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  // この Project の置き場を決める（最初に保存したときに決まる）
  const seed = `e2e-link-seed-${stamp}`;
  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(seed);
  await canvas.locator("#new-value").fill("seed");
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  await expect(canvas.locator("tbody tr").filter({ hasText: seed })).toBeVisible({ timeout: 120_000 });
  await expect(canvas.locator("#place-summary")).toContainText(" / ");
  const projectGroup = (await canvas.locator("#place-summary").innerText()).split(" / ").pop()!.trim();

  // 元はこの Project から使えないので、既定の絞り込みでは出ない——「すべて」にして元の行を出す
  await canvas.locator("#target-filter").selectOption("all");
  const originRow = canvas.locator("tbody tr").filter({ hasText: origin }).filter({ hasNotText: linkName });
  await expect(originRow).toHaveCount(1, { timeout: 30_000 });
  await expect(originRow, "元の行が未割当として出ていない").toContainText("未割当");

  // ---- 小窓：「移す」と同じ形 -----------------------------------------------
  expect(await rowMenuItems(canvas, originRow), "元の行のメニューの並びが違う").toEqual([
    "用途を編集",
    "値を変える",
    "秘密を移動",
    "参照を作る",
    "削除",
  ]);
  await expect(originRow.locator(".link-badge"), "参照でない行に「参照」の印が出ている").toHaveCount(0);
  await rowAction(canvas, originRow, "参照を作る");
  await expect(canvas.locator("#dlg-link")).toBeVisible();
  await expect(canvas.locator("#dlg-link .dialog-title")).toHaveText("この秘密を別の置き場から使えるようにする（参照）");
  await expect(canvas.locator("#link-now")).toHaveText(`元は vault-local / ${srcGroup} / ${origin}`);
  // **Vault は元と同じに固定**（参照は同じ Vault の中だけ）
  await expect(canvas.locator("#link-vault")).toBeDisabled();
  await expect(canvas.locator("#link-vault")).toHaveValue("vault-local");
  // 名前の既定は元と同じ、置き場の既定は「この Project」の置き場
  await expect(canvas.locator("#link-name")).toHaveValue(origin);
  await expect(canvas.locator("#link-group")).toHaveValue(projectGroup);
  // 選択肢の主は Vault での本当の名前、この Project の置き場は添え（2026-10-07）。vault-local は版を名乗らない
  await expect(canvas.locator(`#link-group option[value="${projectGroup}"]`)).toHaveText(`${projectGroup} — この Project`);
  await expect(canvas.locator("#link-variant")).toBeHidden();
  await expect(canvas.locator("#dlg-link")).toContainText(
    "値は写しません。元を変えればこちらも変わり、元を消すとこちらは使えなくなります",
  );
  await expect(canvas.locator("#link-effect")).toContainText("この Project からだけ使えます");
  // 元と同じ置き場・同じ名前は選ばせない
  await canvas.locator("#link-group").selectOption(srcGroup);
  await expect(canvas.locator("#link-effect")).toContainText("元と同じ置き場です");
  await expect(canvas.locator("#link-submit")).toBeDisabled();
  await canvas.locator("#link-group").selectOption(projectGroup);
  // 名前は変えられる
  await canvas.locator("#link-name").fill(linkName);
  await expect(canvas.locator("#link-submit")).toBeEnabled();
  await canvas.locator("#link-submit").click();
  // **成功したときにだけ起きること＝小窓が閉じる**（規則14）
  await expect(canvas.locator("#dlg-link"), "参照を作れずに小窓が開いたまま").toBeHidden({ timeout: 60_000 });

  // ---- 参照の行：中身を1つずつ見る -------------------------------------------
  const linkRow = canvas.locator("tbody tr").filter({ hasText: linkName });
  await expect(linkRow, "作った参照が一覧に出てこない").toHaveCount(1, { timeout: 60_000 });
  // **一目で参照と分かる**（改訂・2026-10-05、ユーザー指摘）——名前の前に「参照」の印、2行目に
  // 「→ 元」。名前は長くしてあるので畳まれる。**畳まれても印と「→」は見えている**こと
  const nameTd = linkRow.locator("td").nth(1);
  await expect(linkRow.locator(".name-text")).toHaveText(linkName);
  expect(
    await linkRow.locator(".name-text").evaluate((e) => e.scrollWidth > e.clientWidth),
    "名前が畳まれていない（長い名前の場合を試せていない）",
  ).toBe(true);
  await expect(linkRow.locator(".link-badge")).toHaveText("参照");
  await expectWithin(linkRow.locator(".link-badge"), nameTd, "「参照」の印が見えない（畳まれて切れている）");
  await expect(linkRow.locator(".link-target")).toHaveText(`→ ${srcGroup} / ${origin}`);
  await expectWithin(linkRow.locator(".link-target"), nameTd, "2行目の「→ 元」が見えない");
  await expect(linkRow.locator(".link-broken"), "元が在るのに「元がありません」と出ている").toHaveCount(0);
  await expect(linkRow.locator("td").nth(0), "種別が元から導かれていない").toHaveText("シークレット");
  await expect(linkRow.locator("td").nth(2), "使える範囲がこの Project になっていない").toHaveText("この Project");
  await expect(linkRow.locator("td").nth(4), "参照のグループが違う").toHaveText(projectGroup);
  // **参照の参照は作らない**——押せるのに断られる項目を置かない
  expect(await rowMenuItems(canvas, linkRow), "参照の行のメニューの並びが違う").toEqual(["用途を編集", "値を変える", "秘密を移動", "削除"]);
  // **参照の「移す」は元の Vault に固定**——別の Vault へは必ず断られるので選ばせない
  await rowAction(canvas, linkRow, "秘密を移動");
  await expect(canvas.locator("#dlg-move")).toBeVisible();
  await expect(canvas.locator("#move-vault"), "参照なのに Vault を選べる").toBeDisabled();
  await expect(canvas.locator("#move-vault")).toHaveValue("vault-local");
  expect(
    await canvas.locator("#move-vault option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)),
  ).toEqual(["vault-local"]);
  await canvas.locator("#dlg-move").getByRole("button", { name: "やめる" }).click();
  await expect(canvas.locator("#dlg-move")).toBeHidden();
  // 既定の絞り込み（この Project から使える）に戻すと、参照は出て、元は出ない
  await canvas.locator("#target-filter").selectOption("usable");
  await expect(canvas.locator("tbody tr").filter({ hasText: linkName })).toHaveCount(1);
  await expect(canvas.locator("tbody tr").filter({ hasText: origin }).filter({ hasNotText: linkName })).toHaveCount(0);

  // backend の台帳にも、指す先として載っている
  const listed = JSON.parse(
    (JSON.parse(await (await call("vault-local", "listAliases", {})).text()) as { content: { text: string }[] })
      .content[0]!.text,
  ) as Array<{ name: string; group: string; linkTo?: { group: string; name: string } }>;
  expect(listed.find((a) => a.name === linkName)?.linkTo).toEqual({ group: srcGroup, name: origin });

  // ---- 元を消す：確認で参照の件数が出て、消したあとは「元がありません」 ---------
  await canvas.locator("#target-filter").selectOption("all");
  await rowAction(canvas, originRow, "削除");
  await expect(canvas.locator("#delete-links")).toHaveText(
    `この秘密を指す参照が 1 件あり、使えなくなります（${projectGroup} / ${linkName}）`,
  );
  await canvas.locator("#delete-submit").click();
  await expect(canvas.locator("#dlg-delete")).toBeHidden({ timeout: 60_000 });
  await expect(originRow).toHaveCount(0, { timeout: 30_000 });
  await expect(linkRow.locator(".link-target")).toHaveText(`→ ${srcGroup} / ${origin}`);
  await expect(linkRow.locator(".link-broken"), "元が消えたことが参照の行に出ていない").toHaveText("元がありません");
  await expectWithin(linkRow.locator(".link-broken"), nameTd, "「元がありません」が見えない（畳まれて切れている）");
  await expectWithin(linkRow.locator(".link-badge"), nameTd, "元が消えたら「参照」の印が見えなくなった");
  await expect(linkRow.locator("td").nth(0), "元が無いのに種別を推測している").toHaveText("—");
  // 参照を消す確認は「参照だけを消す」と言う
  await rowAction(canvas, linkRow, "削除");
  await expect(canvas.locator("#delete-effect")).toHaveText(
    `参照だけを消します。元の秘密（${srcGroup} / ${origin}）は残ります`,
  );
  await expect(canvas.locator("#delete-links")).toBeHidden();
  await canvas.locator("#delete-submit").click();
  await expect(canvas.locator("#dlg-delete")).toBeHidden({ timeout: 60_000 });
  await expect(linkRow).toHaveCount(0, { timeout: 30_000 });

  // **値はどこにも出ない**
  expect(await page.content()).not.toContain(secret);
  await call("vault-directory", "deleteAlias", { implementation: "vault-local", name: seed, group: projectGroup });
});

// **行のメニューの作法と、表の幅**（追加・2026-10-05、ユーザー指摘）。
// メニュー：開くと最初の項目に焦点、↑↓で移る（端で回る）、Esc で閉じて「…」に焦点が戻る、
// 外を押しても閉じる、項目を選ぶとその処理が開く。表：狭い Canvas でも横にはみ出さない
test("行の「…」のメニューはキーボードで操作でき、狭い Canvas でも表が横にはみ出さない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-vault-menu-"));
  const stamp = Date.now();
  const alias = `e2e-vault-menu-${stamp}`;
  const group = `e2e-vault-menu-${stamp}`;
  const call = (tool: string, args: Record<string, unknown>) =>
    page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      data: { server: "vault-directory", tool, arguments: args },
    });

  await openApp(page);
  await createProject(page, "E2E Vault メニュー", projectRoot);
  await call("createGroup", { implementation: "vault-local", name: group });
  const created = await call("createAlias", {
    implementation: "vault-local",
    name: alias,
    kind: "secret",
    value: `MENU-MUST-NOT-APPEAR-${stamp}`,
    group,
    note: "メニューの試験",
  });
  expect(created.ok(), `置けなかった: ${await created.text()}`).toBe(true);
  // 種別の badge の収まりを、シークレット以外でも見る
  const fileAlias = `${alias}-file`;
  const createdFile = await call("createAlias", {
    implementation: "vault-local",
    name: fileAlias,
    kind: "file",
    value: `MENU-MUST-NOT-APPEAR-${stamp}`,
    group,
  });
  expect(createdFile.ok(), `置けなかった: ${await createdFile.text()}`).toBe(true);
  // **2つの Project に紐付けても「この Project」**（改訂・2026-10-06、ユーザー指示）。以前は
  // 「<Project 名> ほか」と出ていた。この Project と、もう1つの Project を同じグループへ向ける
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const here = projects.filter((p) => p.name === "E2E Vault メニュー").pop();
  expect(here, "この Project の id が引けない").toBeTruthy();
  const otherRes = await page.request.post(`${CORE_BASE_URL}/api/projects`, {
    headers,
    data: { name: "E2E Vault メニュー（もう1つ）", root: mkdtempSync(join(tmpdir(), "banto-e2e-vault-menu-other-")) },
  });
  expect(otherRes.ok(), `もう1つの Project を作れない: ${await otherRes.text()}`).toBe(true);
  const other = (await otherRes.json()) as { id: string };
  for (const projectId of [here!.id, other.id]) {
    const bound = await call("setProjectPlacement", { projectId, implementation: "vault-local", group, migrate: false });
    expect(bound.ok(), `グループに紐付けられない: ${await bound.text()}`).toBe(true);
  }

  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });
  await canvas.locator("#target-filter").selectOption("all");
  const row = canvas.locator("tbody tr").filter({ hasText: alias }).filter({ hasNotText: fileAlias });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  const fileRow = canvas.locator("tbody tr").filter({ hasText: fileAlias });
  await expect(fileRow).toHaveCount(1);

  // ---- 使える範囲は「この Project」——紐付いている Project の数によらない（2026-10-06）----
  const target = row.locator("td").nth(2).locator(".badge");
  await expect(target, "2つの Project に紐付いた行が「この Project」になっていない").toHaveText("この Project");
  await expect(target, "いくつの Project から使えるかが指で読めない").toHaveAttribute(
    "title",
    "この Project を含む 2 つの Project から使えます",
  );
  // 絞り込みの選択肢も同じ言葉（Project 名・「ほか」を出さない）
  const targetOptions = await canvas.locator("#target-filter option").allInnerTexts();
  expect(targetOptions, "絞り込みに「この Project」が無い").toContain("この Project");
  expect(
    targetOptions.filter((o) => o.includes("ほか") || o.includes("E2E Vault メニュー")),
    `絞り込みに Project 名が出ている: ${JSON.stringify(targetOptions)}`,
  ).toEqual([]);
  await canvas.locator("#target-filter").selectOption({ label: "この Project" });
  await expect(canvas.locator("tbody tr").filter({ hasText: alias }), "「この Project」で絞ると出ない").toHaveCount(2);
  await canvas.locator("#target-filter").selectOption("all");

  // ---- Vault が1本なら、見出しもセルも Vault の列を畳む（列がずれない、2026-10-06）----
  // 以前は見出しだけが隠れ、セルは残って列が1つずれていた（「使える範囲」の下に Vault の名前）
  await expect(canvas.locator("#impls .chip"), "Vault が1本の条件で試せていない").toHaveCount(1);
  await expect(canvas.locator("#vault-col")).toBeHidden();
  await expect(row.locator("td").nth(3), "Vault のセルが隠れていない").toBeHidden();
  expect(await visibleCount(row.locator("td")), "見出しとセルの数が揃っていない").toBe(
    await visibleCount(canvas.locator("thead th")),
  );
  const headerX = (await canvas.locator("thead th").nth(2).boundingBox())!.x;
  const cellX = (await row.locator("td").nth(2).boundingBox())!.x;
  expect(Math.abs(headerX - cellX), `「使える範囲」の見出しとセルがずれている（${headerX} / ${cellX}）`).toBeLessThan(1);

  // ---- 狭い Canvas でも、表が横にはみ出さない（このあとのメニューも狭いまま試す）----
  // 画面の幅を変えて、Canvas の中の幅が 840px 前後から 500px 前後までで見る
  // （実測・2026-10-05：画面 1500px → Canvas 839px、1280px → 693px、1000px → 506px）
  const width = () => canvas.locator("html").evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
  for (const viewport of [1500, 1280, 1000]) {
    await page.setViewportSize({ width: viewport, height: 800 });
    await expect
      .poll(async () => {
        const w = await width();
        return w.scroll <= w.client ? "fits" : `はみ出す（${w.scroll} > ${w.client}）`;
      }, { message: `画面幅 ${viewport}px で表が横にはみ出す` })
      .toBe("fits");
    console.log(`[vault-menu] viewport ${viewport}px → Canvas の中の幅 ${(await width()).client}px`);
    // **badge が列に収まる**（2026-10-06）——「シークレット」が隣の列へはみ出していた
    for (const r of [row, fileRow]) {
      await expectFitsCell(r.locator("td").nth(0).locator(".badge"), r.locator("td").nth(0), `画面幅 ${viewport}px で種別の badge が列からはみ出す`);
      await expectFitsCell(r.locator("td").nth(2).locator(".badge"), r.locator("td").nth(2), `画面幅 ${viewport}px で使える範囲の badge が列からはみ出す`);
    }
  }
  await expect(fileRow.locator("td").nth(0)).toHaveText("ファイル");
  await expect(row.locator("td").nth(0)).toHaveText("シークレット");

  const more = row.getByRole("button", { name: `${alias} の操作` });
  const menu = canvas.getByRole("menu");
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await expect(more).toHaveAttribute("aria-expanded", "false");

  // ---- 開くと最初の項目に焦点、↑↓で移る -----------------------------------
  await more.click();
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["用途を編集", "値を変える", "秘密を移動", "参照を作る", "削除"]);
  await expect(menu.getByRole("menuitem", { name: "用途を編集" }), "開いても最初の項目に焦点が来ない").toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "値を変える" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "削除" }), "↑で端から回らない").toBeFocused();

  // ---- Esc で閉じて「…」に焦点が戻る ---------------------------------------
  await page.keyboard.press("Escape");
  await expect(menu, "Esc でメニューが閉じない").toHaveCount(0);
  await expect(more, "閉じたあと「…」に焦点が戻らない").toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");

  // ---- 外を押しても閉じる ---------------------------------------------------
  await more.click();
  await expect(menu).toBeVisible();
  await canvas.locator("h1").click();
  await expect(menu, "外を押してもメニューが閉じない").toHaveCount(0);

  // ---- 項目を選ぶと、その処理が開く（キーボードで） -------------------------
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem", { name: "用途を編集" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(canvas.locator("#dlg-note"), "用途の小窓が開かない").toBeVisible();
  await expect(canvas.locator("#note-target")).toHaveText(`vault-local / ${alias}`);
  await expect(canvas.locator("#note-text")).toHaveValue("メニューの試験");
  await canvas.locator("#dlg-note").getByRole("button", { name: "やめる" }).click();
  await expect(canvas.locator("#dlg-note")).toBeHidden();

  expect(await page.content()).not.toContain(`MENU-MUST-NOT-APPEAR-${stamp}`);
  await call("deleteAlias", { implementation: "vault-local", name: alias, group });
  await call("deleteAlias", { implementation: "vault-local", name: fileAlias, group });
});

// **値を変える・グループを作る**（2026-10-07、ユーザー）を、本物の banto で——Canvas → 窓口 → 中継 → vault-local。
// 値そのものは画面 API から読めない（resolveAlias は人の画面からも 403、vault-visibility.spec）ので、**届いたことは SSH 鍵で
// 確かめる**：手元で作った鍵を貼り、backend が秘密鍵から導く公開鍵が手元の公開鍵と一致すれば、貼った値が Vault に入っている。
// 作り直し（regenerate）は公開鍵が変わること、一覧の行に値を変えた日時が出ること、移すの小窓で作ったグループへ実際に移ることを見る
test("値を変える・グループを作る：SSH 鍵を作り直す／貼ると公開鍵が変わり、行に日時が出る。移すの小窓で作ったグループへ移せる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-vault-edit-"));
  const stamp = Date.now();
  const key = `e2e-edit-key-${stamp}`;
  const secret = `e2e-edit-secret-${stamp}`;
  const newGroup = `e2e-made-${stamp}`;
  const call = (server: string, tool: string, args: Record<string, unknown>) =>
    page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      data: { server, tool, arguments: args },
    });
  const listed = async (): Promise<Array<Record<string, unknown>>> => {
    const outer = JSON.parse(await (await call("vault-local", "listAliases", {})).text()) as { content: { text: string }[] };
    return JSON.parse(outer.content[0]!.text) as Array<Record<string, unknown>>;
  };
  // 公開鍵の本体（種類と鍵）。注記は比べない
  const body = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(" ");

  await openApp(page);
  await createProject(page, "E2E Vault 値を変える", projectRoot);
  await openPaletteEntry(page, /Vault を管理/);
  await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

  // ---- SSH 鍵を作る（この Project の置き場）----------------------------------------------------
  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(key);
  await canvas.locator("#new-kind").selectOption("ssh-identity");
  await canvas.locator("#new-source").selectOption("generated");
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const pubkey = canvas.locator("#pubkey-text");
  await expect(pubkey).toBeVisible({ timeout: 120_000 });
  const first = await pubkey.inputValue();
  expect(first).toMatch(/^ssh-ed25519 AAAA/);
  await canvas.getByRole("button", { name: "閉じる", exact: true }).click();
  const keyRow = canvas.locator("tbody tr").filter({ hasText: key });
  await expect(keyRow).toBeVisible({ timeout: 60_000 });
  await expect(keyRow.locator(".updated-line"), "まだ変えていないのに日時が出ている").toHaveCount(0);

  // ---- 作り直す：注意が出て、新しい公開鍵が出る ------------------------------------------------
  await rowAction(canvas, keyRow, "値を変える");
  await expect(canvas.locator("#value-ssh-warn")).toContainText("相手（GitHub など）に登録した公開鍵と合わなくなります");
  await canvas.locator("#value-source").selectOption("generated");
  await canvas.locator("#value-submit").click();
  await expect(canvas.locator("#value-error"), "作り直しでエラーが出た").toBeHidden();
  await expect(canvas.locator("#pubkey-title")).toHaveText(`新しい公開鍵：${key}`, { timeout: 120_000 });
  const second = await pubkey.inputValue();
  expect(second).toMatch(/^ssh-ed25519 AAAA/);
  expect(body(second), "作り直したのに公開鍵が前のまま").not.toBe(body(first));
  await canvas.getByRole("button", { name: "閉じる", exact: true }).click();
  // 行に値を変えた日時。あとから読む公開鍵も新しいもの（backend が秘密鍵から導く）
  await expect(keyRow.locator(".updated-line"), "値を変えた日時が行に出ない").toHaveText(/^値を変更 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/, { timeout: 60_000 });
  await rowAction(canvas, keyRow, "公開鍵を表示");
  await expect.poll(() => pubkey.inputValue(), { timeout: 30_000 }).toBe(second);
  await canvas.getByRole("button", { name: "閉じる", exact: true }).click();

  // ---- 貼る：手元で作った鍵を貼ると、backend の公開鍵が手元の公開鍵になる -----------------------
  const keyDir = mkdtempSync(join(tmpdir(), "banto-e2e-key-"));
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", join(keyDir, "id"), "-N", "", "-q", "-C", "e2e"]);
  const privateKey = readFileSync(join(keyDir, "id"), "utf8");
  const localPub = readFileSync(join(keyDir, "id.pub"), "utf8");
  await rowAction(canvas, keyRow, "値を変える");
  await expect(canvas.locator("#value-source")).toHaveValue("typed");
  await canvas.locator("#value-multiline").fill(privateKey);
  await canvas.locator("#value-submit").click();
  await expect(canvas.locator("#pubkey-title")).toHaveText(`新しい公開鍵：${key}`, { timeout: 120_000 });
  expect(body(await pubkey.inputValue()), "貼った鍵が Vault に入っていない（公開鍵が手元のものと違う）").toBe(body(localPub));
  await canvas.getByRole("button", { name: "閉じる", exact: true }).click();
  await rowAction(canvas, keyRow, "公開鍵を表示");
  await expect.poll(async () => body(await pubkey.inputValue()), { timeout: 30_000 }).toBe(body(localPub));
  await canvas.getByRole("button", { name: "閉じる", exact: true }).click();
  // 貼った秘密鍵は、画面のどこにも残っていない
  const domValues = await canvas.locator("input, textarea").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(domValues.some((v) => v.includes("PRIVATE KEY") && v.includes(privateKey.split("\n")[1]!)), "貼った秘密鍵が DOM に残っている").toBe(false);

  // ---- secret の値を変える → 台帳に日時 ---------------------------------------------------------
  await canvas.getByRole("button", { name: "＋ 秘密を登録" }).click();
  await canvas.locator("#new-name").fill(secret);
  await canvas.locator("#new-value").fill(`OLD-${stamp}`);
  await canvas.locator("#new-scope").selectOption({ index: 0 });
  await canvas.getByRole("button", { name: "登録する" }).click();
  const secretRow = canvas.locator("tbody tr").filter({ hasText: secret });
  await expect(secretRow).toBeVisible({ timeout: 120_000 });
  await rowAction(canvas, secretRow, "値を変える");
  await canvas.locator("#value-input").fill(`NEW-${stamp}`);
  await canvas.locator("#value-submit").click();
  await expect(canvas.locator("#dlg-value"), "値を変えられずに小窓が開いたまま").toBeHidden({ timeout: 60_000 });
  await expect(secretRow.locator(".updated-line")).toHaveText(/^値を変更 /, { timeout: 60_000 });
  const secretMeta = (await listed()).find((a) => a.name === secret);
  expect(secretMeta?.valueUpdatedAt, `台帳に日時が無い: ${JSON.stringify(secretMeta)}`).toBeTruthy();
  expect(JSON.stringify(await listed())).not.toContain(`NEW-${stamp}`);
  expect(await page.content()).not.toContain(`NEW-${stamp}`);

  // ---- 移すの小窓でグループを作って、そこへ移す --------------------------------------------------
  await rowAction(canvas, secretRow, "秘密を移動");
  await canvas.locator("#move-group").selectOption("__new-group__");
  await expect(canvas.locator("#move-newgroup")).toBeVisible();
  // vault-local は添え書きを名乗らない
  await expect(canvas.locator("#move-newgroup-note")).toBeHidden();
  await canvas.locator("#move-newgroup-name").fill(newGroup);
  await canvas.locator("#move-newgroup-create").click();
  await expect(canvas.locator("#move-group"), "作ったグループが選ばれていない").toHaveValue(newGroup, { timeout: 60_000 });
  await expect(canvas.locator("#move-error")).toBeHidden();
  await expect(canvas.locator("#move-effect")).toContainText("頭に付けて引きます");
  await canvas.locator("#move-submit").click();
  await expect(canvas.locator("#dlg-move"), "移せずに小窓が開いたまま").toBeHidden({ timeout: 60_000 });
  // 移した先はどの Project にも紐付いていない（未割当）——既定の絞り込み（この Project から使える）では隠れるので、すべてを出す
  await canvas.locator("#target-filter").selectOption("all");
  await expect(secretRow.locator("td").nth(4), "移した先のグループが一覧に出ない").toHaveText(newGroup, { timeout: 60_000 });
  await expect(secretRow.locator("td").nth(2)).toHaveText("未割当");
  const moved = (await listed()).find((a) => a.name === secret);
  expect(moved?.group, `移した先が違う: ${JSON.stringify(moved)}`).toBe(newGroup);
  // 置き換えた日時は行ごと移る
  expect(moved?.valueUpdatedAt).toBe(secretMeta!.valueUpdatedAt);

  const keyMeta = (await listed()).find((a) => a.name === key);
  await call("vault-directory", "deleteAlias", { implementation: "vault-local", name: secret, group: newGroup });
  await call("vault-directory", "deleteAlias", { implementation: "vault-local", name: key, group: keyMeta?.group });
});

// **banto 全体の設定画面の「作る」も、「@」を含むグループ名を断る**（2026-10-07、レビュー）。設定画面（Global の置き場）の
// 作る入口は管理画面と同じ窓口の createGroup を通るので、窓口で断れば両方に効く——それを本物の画面で確かめる。
// 断ったあとは選択肢にも Vault にも出ない。ふつうの名前は作れて、そのまま選ばれる（窓口の中継＝admin の刻印で通る）
test("設定画面の「作る」：「@」を含むグループ名は理由つきで断り、ふつうの名前は作れる", async ({ page }) => {
  const stamp = Date.now();
  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Vault の置き場", exact: true }).click();
  const inner = page
    .locator('[data-testid="module-settings-canvas"][data-module="vault-directory"] iframe')
    .contentFrame()
    .frameLocator("iframe");
  await expect(inner.getByText("Global の秘密の置き場")).toBeVisible({ timeout: 60_000 });
  await expect(inner.locator("#vault")).toContainText("vault-local", { timeout: 60_000 });
  await inner.locator("#vault").selectOption("vault-local");

  await inner.locator("#new-group").fill(`e2e-at@${stamp}`);
  await inner.locator("#create").click();
  await expect(inner.locator("#error")).toContainText("グループ名に「@」は使えません", { timeout: 60_000 });
  await expect(inner.locator(`#group option[value="e2e-at@${stamp}"]`)).toHaveCount(0);
  await expect(inner.locator(`#group option[value="e2e-at"]`)).toHaveCount(0);

  const made = `e2e-settings-${stamp}`;
  await inner.locator("#new-group").fill(made);
  await inner.locator("#create").click();
  await expect(inner.locator("#group"), "作ったグループが選ばれない").toHaveValue(made, { timeout: 60_000 });
  await expect(inner.locator("#error")).toBeHidden();
});
