// Module が描く画面を、会話の中に埋める（MCP Apps の inline、§6.2）。
//
// 見るのは2つ。**どちらも欠けたら意味が無い**：
//   1. 画面が出て、**中身が本物**であること（規則14——「枠が出た」で終わらせない。
//      その場に無いはずのファイル名が、Module の画面に並ぶところまで見る）
//   2. **できてはいけないことができない**こと
//      - 画面は banto とは**別オリジン**で動いていて、banto の保存領域
//        （host の合言葉が入っている）に手が届かない
//      - 画面が呼べるのは**自分の Module だけ**（呼び先は画面が選べない）
//
// **画面からの呼び出しに承認は求めない**（改訂・2026-09-07、ユーザー指示）
// ——その画面を開いたのは人。AI からの呼び出しは今までどおりゲートを通る。
import { test, expect, type Frame } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, SANDBOX_BASE_URL, FRONTEND_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Canvas Project";
const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

test("Module の画面が会話の中に出て、隔離が効いている", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-canvas-"));
  // 画面に**実際に出たか**を見分けるための一意な名前
  const marker = `canvas-marker-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, marker), "見えているはず\n");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("filesystem の listDirectory で、このプロジェクトの直下（.）の一覧を取ってください。");
  await composer.press("Enter");

  // 1回目の承認（AI から）
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  // ---- 1. 画面が出て、中身が本物 ------------------------------------------
  const embed = page.locator('[data-testid="inline-module-view"]');
  await expect(embed).toBeVisible({ timeout: 120_000 });
  await expect(embed).toHaveAttribute("data-module", "filesystem");

  // **tool コールの折りたたみの外にある**（決定・2026-09-07、ユーザー指摘）。
  // 「見えている」だけでは足りない——人が畳んでも消えないことまで見る
  // （中に入れると、畳んだ瞬間に出したはずの画面が消える）
  const toolGroup = page.getByRole("button", { name: /tool calls?/ });
  await toolGroup.click();
  await expect(embed, "tool コールを畳んだら画面が消えた").toBeVisible();
  await toolGroup.click();

  // この Project の Thread（host 側の記録を見るのに使う）
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
  ).json();
  const threadId: string = threads[0].id;

  const outer = page.frameLocator('[data-testid="module-canvas-frame"]');
  // 外側は**サンドボックスの口**から配られている（別オリジン）
  const outerFrame = await waitForFrame(page, (f) => f.url().startsWith(SANDBOX_BASE_URL));
  expect(outerFrame, "サンドボックスの口から配られていない").toBeTruthy();

  // 内側（Module の HTML）に、その場に実在するファイル名が並んでいる
  const inner = outer.frameLocator("iframe");
  await expect(inner.getByText(marker)).toBeVisible({ timeout: 60_000 });

  // ---- 2-a. banto の中身に手が届かない ------------------------------------
  // 画面は別オリジンなので、banto の保存領域（host の合言葉が入っている）は
  // そもそも見えない。**見えないことを直接確かめる**（規則14）
  const innerFrame = await waitForFrame(
    page,
    (f) => f.parentFrame()?.url().startsWith(SANDBOX_BASE_URL) === true,
  );
  expect(innerFrame, "内側のフレームが見つからない").toBeTruthy();

  const reach = await innerFrame!.evaluate(() => {
    const result = { keys: [] as string[], topReachable: false };
    try {
      result.keys = Object.keys(window.localStorage);
    } catch {
      // 読めないなら、なお良い
    }
    try {
      void window.top!.location.href;
      result.topReachable = true;
    } catch {
      result.topReachable = false;
    }
    return result;
  });
  expect(reach.topReachable, "**画面から banto の画面に手が届いている**").toBe(false);
  expect(reach.keys, "banto の保存領域が画面から見えている").not.toContain("banto.backend");

  // ---- 2-b. 画面からの tool 呼び出し（自分の Module なので承認は出ない）----
  const openBefore = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: HEADERS })).json())
    .length;

  // **ターンが本当に終わってから押す**（人と同じ順番）。終わる前に押すと、
  // ターンが「走行中」のままなので**実機で起きる組み直しが起きない**
  // ——テストだけ通ってしまう（実測・2026-09-07）。
  // host が会話を記録した時点＝ターンの終わり
  await expect
    .poll(
      async () => {
        const th = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })
        ).json();
        return (th.messages ?? []).filter((m: { role: string }) => m.role === "assistant").length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  // **会話が組み直されていないこと**を、要素そのもので見る（決定・2026-09-07、
  // ユーザー報告）。「見えている」だけでは、いったん消えて作り直されても通って
  // しまう——実機ではまさにそれが起きた（会話が消える→承認→会話は戻るが
  // 画面は消える）。同じ要素が生き続けていることを確かめる
  const embedHandle = await embed.elementHandle();
  const frameHandle = await page.locator('[data-testid="module-canvas-frame"]').elementHandle();

  await inner.getByRole("button", { name: "この場所を読み直す" }).click();

  // **承認は出ない**（改訂・2026-09-07、ユーザー指示）——その画面を開いたのは人で、
  // 画面のボタンがその画面を出している Module 自身の tool を呼ぶのは、画面が
  // 仕事をしているだけ。**AI からの呼び出しは今までどおりゲートを通る**
  // （judgment-deny / permission-mode の spec が見ている）
  await expect(page.locator('[data-testid="canvas-approval"]')).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const open = await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: HEADERS })).json();
        return open.length;
      },
      { timeout: 10_000 },
    )
    .toBe(openBefore);

  // 承認を待っている間も、会話も画面もそのまま生きている
  expect(
    await embedHandle!.evaluate((el) => el.isConnected),
    "**承認待ちの間に会話が組み直された**（画面が作り直されている）",
  ).toBe(true);
  await expect(page.getByText(/このプロジェクトの直下/)).toBeVisible();

  // 押しただけで結果が描き直される（待たされない）
  await expect(inner.getByText(marker)).toBeVisible({ timeout: 30_000 });

  // 呼び出しの後も、**同じ iframe が生きている**（作り直されていない）
  expect(
    await frameHandle!.evaluate((el) => el.isConnected),
    "**呼び出しの後に会話が組み直された**（MCP Apps の表示が消える）",
  ).toBe(true);
  await expect(page.getByText(/このプロジェクトの直下/)).toBeVisible();

  // ---- 3. リロードしても画面は残る（決定・2026-09-07、ユーザー報告）--------
  // 会話は host の記録から組み直されるので、**記録に tool 呼び出しが残って
  // いないと画面だけが消える**。中身（実在するファイル名）まで見る
  await page.reload();
  const embedAfterReload = page.locator('[data-testid="inline-module-view"]');
  await expect(embedAfterReload, "リロードしたら Module の画面が消えた").toBeVisible({ timeout: 30_000 });
  await expect(embedAfterReload).toHaveAttribute("data-module", "filesystem");
  await expect(
    page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe").getByText(marker),
    "リロード後、画面の中身が出ていない",
  ).toBeVisible({ timeout: 60_000 });

  // ---- 4. 画面が「大きく出して」と言ったら、会話の隣に開く（§6.2）----------
  // **会話は消えない**——banto は fullscreen を「会話の隣の最大の領域」に
  // 割り当てている（仕様の fullscreen は host の全面だが、banto の解釈）
  await page
    .frameLocator('[data-testid="module-canvas-frame"]')
    .frameLocator("iframe")
    .getByRole("button", { name: "大きく表示" })
    .click();

  // Canvas が開き、その中に**本物の中身**が出ている
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
  const canvasFrames = page.locator('[data-testid="module-canvas-frame"]');
  // **同じ画面が2箇所に出ない**（決定・2026-09-07、ユーザー要望）。大きく出した
  // 時点で、会話の側は入口のカードに畳む——会話に埋めたままだと、記録から
  // 組み直すたびにその画面がまた「大きく出して」と言い、勝手に開く
  await expect(canvasFrames).toHaveCount(1, { timeout: 30_000 });
  await expect(
    page.locator('[data-testid="canvas-reopen-card"][data-module="filesystem"]'),
    "会話に入口のカードが残っていない",
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    canvasFrames.last().contentFrame().frameLocator("iframe").getByText(marker),
    "Canvas に中身が出ていない",
  ).toBeVisible({ timeout: 60_000 });

  // **会話は消えない**（banto の fullscreen は「会話の隣」——§6.2 の解釈）
  await expect(page.getByText(/このプロジェクトの直下/), "Canvas を開いたら会話が消えた").toBeVisible();

  // URL に残っているので、**リロードしても同じ面が開き直る**
  // （閉じてから開き直さないこととは別——`勝手に開かない` は下の fullscreen の spec で見る）
  await page.reload();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });

  // ---- 5. 別タブで開いても中身が出る（決定・2026-09-07、ユーザー報告）------
  // **別タブは手元の記憶を持たない**ので、host の記録から引き直す必要がある。
  // 以前はモックの固定データを描いていて、実 Module の画面が出なかった
  // 「全画面」「別タブで開く」は**携帯幅では出さない**作り（モックが決めた形）
  // ——ここだけ広げて確かめる。**全画面にしなくても別タブへ出せる**
  // （改訂・2026-09-07、ユーザー要望——会話の隣で見ているときこそ
  //   「別の窓で見たい」が起きる）
  await page.setViewportSize({ width: 1280, height: 900 });
  const [tab] = await Promise.all([
    // `noopener` で開くので popup ではなく、この文脈の新しいページとして現れる
    page.context().waitForEvent("page"),
    page.getByRole("button", { name: "別タブで開く" }).click(),
  ]);
  await expect(
    tab.locator('[data-testid="canvas-window-module"][data-module="filesystem"]'),
    "別タブに Module の画面が出ていない",
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    tab.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe").getByText(marker),
    "別タブで中身が出ていない",
  ).toBeVisible({ timeout: 60_000 });
  // **元のタブ側は畳む**——同じものが2箇所に開いたままだと紛らわしい
  // （決定・2026-09-07、ユーザー要望）
  await expect(
    page.getByText(/^Canvas — filesystem$/),
    "別タブへ出したのに元の Canvas が開いたまま",
  ).toBeHidden({ timeout: 15_000 });
  await tab.close();

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("「フルスクリーンで開いて」と頼むと、最初から会話の隣に開く", async ({ page }) => {
  // 仕様には「最初からこの mode で開く」を宣言する場所が無い（`_meta` にも無い）。
  // 用意されているのは `ui/request-display-mode`（画面が頼み、host が決める）だけ。
  // そこで **tool の引数**として受け取り、画面が立ち上がった直後にそれを頼む
  // ——これで AI が人の言葉に応えられる（決定・2026-09-07、ユーザー要望）。
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-canvas-fs-"));
  const marker = `fullscreen-marker-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, marker), "大きく出るはず\n");

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Canvas Fullscreen");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText("Base Thread — E2E Canvas Fullscreen")).toBeVisible({ timeout: 15_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("このプロジェクトの直下（.）の一覧を、フルスクリーンで開いて。");
  await composer.press("Enter");

  // **人は「フルスクリーンで」としか言っていない**——ボタンは押さない
  await expect(page.getByText(/^Canvas — filesystem$/), "頼んでも Canvas が開かなかった").toBeVisible({
    timeout: 120_000,
  });
  await expect(
    page.locator('[data-testid="module-canvas-frame"]').last().contentFrame().frameLocator("iframe").getByText(marker),
    "Canvas に中身が出ていない",
  ).toBeVisible({ timeout: 60_000 });

  // **ターンが終わってから触る**（規則14・実測・2026-09-07）。画面が開くのは
  // tool の結果が届いた瞬間で、そこからAIの返事が続く——終わる前にリロードすると
  // host にはまだ発言が記録されておらず、「復元しても出ない」のはテストの手順の
  // せいになる
  const fsProjects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const fsProject = fsProjects.find((p: { name: string }) => p.name === "E2E Canvas Fullscreen");
  const fsThreads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${fsProject.id}/threads`, { headers: HEADERS })
  ).json();
  await expect
    .poll(
      async () => {
        const th = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${fsThreads[0].id}`, { headers: HEADERS })
        ).json();
        return (th.messages ?? []).filter((m: { role: string }) => m.role === "assistant").length;
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);

  // ---- 閉じたら、会話には入口（カード）が残る -------------------------------
  // **勝手に開いてよいのは、tool が呼んだその一度だけ**（決定・2026-09-07、
  // ユーザー指摘）。以前は復元した画面が毎回「大きく出して」と言い直し、
  // リロードのたびに Canvas が開いていた
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeHidden();
  const card = page.locator('[data-testid="canvas-reopen-card"][data-module="filesystem"]');
  await expect(card, "会話に入口のカードが残っていない").toBeVisible();

  // リロードしても**開かない**——カードだけが残る
  await page.reload();
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 30_000 });
  await expect(card, "リロードで入口のカードが消えた").toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(/^Canvas — filesystem$/),
    "リロードしただけで Canvas が勝手に開いた",
  ).toBeHidden();

  // 押すと、**同じ引数で**開き直る（中身が同じであることまで見る）
  await card.getByRole("button", { name: "開く" }).click();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="module-canvas-frame"]').last().contentFrame().frameLocator("iframe").getByText(marker),
    "カードから開き直した Canvas に中身が出ていない",
  ).toBeVisible({ timeout: 60_000 });
});

test("サンドボックスは、決めた相手以外には埋め込ませない", async ({ page }) => {
  // frame-ancestors は**中身を配る側**が決める。画面（4175）だけが入っている
  const res = await page.request.get(`${SANDBOX_BASE_URL}/sandbox.html`);
  expect(res.status()).toBe(200);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain(`frame-ancestors ${FRONTEND_BASE_URL}`);
  expect(csp).not.toContain("*");
  // この口では他に何も配らない
  expect((await page.request.get(`${SANDBOX_BASE_URL}/`)).status()).toBe(404);
});

/** 条件を満たすフレームが現れるまで待つ（読み込み順に依存しない）。 */
async function waitForFrame(
  page: import("@playwright/test").Page,
  match: (f: Frame) => boolean,
  timeoutMs = 60_000,
): Promise<Frame | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = page.frames().find(match);
    if (found) return found;
    await page.waitForTimeout(200);
  }
  return undefined;
}
