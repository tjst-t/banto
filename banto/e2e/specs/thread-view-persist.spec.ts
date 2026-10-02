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
import { test, expect, type Locator, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, openApp, fakeTurn, confirmForkDialog } from "../helpers.js";
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

/** 器の上端にかかっているメッセージと、上端からのずれ（px）——中身が増えても「どこを読んでいるか」で比べる */
async function readingAt(composer: Locator): Promise<{ index: number; offset: number }> {
  return composer.evaluate((el) => {
    const v = el.closest<HTMLElement>('[data-slot="aui_thread-viewport"]')!;
    const top = v.getBoundingClientRect().top;
    const ms = [...v.querySelectorAll<HTMLElement>("[data-message-id]")];
    for (let i = 0; i < ms.length; i++) {
      const r = ms[i]!.getBoundingClientRect();
      if (r.bottom > top) return { index: i, offset: Math.round(top - r.top) };
    }
    return { index: -1, offset: 0 };
  });
}

/** 読んでいた場所（メッセージとその中の位置）が変わっていない */
async function expectSameReading(composer: Locator, before: { index: number; offset: number }, what: string): Promise<void> {
  await expect
    .poll(async () => {
      const now = await readingAt(composer);
      return now.index === before.index ? Math.abs(now.offset - before.offset) : Number.POSITIVE_INFINITY;
    }, { message: `${what}：読んでいた場所が変わった`, timeout: 5_000 })
    .toBeLessThan(8);
}

async function scrollTo(composer: Locator, top: number): Promise<void> {
  await composer.evaluate((el, t) => {
    const v = el.closest<HTMLElement>('[data-slot="aui_thread-viewport"]')!;
    v.scrollTo({ top: t, behavior: "instant" });
  }, top);
}

/** 会話の器に印を付ける——作り直されたら印は消える */
async function markViewport(composer: Locator): Promise<void> {
  await composer.evaluate((el) => {
    (el.closest('[data-slot="aui_thread-viewport"]') as HTMLElement & { __bantoMark?: boolean }).__bantoMark = true;
  });
}

