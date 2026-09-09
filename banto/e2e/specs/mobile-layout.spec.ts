// 携帯で会話するときの約束（ユーザー報告・2026-09-07、Android 実機）。
//
//   **ヘッダと入力欄は常に見えていて、その間に履歴があり、
//     スクロールすれば一番上から一番下まで辿れる。**
//
// キーボードが出た状態は自動では作れない（実機の機能）。代わりに
// **画面の高さを縮めて**同じ形を再現する——`interactive-widget=resizes-content`
// を指定してある以上、キーボードが出たときに起きることは「レイアウトの高さが
// 縮む」であって、それはここで測れる。
//
// **指定が無いと何が起きるか**：Android Chrome の既定（`resizes-visual`）では
// キーボードでレイアウトが縮まないため、入力欄はキーボードの裏に入り、
// ブラウザが入力欄を見せようと画面を持ち上げてヘッダが上に逃げる。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 412, height: 840 }, hasTouch: true });

const PROJECT_NAME = "E2E Mobile Layout";

/** ヘッダ・入力欄・履歴の器の位置を、画面の座標で測る。 */
async function layout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const scroller = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    return {
      innerHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      header: rect(document.querySelector("header")),
      composer: rect(document.querySelector("textarea")),
      scroller: scroller
        ? {
            clientH: scroller.clientHeight,
            scrollH: scroller.scrollHeight,
            scrollTop: Math.round(scroller.scrollTop),
          }
        : null,
    };
  });
}

test("携帯では、ヘッダと入力欄が常に見えて、履歴は端まで辿れる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-mobile-"));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // **キーボードでレイアウトを縮める**指定が出ていること（これが無いと実機で崩れる）
  const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewportMeta, "キーボードでレイアウトを縮める指定が無い").toContain(
    "interactive-widget=resizes-content",
  );

  // 履歴を溢れさせる（1ターンで十分な長さを返させる）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("1 から 60 までの数字を、1行に1つずつ、番号だけ並べて出して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "60" })).toBeVisible({
    timeout: 120_000,
  });

  for (const height of [840, 400]) {
    await page.setViewportSize({ width: 412, height });
    await page.waitForTimeout(600);
    const l = await layout(page);
    const what = `高さ${height}`;

    // **画面そのものはスクロールしない**（履歴の器だけが動く）
    expect(l.documentScrollHeight, `${what}: 画面ごとスクロールしている`).toBeLessThanOrEqual(
      l.innerHeight + 1,
    );
    // ヘッダは一番上に、入力欄は画面の中に収まっている
    expect(l.header?.top, `${what}: ヘッダが画面の外にある`).toBe(0);
    expect(l.composer, `${what}: 入力欄が無い`).not.toBeNull();
    expect(l.composer!.bottom, `${what}: 入力欄が画面の下に隠れている`).toBeLessThanOrEqual(
      l.innerHeight,
    );
    expect(l.composer!.top, `${what}: 入力欄が画面の上に隠れている`).toBeGreaterThanOrEqual(0);
    // 間に履歴の場所が残っている
    expect(l.scroller?.clientH ?? 0, `${what}: 履歴の場所が無い`).toBeGreaterThan(50);
  }

  // **一番上まで辿れる**（開いた直後は一番下にいる）
  const scrollTo = async (to: "top" | "bottom") =>
    page.evaluate((to) => {
      const el = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      if (!el) return;
      el.scrollTo({ top: to === "top" ? 0 : el.scrollHeight, behavior: "instant" });
    }, to);

  await scrollTo("top");
  await page.waitForTimeout(500);
  await expect(
    page.locator('[data-role="user"]').first(),
    "一番上まで辿っても、最初の発言が見えない",
  ).toBeVisible();

  await scrollTo("bottom");
  await page.waitForTimeout(500);
  await expect(
    page.locator('[data-role="assistant"]').last(),
    "一番下まで辿っても、最後の返事が見えない",
  ).toBeVisible();
});

