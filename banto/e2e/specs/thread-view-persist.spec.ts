// **会話の見え方は、面を開け閉めしても崩れない**（追加・2026-09-28、ユーザー報告）。
//
// 報告された症状：
//   1. Thread を開くと一番下（最新）ではなく、上のほうに出ることが多い
//   2. 最新のメッセージが消えることがある（リロードで直る）。Canvas や Fork を開いて閉じても起きる
//   3. Canvas・Fork を閉じたら、元の Thread のスクロール位置は保ってほしい
//   4. 書きかけのメッセージが、別のページ・設定・Fork を閉じる、で消える
//   5. 設定画面で Escape を押すと、1つ前の節に戻る（一発で設定から抜けてほしい）
//
// デスクトップ幅で見る——Base と Fork／Canvas が並ぶのはこの幅だけで、報告もこの幅のもの。
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, openApp, fakeTurn } from "../helpers.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 1280, height: 800 } });

// **回ごとに違う名前にする**——同じ名前が一覧に残っていると、作った Project が開く前に「開いた」と
// みなして、前の回の Project に送ってしまう（実測・--repeat-each で 5回中2回）
const PROJECT = `View Persist ${Date.now()}`;

/** 長い返事（画面に収まらない）。末尾に目印を置く */
function longReply(mark: string): string {
  return [...Array.from({ length: 40 }, (_, i) => `${mark} の ${i + 1} 行目`), `${mark}-END`].join("\n\n");
}

function baseComposer(page: Page): Locator {
  return page.getByPlaceholder(/Base Thread に送る$/);
}

/** その入力欄が属する会話の器のスクロール状態 */
async function scrollOf(composer: Locator): Promise<{ top: number; height: number; client: number; fromBottom: number }> {
  return composer.evaluate((el) => {
    const v = el.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!v) throw new Error("器が見つからない");
    return {
      top: v.scrollTop,
      height: v.scrollHeight,
      client: v.clientHeight,
      fromBottom: v.scrollHeight - v.scrollTop - v.clientHeight,
    };
  });
}

async function scrollTo(composer: Locator, top: number): Promise<void> {
  await composer.evaluate((el, t) => {
    const v = el.closest<HTMLElement>('[data-slot="aui_thread-viewport"]')!;
    v.scrollTo({ top: t, behavior: "instant" });
  }, top);
}

/** 1ターン送って、終わるまで待つ */
async function sendTurn(page: Page, composer: Locator, mark: string): Promise<void> {
  await composer.fill(`${mark} を返して${fakeTurn({ say: longReply(mark) })}`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: `${mark}-END` }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 30_000 });
}

/** 一番下（最新）が見えている。少しの誤差は許す */
async function expectAtBottom(composer: Locator, what: string): Promise<void> {
  await expect
    .poll(async () => (await scrollOf(composer)).fromBottom, { message: `${what}：一番下に居ない`, timeout: 10_000 })
    .toBeLessThan(8);
}

/** Command Palette の「Module の入口」からファイルの画面（Canvas）を開く——人が普段する開き方 */
async function openFilesCanvas(page: Page): Promise<void> {
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /ファイル/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByRole("button", { name: "Canvas を閉じる" })).toBeVisible({ timeout: 30_000 });
}

test("会話の位置・最新・下書きが、面の開け閉めとページの行き来で崩れない", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT, mkdtempSync(join(tmpdir(), "banto-e2e-")));
  const composer = baseComposer(page);

  await sendTurn(page, composer, "ONE");
  await sendTurn(page, composer, "TWO");
  // 送った直後は流れた吹き出しをそのまま見せている（組み直していない）——この状態から面を開け閉めする
  await sendTurn(page, composer, "THREE");
  const lastReply = page.locator('[data-role="assistant"]').filter({ hasText: "THREE-END" });

  // ── 症状2：設定へ行って戻ると、最新（流れたターン）が消える ──
  // ── 症状4：書きかけが消える ──
  await composer.fill("書きかけ-設定の往復");
  await page.getByRole("link", { name: "設定", exact: true }).click();
  await expect(page).toHaveURL(/\/settings/);
  await page.goBack();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(lastReply.first(), "設定から戻ったら最新の返事が消えた").toBeVisible({ timeout: 15_000 });
  await expect(composer, "設定から戻ったら書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  // ── 症状1：開いたら一番下 ──
  await expectAtBottom(composer, "設定から戻った直後");

  // ── 症状3：Fork を開いて閉じても、Base の位置と下書きはそのまま ──
  await scrollTo(composer, 600);
  const before = (await scrollOf(composer)).top;
  await page.getByRole("button", { name: "Fork を開く" }).click();
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await expect(forkComposer).toBeVisible({ timeout: 15_000 });
  await forkComposer.fill("Fork の書きかけ");
  await page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` }).click();
  await expect(forkComposer).toHaveCount(0);
  expect(Math.abs((await scrollOf(composer)).top - before), "Fork を閉じたら Base の位置が変わった").toBeLessThan(8);
  await expect(composer, "Fork を閉じたら Base の書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expect(lastReply.first(), "Fork を閉じたら最新の返事が消えた").toBeVisible();

  // Fork の書きかけも、開き直したら残っている
  // 戻る＝閉じる前（Fork が開いていた）へ
  await page.goBack();
  await expect(forkComposer).toBeVisible({ timeout: 15_000 });
  await expect(forkComposer, "Fork を閉じて開き直したら書きかけが消えた").toHaveValue("Fork の書きかけ");

  await page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` }).click();
  await expect(forkComposer).toHaveCount(0);

  // ── 症状3：Canvas を開いて閉じる（Base は細くなる）→ 閉じたら Base の位置・最新・下書きはそのまま ──
  await scrollTo(composer, 600);
  const beforeCanvas = (await scrollOf(composer)).top;
  await openFilesCanvas(page);
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect(page.getByRole("button", { name: "Canvas を閉じる" })).toHaveCount(0);
  await expect(lastReply.first(), "Canvas を閉じたら最新の返事が消えた").toBeVisible({ timeout: 15_000 });
  await expect(composer, "Canvas を閉じたら Base の書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expect
    .poll(async () => Math.abs((await scrollOf(composer)).top - beforeCanvas), {
      message: "Canvas を閉じたら Base の位置が変わった",
      timeout: 5_000,
    })
    .toBeLessThan(8);

  // ── 症状3：Canvas を開いたまま Fork を立てる（Base は帯になり、描かれなくなる）→ 全部閉じても崩れない ──
  const beforeBoth = (await scrollOf(composer)).top;
  await openFilesCanvas(page);
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await expect(page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` })).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveCount(0); // Base は帯だけ
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` }).click();
  await expect(composer).toBeVisible();
  await expect(lastReply.first(), "Fork＋Canvas を閉じたら最新の返事が消えた").toBeVisible({ timeout: 15_000 });
  await expect(composer, "Fork＋Canvas を閉じたら Base の書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expect
    .poll(async () => Math.abs((await scrollOf(composer)).top - beforeBoth), {
      message: "Fork＋Canvas を閉じたら Base の位置が変わった",
      timeout: 5_000,
    })
    .toBeLessThan(8);

  // ── 症状1：リロードしたら一番下 ──
  await page.reload();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(lastReply.first()).toBeVisible({ timeout: 15_000 });
  await expectAtBottom(composer, "リロード直後");
});