async function expectSameViewport(composer: Locator, what: string): Promise<void> {
  const kept = await composer.evaluate(
    (el) => (el.closest('[data-slot="aui_thread-viewport"]') as HTMLElement & { __bantoMark?: boolean }).__bantoMark === true,
  );
  expect(kept, `${what}：会話が作り直された（器の印が消えた）`).toBe(true);
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

  // **下の会話は、どの面の開け閉めでも作り直さない**（改訂・2026-09-28、ユーザー要望「全部残して」）
  await markViewport(composer);

  // ── 症状2：設定へ行って戻ると、最新（流れたターン）が消える ──
  // ── 症状4：書きかけが消える ──
  await composer.fill("書きかけ-設定の往復");
  await page.getByRole("link", { name: "設定", exact: true }).click();
  await expect(page).toHaveURL(/[?&]settings=1/);
  // 設定は会話の上に重なる——下の会話は捨てない（2026-09-28）
  await expect(page.locator("[data-banto-settings]")).toBeVisible();
  await page.goBack();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(lastReply.first(), "設定から戻ったら最新の返事が消えた").toBeVisible({ timeout: 15_000 });
  await expect(composer, "設定から戻ったら書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expectSameViewport(composer, "設定を開いて閉じた");
  // 一番下に居たので、一番下のまま
  await expectAtBottom(composer, "設定から戻った直後");

  // ── 症状3：Fork を開いて閉じても、Base の位置と下書きはそのまま ──
  await scrollTo(composer, 600);
  await page.waitForTimeout(300);
  const before = await readingAt(composer);
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await expect(forkComposer).toBeVisible({ timeout: 15_000 });
  await forkComposer.fill("Fork の書きかけ");
  await page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` }).click();
  await expect(forkComposer).toHaveCount(0);
  await expectSameReading(composer, before, "Fork を閉じた");
  await expect(composer, "Fork を閉じたら Base の書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expect(lastReply.first(), "Fork を閉じたら最新の返事が消えた").toBeVisible();
  await expectSameViewport(composer, "Fork を開いて閉じた");

  // Fork の書きかけも、開き直したら残っている
  // 戻る＝閉じる前（Fork が開いていた）へ
  await page.goBack();
  await expect(forkComposer).toBeVisible({ timeout: 15_000 });
  await expect(forkComposer, "Fork を閉じて開き直したら書きかけが消えた").toHaveValue("Fork の書きかけ");

  await page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` }).click();
  await expect(forkComposer).toHaveCount(0);

  // ── 症状3：Canvas を開いて閉じる（Base は細くなる）→ 閉じたら Base の位置・最新・下書きはそのまま ──
  await scrollTo(composer, 600);
  await page.waitForTimeout(300);
  const beforeCanvas = await readingAt(composer);
  await openFilesCanvas(page);
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect(page.getByRole("button", { name: "Canvas を閉じる" })).toHaveCount(0);
  await expect(lastReply.first(), "Canvas を閉じたら最新の返事が消えた").toBeVisible({ timeout: 15_000 });
  await expect(composer, "Canvas を閉じたら Base の書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expectSameViewport(composer, "Canvas を開いて閉じた");
  await expectSameReading(composer, beforeCanvas, "Canvas を閉じた");

  // ── 症状3：Canvas を開いたまま Fork を立てる（Base は帯になり、描かれなくなる）→ 全部閉じても崩れない ──
  const beforeBoth = await readingAt(composer);
  await openFilesCanvas(page);
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  await expect(page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` })).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeHidden(); // Base は帯だけ（隠して残っている）
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await page.getByRole("button", { name: `${PROJECT} の Base Thread に戻る` }).click();
  await expect(composer).toBeVisible();
  await expect(lastReply.first(), "Fork＋Canvas を閉じたら最新の返事が消えた").toBeVisible({ timeout: 15_000 });
  await expect(composer, "Fork＋Canvas を閉じたら Base の書きかけが消えた").toHaveValue("書きかけ-設定の往復");
  await expectSameViewport(composer, "Fork＋Canvas を開いて閉じた");
  await expectSameReading(composer, beforeBoth, "Fork＋Canvas を閉じた");

  // ── Canvas を全画面にして戻す ──
  const beforeFull = await readingAt(composer);
  await openFilesCanvas(page);
  await page.getByRole("button", { name: "全画面で表示" }).click();
  await expect(composer).toBeHidden();
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect(composer).toBeVisible();
  await expectSameViewport(composer, "Canvas を全画面にして閉じた");
  await expect(composer).toHaveValue("書きかけ-設定の往復");
  await expectSameReading(composer, beforeFull, "全画面の Canvas を閉じた");

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
  await expect(page).toHaveURL(/[?&]settings=1/);
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
  await expect(page, "Escape で設定から抜けなかった").toHaveURL(/\/p\/[0-9a-f-]+$/, { timeout: 10_000 });
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

test.describe("携帯幅", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Fork の上に Canvas を開いて閉じても、Fork は作り直されない", async ({ page }) => {
    // 以前の携帯は前面の1枚だけを描いていたので、Fork の上に Canvas を開くと Fork が捨てられた（2026-09-28）
    await openApp(page);
    await createProject(page, `Mobile ${Date.now()}`, mkdtempSync(join(tmpdir(), "banto-e2e-")));
    await sendTurn(page, baseComposer(page), "ONE");
    await page.getByRole("button", { name: "Fork を開く" }).click();
    await confirmForkDialog(page);
    const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
    await expect(forkComposer).toBeVisible({ timeout: 15_000 });
    await forkComposer.fill("携帯の Fork の書きかけ");
    await markViewport(forkComposer);

    // 携帯ではパレットの入口は目次（Drawer）の中——Ctrl-K で開く（どこからでも開ける口）
    await page.keyboard.press("Control+k");
    const entry = page.getByRole("option", { name: /ファイル/ });
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await entry.click();
    await expect(page.getByRole("button", { name: "Canvas を閉じる" })).toBeVisible({ timeout: 30_000 });
    await expect(forkComposer).toBeHidden();
    await page.getByRole("button", { name: "Canvas を閉じる" }).click();
    await expect(forkComposer).toBeVisible();
    await expectSameViewport(forkComposer, "携帯で Fork の上に Canvas を開いて閉じた");
    await expect(forkComposer).toHaveValue("携帯の Fork の書きかけ");
  });
});