/**
 * 履歴と入力欄の位置関係を測る。
 *
 * **見るのは「ある発言と入力欄の間隔」**（`発言の上端 − 入力欄の上端`）
 * ——ユーザーの言う「位置関係」そのもの。画面の高さが変われば入力欄は動くが、
 * 履歴も同じだけ動いていれば、人から見て何も動いていない。
 *
 * **「下からの距離」で測ってはいけない**（実測・2026-09-07で踏んだ）——
 * 中身の高さは大きさ変更のあとに揺れる（16,970 → 19,048）ので、
 * 見た目が動いていなくても数値は変わる。
 * **中身が画面を埋めていないときの余白**を位置関係と数えるのも誤り
 * （高さ840では317px、縮めて溢れると35px）。
 */
async function bottomState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!sc) return null;
    const last = [...sc.querySelectorAll("[data-role]")].at(-1);
    const composer = document.querySelector("textarea");
    const header = document.querySelector("header");
    if (!last || !composer || !header) return null;
    const lastRect = last.getBoundingClientRect();
    const composerTop = composer.getBoundingClientRect().top;
    return {
      /** 最後の発言と入力欄の間隔＝人から見た「位置関係」 */
      gapToComposer: Math.round(lastRect.top - composerTop),
      /** 中身の座標での位置（上の内容が伸びれば増える——別件の切り分け用） */
      lastOffsetTop: (last as HTMLElement).offsetTop,
      scrollHeight: sc.scrollHeight,
      bottomDistance: Math.max(0, Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight)),
      atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 4,
      overflowing: sc.scrollHeight > sc.clientHeight + 4,
      scrollTop: Math.round(sc.scrollTop),
      lastBottom: Math.round(lastRect.bottom),
      lastTop: Math.round(lastRect.top),
      composerTop: Math.round(composer.getBoundingClientRect().top),
      headerBottom: Math.round(header.getBoundingClientRect().bottom),
    };
  });
}

/**
 * **中身の高さが落ち着くまで待つ。**
 *
 * 返事の直後は、上のほうの内容が後から測り直されて伸びる
 * （実測・2026-09-07：16,970 → 19,048。別件 `mobile-transcript-height-jump`）。
 * その最中に測ると、位置関係の話とは無関係な数十 px の差が出る
 * ——**待ちを延ばすのではなく、落ち着いたことを条件にする**（規則6）。
 */
async function waitForStableHeight(page: import("@playwright/test").Page) {
  const height = async () =>
    page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      return sc?.scrollHeight ?? 0;
    });
  let previous = await height();
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(400);
        const now = await height();
        const stable = now === previous && now > 0;
        previous = now;
        return stable;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