test("設定画面の Escape は、節をいくつ移っていても一発で設定から抜ける", async ({ page }) => {
  await openApp(page);
  await createProject(page, `Escape ${Date.now()}`, mkdtempSync(join(tmpdir(), "banto-e2e-")));
  await expect(baseComposer(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "設定", exact: true }).click();
  await expect(page).toHaveURL(/\/settings/);
  // 設定に入る前に見ていた Project（作った直後は URL がまだ前の Project を指していることがあるので、
  // 設定の側が受け取った `?project=` で決める）
  const projectId = new URL(page.url()).searchParams.get("project");
  expect(projectId, "設定が Project の層を持っていない").toBeTruthy();
  // 節を2つ渡り歩く（左メニューの項目を押すと履歴に積まれる）
  await page.getByRole("button", { name: "Skill", exact: true }).click();
  await expect(page).toHaveURL(/section=skills/);
  await page.getByRole("button", { name: "Global Memory", exact: true }).click();
  await expect(page).toHaveURL(/section=global-memory/);
  await page.keyboard.press("Escape");
  await expect(page, "Escape で設定から抜けなかった").toHaveURL(new RegExp(`/p/${projectId}$`), { timeout: 10_000 });
});

test("外で始まったターンに乗っても、会話は作り直されず、一番下を追いかける", async ({ page }) => {
  // **組み直しでランタイムを捨てない**（決定・2026-09-28）。以前は host が始めたターン（届いたもの・
  // 別の画面）に乗るたびに会話を丸ごと作り直し、入力欄・スクロール・カードの開閉を失っていた。
  // **案B**：走っている間は一番下を追いかける（以前は最新ターンの頭で止まった）
  const name = `External ${Date.now()}`;
  await openApp(page);
  await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-")));
  const composer = baseComposer(page);
  await sendTurn(page, composer, "ONE");

  const H = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: H })).json()) as {
    id: string;
    name: string;
  }[];
  const pid = projects.find((p) => p.name === name)!.id;
  const tid = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${pid}/threads`, { headers: H })).json()) as {
    id: string;
  }[])[0]!.id;

  // 器に印を付ける——作り直されたら印は消える
  await composer.evaluate((el) => {
    (el.closest('[data-slot="aui_thread-viewport"]') as HTMLElement & { __bantoMark?: boolean }).__bantoMark = true;
  });
  // 書きかけは、localStorage から戻したのではなく**入力欄のまま**残っていること（下で印と一緒に見る）
  await composer.fill("外のターンの間の書きかけ");

  // 画面の外でターンを始める（届いたもので host が始めた、の代わり）——4秒かけて長い返事を流す
  const done = page.request.post(`${CORE_BASE_URL}/api/threads/${tid}/messages`, {
    headers: { ...H, "content-type": "application/json" },
    data: { prompt: `外から${fakeTurn({ say: longReply("EXT"), streamMs: 4000 })}` },
  });
  // 流れている途中も一番下に居る
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "EXT の 10 行目" }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expectAtBottom(composer, "外のターンが流れている途中");
  await done;
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "EXT-END" }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 30_000 });
  // 終わったら host の知らせで最新を出し直す——それでも作り直さない
  await page.waitForTimeout(1500);
  await expectAtBottom(composer, "外のターンが終わったあと");
  const kept = await composer.evaluate(
    (el) => (el.closest('[data-slot="aui_thread-viewport"]') as HTMLElement & { __bantoMark?: boolean }).__bantoMark === true,
  );
  expect(kept, "外のターンに乗ったら会話が作り直された（器の印が消えた）").toBe(true);
  await expect(composer).toHaveValue("外のターンの間の書きかけ");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "ONE-END" }).first()).toBeVisible();
});