test("キーボードが出ても、履歴と入力欄の位置関係が変わらない", async ({ page }) => {
  // **どこを見ていても位置関係を保つ**（ユーザー要望・2026-09-07。最初は
  // 「一番下のときだけ」で作り、比べたうえでどこでも保つ形に広げた）。
  // 実測（直す前）：高さを縮めると一番下にいた人の最後の発言が入力欄より下
  // （発言の下端703 / 入力欄の上端319）に取り残されていた。
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-mobile-kb-"));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Mobile Keyboard");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText("Base Thread — E2E Mobile Keyboard")).toBeVisible({ timeout: 15_000 });

  // **履歴を確実に溢れさせる**——AI の返事の長さに頼らない（実測・2026-09-07：
  // 短い返事だと履歴が画面を埋めず、「位置関係」ではなく**余白の伸び縮み**を
  // 測ってしまう）。自分の発言そのものを長くすれば、返事の内容に関係なく溢れる
  const longText = Array.from({ length: 120 }, (_, i) => `行 ${i + 1}`).join("\n");
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(`${longText}\n\nこの一覧は読まなくていいです。「はい」とだけ返して。`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1000);

  const toBottom = async () =>
    page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      sc?.scrollTo({ top: sc.scrollHeight, behavior: "instant" });
    });

  // **着くまで待つ**——返事の直後は中身の高さがまだ動く
  // （`mobile-transcript-height-jump`）。待ちを延ばすのではなく、着いたことを条件にする
  await expect
    .poll(async () => {
      await toBottom();
      return (await bottomState(page))?.atBottom ?? false;
    }, { timeout: 20_000 })
    .toBe(true);

  // キーボードが出た相当（レイアウトが縮む）
  await page.setViewportSize({ width: 412, height: 420 });
  await page.waitForTimeout(1000);
  const after = await bottomState(page);
  expect(after?.overflowing, "縮めても中身が溢れていない（この試験の意味が無い）").toBe(true);
  expect(after?.atBottom, "キーボードで一番下から外れた").toBe(true);
  expect(
    after!.lastBottom,
    `最後の発言が入力欄より下に取り残されている（発言の下端 ${after!.lastBottom} / 入力欄の上端 ${after!.composerTop}）`,
  ).toBeLessThanOrEqual(after!.composerTop);
  expect(after!.lastBottom, "最後の発言が画面より上に消えている").toBeGreaterThan(after!.headerBottom);

  // ---- 途中を読んでいるときも、位置関係は同じ ------------------------------
  // **溢れている状態で**途中を読む形を作る（高さ840では中身が溢れず、
  // 「途中」を作れない——実測で踏んだ）。キーボードがさらに高くなる場合に相当
  await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    sc?.scrollTo({ top: Math.round((sc.scrollHeight - sc.clientHeight) / 2), behavior: "instant" });
  });
  await page.waitForTimeout(500);
  await waitForStableHeight(page);
  const middle = await bottomState(page);
  expect(middle?.atBottom, "途中の位置を作れていない（一番下にいる）").toBe(false);
  expect(middle!.bottomDistance, "途中の位置を作れていない（下からの距離が0）").toBeGreaterThan(20);

  await page.setViewportSize({ width: 412, height: 320 });
  await page.waitForTimeout(1000);
  const afterMiddle = await bottomState(page);
  expect(
    Math.abs(afterMiddle!.gapToComposer - middle!.gapToComposer),
    `途中を読んでいたのに位置関係が変わった（発言と入力欄の間隔 ${middle!.gapToComposer} → ${afterMiddle!.gapToComposer}）`,
  ).toBeLessThanOrEqual(8);

  // **閉じたら、元の位置にぴたりと戻る**（ユーザー報告：ここで二度動いていた）
  await page.setViewportSize({ width: 412, height: 420 });
  await page.waitForTimeout(1000);
  const afterRestore = await bottomState(page);
  expect(
    Math.abs(afterRestore!.gapToComposer - middle!.gapToComposer),
    `キーボードを閉じたら位置関係が変わった（間隔 ${middle!.gapToComposer} → ${afterRestore!.gapToComposer}` +
      `／中身の座標 ${middle!.lastOffsetTop} → ${afterRestore!.lastOffsetTop}` +
      `／中身の高さ ${middle!.scrollHeight} → ${afterRestore!.scrollHeight}）`,
  ).toBeLessThanOrEqual(8);

  // **入力欄の高さが後から変わっても、履歴は動かない**（ユーザーの見立て：
  // 「入力欄が最初小さくなって、大きくなるからカウントしているかも」）。
  // ここが動くと「一度動いたあと、少しだけまた動く」になる
  const beforeComposerChange = await bottomState(page);
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (ta) ta.style.height = "120px";
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (ta) ta.style.height = "";
  });
  await page.waitForTimeout(600);
  const afterComposerChange = await bottomState(page);
  expect(
    Math.abs(afterComposerChange!.gapToComposer - beforeComposerChange!.gapToComposer),
    `入力欄が伸び縮みしたら履歴が動いた（間隔 ${beforeComposerChange!.gapToComposer} → ${afterComposerChange!.gapToComposer}）`,
  ).toBeLessThanOrEqual(8);
});

test("返事の直後（最後のターンが上端に固定された位置）でキーボードを開閉しても、元の位置に戻る", async ({
  page,
}) => {
  // **実機で報告された不具合そのもの**（2026-09-07：閉じたときに前のターンの
  // あたりまで戻る）。これまでの試験は手でスクロールしてから測っていたため、
  // **「送って、返事が来て、そのまま」**という一番よくある状態を見ていなかった。
  //
  // この状態では assistant-ui（turnAnchor="top"）が最後のターンを器の上端に固定し、
  // ターンの下に reserve（余白）を置いている。reserve は器の高さに追従するが
  // **1フレーム遅れる**ので、閉じた瞬間にブラウザが scrollTop を切り詰め、さらに
  // 自前部品が「高さの差分」を引いて**二重に戻っていた**
  // （実測・修正前：scrollTop 2136 → 1304、アンカーが画面の 94 → 926 に落ちた）。
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-mobile-pin-"));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Mobile Keyboard Pin");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText("Base Thread — E2E Mobile Keyboard Pin")).toBeVisible({
    timeout: 15_000,
  });

  const composer = page.getByPlaceholder(/に送る/);

  // ターン1：**「前のターン」となる中身**を作っておく（戻り先が見えるように長め）
  const longText = Array.from({ length: 80 }, (_, i) => `前ターン行 ${i + 1}`).join("\n");
  await composer.fill(`${longText}\n\nこの一覧は読まなくていいです。「はい」とだけ返して。`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(1, { timeout: 120_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(/はい/, {
    timeout: 120_000,
  });
  // **走行が終わってから次を送る**——返事の文字はストリーミング途中でも見えるので、
  // 文字だけを待つと走行中に Enter を押してしまい、次のターンが走らないことがある
  // （実測・2026-09-09：user発言は足されたのに返事が来ないまま120秒切れた）。
  // 「何秒か待つ」ではなく、走行中だけ出る停止ボタンが消えたことを条件にする（規則6）
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 120_000,
  });

  // ターン2：これが「最後のターン」になり、器の上端に固定される
  await composer.fill("今度も「はい」とだけ返して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(2, { timeout: 120_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(/はい/, {
    timeout: 120_000,
  });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 120_000,
  });
  // 固定へのスクロール（smooth）と中身の測り直しが終わるのを待つ
  await page.waitForTimeout(2500);
  await waitForStableHeight(page);

  // **手でスクロールしない**——ライブラリが置いた位置のまま測る
  const pinState = async () =>
    page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      const anchor = sc?.querySelector<HTMLElement>("[data-aui-top-anchor-user]");
      const lastAssistant = [...(sc?.querySelectorAll<HTMLElement>('[data-role="assistant"]') ?? [])].at(-1);
      const composerEl = document.querySelector("textarea");
      if (!sc || !anchor || !lastAssistant || !composerEl) return null;
      return {
        scrollTop: Math.round(sc.scrollTop),
        /** アンカー（最後のuser発言）の画面上の位置——人から見た「動いたかどうか」 */
        anchorTop: Math.round(anchor.getBoundingClientRect().top),
        lastAssistantTop: Math.round(lastAssistant.getBoundingClientRect().top),
        composerTop: Math.round(composerEl.getBoundingClientRect().top),
      };
    });

  const before = await pinState();
  expect(before, "固定位置の測定に必要な要素が無い").not.toBeNull();

  // キーボードが出た相当。**最後の返事は入力欄より上に見えたまま**であること
  await page.setViewportSize({ width: 412, height: 420 });
  await page.waitForTimeout(1000);
  const open = await pinState();
  expect(
    open!.lastAssistantTop,
    `キーボードで最後の返事が入力欄の下に隠れた（返事の上端 ${open!.lastAssistantTop} / 入力欄の上端 ${open!.composerTop}）`,
  ).toBeLessThan(open!.composerTop);

  // **閉じたら、開く前と同じ位置に戻る**（ここが実機で壊れていた）
  await page.setViewportSize({ width: 412, height: 840 });
  await page.waitForTimeout(1000);
  const closed = await pinState();
  expect(
    Math.abs(closed!.anchorTop - before!.anchorTop),
    `キーボードを閉じたら履歴の位置がずれた（アンカーの画面上の位置 ${before!.anchorTop} → ${closed!.anchorTop}` +
      `／scrollTop ${before!.scrollTop} → ${closed!.scrollTop}）`,
  ).toBeLessThanOrEqual(8);
});
