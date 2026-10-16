// **PDF にコメントを付けて AI に返す**（v4-modules.md §2.2「PDF・Office…」の「コメント」と「画面の形（改訂・2026-10-16）」・
// v4-frontend.md §6.2「画面から会話の入力欄へ文を渡す」、Backlog #307・#340）。
//
// 規則14——押せたで終わらせず、画面が出している中身を一つずつ見る：一覧の件数・指した場所の見出し・コメントの文・
// ツールバーの数・印（蛍光ペン・枠・ページの縁）、入力欄の塊の出所と中身の頭と全文、送った発言の塊、AI に届いた本文、記録。
// **操作は人と同じマウスで**——文はドラッグで選び、範囲は文字の無い所をドラッグで囲む（範囲をプログラムで作らない）。
// 自動では送られない（発言が増えない）・画面が勝手に呼んでも入らない・読み込み直してもコメントも書きかけの塊も残る。
//
// 表のセル：ここ（PDF の画面）では置き場の口（saveComments）でセルを指すコメントを1つ足し、一覧と AI に返す文に
// `シート!範囲（値）` で出ることを見る。表の画面から付けるのは filesystem-xlsx.spec.ts（Backlog #306）
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, fakeTurn, openApp, waitForProjectModule, waitTurnEnded } from "../helpers.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { makeJapanesePdf } from "../pdf-fixture.js";

test.setTimeout(300_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E FS Comments";

interface HostMessage {
  role: string;
  text: string;
  quotes?: Array<{ module: string; thirdParty: boolean; text: string }>;
}

async function baseThreadId(page: Page): Promise<string> {
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json();
  return threads[0].id;
}

async function hostMessages(page: Page): Promise<HostMessage[]> {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${await baseThreadId(page)}`, { headers: HEADERS })).json()).messages;
}

/** 画面の中から、MCP Apps の要求を親（host）へ直に送る——人の操作なしに画面が勝手に呼んだ形。返事を返す */
/**
 * 画面の中から host へ JSON-RPC を1通送る。**Playwright の evaluate は人の操作の扱い（user gesture）で走る**——「人の操作なし」を
 * 試すときは `delayMs` に人の操作の扱いが切れる（約5秒）より長い時間を渡し、それだけ待ってから送る
 */
async function rawRequest(view: FrameLocator, method: string, params: unknown, delayMs = 0): Promise<{ result?: unknown; error?: unknown }> {
  return view.locator("body").evaluate(
    (_body, { method, params, delayMs }) =>
      new Promise((resolve) => {
        const id = `e2e-${Math.random()}`;
        const onMessage = (event: MessageEvent) => {
          const msg = event.data as { id?: unknown; result?: unknown; error?: unknown };
          if (msg?.id !== id) return;
          window.removeEventListener("message", onMessage);
          resolve({ result: msg.result, error: msg.error });
        };
        window.addEventListener("message", onMessage);
        setTimeout(() => window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"), delayMs);
      }),
    { method, params, delayMs },
  );
}

/** 一覧のいまの中身（見出しと本文）を、上から順に */
async function listed(view: FrameLocator): Promise<Array<{ anchor: string; body: string }>> {
  const items = view.getByTestId("comment-item");
  const out: Array<{ anchor: string; body: string }> = [];
  for (let i = 0; i < (await items.count()); i++) {
    out.push({
      anchor: (await items.nth(i).getByTestId("comment-anchor").textContent()) ?? "",
      body: (await items.nth(i).getByTestId("comment-body").textContent()) ?? "",
    });
  }
  return out;
}

/**
 * 押して、途中の点を通って、離す（人のドラッグと同じく少しずつ動かす）。前に選んだ文字の上から押すとブラウザはその文字を
 * 引きずって運ぶ動き（drag and drop）にするので、始める前に選択を外す
 */
async function drag(page: Page, view: FrameLocator, points: Array<[number, number]>): Promise<void> {
  await view.locator("body").evaluate(() => window.getSelection()?.removeAllRanges());
  const [first, ...rest] = points;
  await page.mouse.move(first![0], first![1]);
  await page.mouse.down();
  for (const [x, y] of rest) {
    await page.mouse.move(x, y, { steps: 6 });
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
}

/** 1ページ目の、その文字列で始まる行の箱（文字の層は1行を幾つかの span に分けて描くので、同じ高さの span をつなぐ） */
async function lineBox(view: FrameLocator, text: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const span = view.locator('.pdf-page[data-page="1"].rendered .textLayer span').filter({ hasText: text }).first();
  await expect(span).toBeVisible({ timeout: 60_000 });
  const first = (await span.boundingBox())!;
  const frameOffset = await span.evaluate((el) => el.getBoundingClientRect().left);
  const right = await span.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const spans = [...el.parentElement!.querySelectorAll("span")].filter((s) => s.textContent && Math.abs(s.getBoundingClientRect().top - top) < 4);
    return Math.max(...spans.map((s) => s.getBoundingClientRect().right));
  });
  return { x: first.x, y: first.y, width: right - frameOffset, height: first.height };
}

/** その行を、左端から右の外までドラッグして選ぶ */
async function selectLine(page: Page, view: FrameLocator, text: string): Promise<string> {
  const box = await lineBox(view, text);
  await drag(page, view, [
    [box.x + 1, box.y + box.height / 2],
    [box.x + box.width + 30, box.y + box.height / 2],
  ]);
  return view.locator("body").evaluate(() => window.getSelection()?.toString() ?? "");
}

/** 1ページ目の、文字の無い所（割合で指す）をドラッグで囲む */
async function dragRegion(page: Page, view: FrameLocator, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await view.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const at = ([x, y]: [number, number]): [number, number] => [box.x + box.width * x, box.y + box.height * y];
  const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  await drag(page, view, [at(from), at(mid), at(to)]);
}

const CARD = '[data-testid="inline-module-view"][data-module="filesystem"]';

function card(page: Page): FrameLocator {
  return page.locator(CARD).frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
}

test("PDF の選んだ文・範囲・ページ（と表のセル）にコメントを付け、AI に返すと入力欄に塊が出て、送ると出所つきで AI に届く", async ({ page }) => {
  // 会話の中のカード（ページを並べる枠は 520px）が画面に収まる高さにする——ドラッグする点が画面の外だと届かない
  await page.setViewportSize({ width: 1280, height: 1400 });
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fscomments-"));
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(
    join(projectRoot, "docs/plan.pdf"),
    makeJapanesePdf([
      ["第1章 受信箱の見直し", "本文その1：結論を先に書く。"],
      ["第2章 図の凡例", "本文その2"],
      ["第3章 まとめ", "本文その3"],
    ]),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("計画の PDF を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/plan.pdf" } }] }));
  await composer.press("Enter");
  const threadId = await baseThreadId(page);
  await waitTurnEnded(page, threadId, 1, 120_000);

  let view = card(page);
  await expect(view.locator("body")).toHaveAttribute("data-surface", "document", { timeout: 60_000 });
  await expect(view.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });

  // ---- 会話の中のカード：コメントモードは既定でオフ。「コメント」・ページの行の「コメント」・一覧・「AI に返す」は出ない ----
  const toggle = view.getByTestId("comments-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toContainText("コメント");
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("");
  await expect(view.getByTestId("comment-for-page").first()).toBeHidden();
  await expect(view.getByTestId("comments-list-toggle")).toBeHidden();
  await expect(view.getByTestId("comments-return")).toBeHidden();
  await expect(view.getByTestId("comments-copy")).toHaveCount(0);
  expect(await selectLine(page, view, "第1章")).toBe("第1章 受信箱の見直し");
  await page.waitForTimeout(300);
  await expect(view.getByTestId("comment-chip"), "コメントモードがオフなのに「コメント」が出た").toBeHidden();
  // 文字の無い所をドラッグしても範囲にならない
  await dragRegion(page, view, [0.4, 0.3], [0.6, 0.45]);
  await expect(view.getByTestId("comment-chip")).toBeHidden();
  await expect(view.getByTestId("comment-mark")).toHaveCount(0);

  // ---- コメントモードに入る：ページの行に「このページにコメント」、ツールバーに「一覧」 ---------------------------------
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(view.getByTestId("comment-for-page")).toHaveText(["このページにコメント", "このページにコメント", "このページにコメント"]);
  await expect(view.getByTestId("comment-for-page").first()).toBeVisible();
  await expect(view.getByTestId("comments-list-toggle")).toBeVisible();
  // 狭い（会話の中のカード）ので右の余白は出さない
  await expect(view.getByTestId("comment-margin")).toBeHidden();

  // ---- 選んだ文にコメント：選び終えた横の「コメント」を C キーで ------------------------------------------------
  expect(await selectLine(page, view, "第1章")).toBe("第1章 受信箱の見直し");
  await expect(view.getByTestId("comment-chip")).toBeVisible();
  await page.keyboard.press("c");
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText("1ページ「第1章 受信箱の見直し」");
  await expect(view.getByTestId("comment-chip")).toBeHidden();
  await view.getByTestId("comment-input").fill("ここは結論を先に");
  await view.getByTestId("comment-input").press("Control+Enter");
  await expect(view.getByTestId("comment-draft")).toHaveCount(0);
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("1");
  await expect(view.getByTestId("comments-return")).toBeVisible();
  await expect(view.getByTestId("comments-return")).toContainText("AI に返す");
  await expect(view.getByTestId("comments-return")).toContainText("1");
  // 付けた文に蛍光ペン（文字の層の字そのもの——その行の高さ）
  const textMark = view.locator('.pdf-page[data-page="1"] [data-testid="comment-mark"][data-kind="text"][data-state="saved"]');
  await expect(textMark.first()).toBeVisible();
  const line1 = await lineBox(view, "第1章");
  const markBox = (await textMark.first().boundingBox())!;
  expect(Math.abs(markBox.y - line1.y), "蛍光ペンが選んだ行に無い").toBeLessThan(line1.height);

  // ---- 文字の無い所をドラッグ：そのまま範囲。「コメント」を押すまで点線の枠で残り、ページの別の所を押すと消える -----------
  await dragRegion(page, view, [0.4, 0.3], [0.6, 0.45]);
  const pending = view.locator('[data-testid="comment-mark"][data-kind="region"][data-state="pending"]');
  await expect(pending).toHaveCount(1);
  await expect(view.getByTestId("comment-chip")).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(pending, "囲んだ範囲が「コメント」を押す前に消えた").toHaveCount(1);
  const pageBox = (await view.locator('.pdf-page[data-page="1"]').boundingBox())!;
  await page.mouse.click(pageBox.x + pageBox.width * 0.85, pageBox.y + pageBox.height * 0.5);
  await expect(pending).toHaveCount(0);
  await expect(view.getByTestId("comment-chip")).toBeHidden();
  // もう一度囲んで、今度は「コメント」を押す——枠は書いている対象の印になる
  await dragRegion(page, view, [0.4, 0.3], [0.6, 0.45]);
  await expect(pending).toHaveCount(1);
  await view.getByTestId("comment-chip").click();
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText("1ページの範囲（真ん中）");
  await expect(view.locator('[data-testid="comment-mark"][data-kind="region"][data-state="draft"]')).toHaveCount(1);
  await view.getByTestId("comment-input").fill("凡例が読めない");
  await view.getByTestId("comment-add").click();
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("2");
  await expect(view.locator('[data-testid="comment-mark"][data-kind="region"][data-state="saved"]')).toHaveCount(1);

  // ---- ページにコメント：ページの上の行の「このページにコメント」--------------------------------------------------
  await view.getByTestId("comment-for-page").first().click();
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText("1ページ");
  await view.getByTestId("comment-input").fill("この章は消す");
  await view.getByTestId("comment-add").click();
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("3");
  await expect(view.locator('.pdf-page[data-page="1"] [data-testid="comment-mark"][data-kind="page"]')).toHaveCount(1);

  // ---- 一覧（狭いときは下から）--------------------------------------------------------------------------
  await view.getByTestId("comments-list-toggle").click();
  await expect(view.getByTestId("comments-panel")).toBeVisible();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント 3 件");
  expect(await listed(view)).toEqual([
    { anchor: "1ページ「第1章 受信箱の見直し」", body: "ここは結論を先に" },
    { anchor: "1ページの範囲（真ん中）", body: "凡例が読めない" },
    { anchor: "1ページ", body: "この章は消す" },
  ]);

  // ---- 表のセルを指すコメント（表の画面はまだ無いので、置き場の口から足す）------------------------------
  const stored = (await rawRequest(view, "tools/call", { name: "getComments", arguments: { path: "docs/plan.pdf" } })) as {
    result: { content: Array<{ text: string }> };
  };
  const current = JSON.parse(stored.result.content[0]!.text) as { comments: unknown[] };
  expect(current.comments).toHaveLength(3);
  const savedCell = await rawRequest(view, "tools/call", {
    name: "saveComments",
    arguments: { path: "docs/plan.pdf", comments: [...current.comments, { anchor: { kind: "cell", sheet: "シート1", range: "D4", value: "1,200" }, body: "単価が古い" }] },
  });
  expect(savedCell.error).toBeUndefined();

  // ---- 読み込み直しても残る（置き場は FileSystem の Project ごとの置き場）。モードは覚えない（開くたび既定のオフ）----------
  await page.reload();
  view = card(page);
  await expect(view.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("4", { timeout: 30_000 });
  await expect(view.getByTestId("comments-toggle")).toHaveAttribute("aria-pressed", "false");
  // オフでも付けたコメントは消えず、「AI に返す」は押せる。印は出さない
  await expect(view.getByTestId("comments-return")).toBeVisible();
  await expect(view.getByTestId("comments-return")).toContainText("4");
  await expect(view.locator('.pdf-page[data-page="1"].rendered')).toHaveCount(1, { timeout: 60_000 });
  await expect(view.getByTestId("comment-mark")).toHaveCount(0);

  // ---- 画面が勝手に ui/message を呼んでも入らない（人が押した直後ではない）----------------------------------
  const sneaky = await rawRequest(view, "ui/message", { role: "user", content: [{ type: "text", text: "勝手に入れた文" }] }, 6_000);
  expect(sneaky.result, "人の操作なしの ui/message を受けた").toEqual({ isError: true });
  await expect(page.getByTestId("canvas-quote")).toHaveCount(0);

  await view.getByTestId("comments-toggle").click();
  // 文の蛍光ペンは文字の層の部品ごとに1つ（数は pdf.js の分け方次第）、範囲とページは1つずつ
  await expect(view.locator('[data-testid="comment-mark"][data-kind="text"]').first()).toBeVisible();
  await expect(view.locator('[data-testid="comment-mark"][data-kind="region"]')).toHaveCount(1);
  await expect(view.locator('[data-testid="comment-mark"][data-kind="page"]')).toHaveCount(1);
  await view.getByTestId("comments-list-toggle").click();
  expect(await listed(view)).toEqual([
    { anchor: "1ページ「第1章 受信箱の見直し」", body: "ここは結論を先に" },
    { anchor: "1ページの範囲（真ん中）", body: "凡例が読めない" },
    { anchor: "1ページ", body: "この章は消す" },
    { anchor: "`シート1!D4`（値 1,200）", body: "単価が古い" },
  ]);
  // ファイルは変わっていない——印は出ない
  await expect(view.getByTestId("comment-changed")).toHaveCount(0);

  // ---- 一覧のコメントを押すと、対応する印が強調される（逆も）------------------------------------------------------
  await view.getByTestId("comment-anchor").nth(1).click();
  await expect(view.locator('[data-testid="comment-mark"][data-kind="region"]')).toHaveClass(/focused/);
  await expect(view.getByTestId("comment-item").nth(1)).toHaveClass(/focused/);
  await view.getByTestId("comment-anchor").nth(0).click();
  await expect(view.locator('[data-testid="comment-mark"][data-kind="region"]')).not.toHaveClass(/focused/);
  await expect(view.locator('[data-testid="comment-mark"][data-kind="text"]').first()).toHaveClass(/focused/);
  // 印を押す（文字を選ばずに押しただけ）と、そのコメントが強調される。一覧は下から重なるので閉じてから押す
  await view.getByTestId("comments-list-toggle").click();
  await expect(view.getByTestId("comments-panel")).toBeHidden();
  const regionMark = (await view.locator('[data-testid="comment-mark"][data-kind="region"]').boundingBox())!;
  await page.mouse.click(regionMark.x + 3, regionMark.y + regionMark.height / 2);
  await expect(view.locator('[data-testid="comment-mark"][data-kind="region"]')).toHaveClass(/focused/);
  await view.getByTestId("comments-list-toggle").click();
  await expect(view.getByTestId("comment-item").nth(1)).toHaveClass(/focused/);
  await expect(view.getByTestId("comment-item").nth(0)).not.toHaveClass(/focused/);

  // ---- 直す・消す --------------------------------------------------------------------
  await view.getByTestId("comment-item").nth(1).getByTestId("comment-edit").click();
  await view.getByTestId("comment-edit-input").fill("左上の図の凡例が読めない");
  await view.getByTestId("comment-edit-save").click();
  await view.getByTestId("comment-item").nth(2).getByTestId("comment-delete").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント 3 件");
  expect(await listed(view)).toEqual([
    { anchor: "1ページ「第1章 受信箱の見直し」", body: "ここは結論を先に" },
    { anchor: "1ページの範囲（真ん中）", body: "左上の図の凡例が読めない" },
    { anchor: "`シート1!D4`（値 1,200）", body: "単価が古い" },
  ]);
  await expect(view.locator('[data-testid="comment-mark"][data-kind="page"]')).toHaveCount(0);

  // ---- AI に返す：入力欄の上に塊が出る。送られはしない ------------------------------------------------
  const userBefore = await page.locator('[data-role="user"]').count();
  await view.getByTestId("comments-return").click();
  const quote = page.getByTestId("canvas-quote");
  await expect(quote).toHaveCount(1, { timeout: 15_000 });
  await expect(quote.getByTestId("canvas-quote-source")).toHaveText("filesystem の画面から");
  await expect(quote).toHaveAttribute("data-third-party", "false");
  const expected = [
    "`docs/plan.pdf` へのコメント（3件）",
    "1. 1ページ「第1章 受信箱の見直し」：ここは結論を先に",
    "2. 1ページの範囲（真ん中）：左上の図の凡例が読めない",
    "3. `シート1!D4`（値 1,200）：単価が古い",
  ].join("\n");
  await expect(quote.getByTestId("canvas-quote-head")).toHaveText(expected);
  // 一覧は空になり（「AI に返す」も引っ込む）、1回だけ戻せる
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("");
  await expect(view.getByTestId("comments-return")).toBeHidden();
  await expect(view.getByTestId("comment-mark")).toHaveCount(0);
  await expect(view.getByTestId("comments-undo")).toBeVisible();
  await expect(view.getByTestId("toast").filter({ hasText: "会話の入力欄に入れました" })).toBeVisible();
  // 入力欄の文は人の書きかけのまま（混ぜない）。発言は増えていない
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-role="user"]')).toHaveCount(userBefore);

  // 押すと全文を見られる
  await quote.click();
  await expect(page.getByTestId("canvas-quote-full")).toHaveText(expected);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-quote-full")).toHaveCount(0);

  // 元に戻してもう一度返すと、同じ画面からの塊は置き換わる（1枚の画面から1つ）
  await view.getByTestId("comments-undo").click();
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("3");
  await expect(view.getByTestId("comments-undo")).toBeHidden();
  await view.getByTestId("comments-list-toggle").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント 3 件");
  await view.getByTestId("comment-item").nth(2).getByTestId("comment-delete").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント 2 件");
  await view.getByTestId("comments-return").click();
  const twoLines = [
    "`docs/plan.pdf` へのコメント（2件）",
    "1. 1ページ「第1章 受信箱の見直し」：ここは結論を先に",
    "2. 1ページの範囲（真ん中）：左上の図の凡例が読めない",
  ].join("\n");
  await expect(quote.getByTestId("canvas-quote-head")).toHaveText(twoLines, { timeout: 15_000 });
  await expect(quote).toHaveCount(1);

  // ---- 書きかけの保存に含まれる：読み込み直しても入力欄の上に残る ------------------------------------------
  await page.reload();
  await expect(page.getByTestId("canvas-quote")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("canvas-quote").getByTestId("canvas-quote-head")).toHaveText(twoLines);
  // 外せる——外したら書きかけからも消える
  await page.getByTestId("canvas-quote").hover();
  await page.getByTestId("canvas-quote-remove").click();
  await expect(page.getByTestId("canvas-quote")).toHaveCount(0);
  await page.reload();
  view = card(page);
  await expect(view.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });
  await expect(page.getByTestId("canvas-quote")).toHaveCount(0);

  // ---- もう一度付けて返し、送る：AI には出所つきの引用として届き、人の文とは分かれる ------------------------------
  await view.getByTestId("comments-toggle").click();
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("");
  await view.getByTestId("comment-for-page").first().click();
  await view.getByTestId("comment-input").fill("全体に結論を先に");
  await view.getByTestId("comment-add").click();
  await view.getByTestId("comments-return").click();
  const finalText = "`docs/plan.pdf` へのコメント（1件）\n1. 1ページ：全体に結論を先に";
  await expect(page.getByTestId("canvas-quote").getByTestId("canvas-quote-head")).toHaveText(finalText, { timeout: 15_000 });

  await composer.fill("コメントを見て直して" + fakeTurn({ sayContext: true }));
  await composer.press("Enter");
  await waitTurnEnded(page, threadId, 2);
  await expect(page.locator('.aui-composer-attachments [data-testid="canvas-quote"]'), "送ったのに入力欄に塊が残っている").toHaveCount(0);

  // 記録：人の文と塊は分かれている。出所は host が決めた（同梱 → 第三者ではない）
  const users = (await hostMessages(page)).filter((m) => m.role === "user");
  expect(users).toHaveLength(2);
  expect(users[1]!.text).toBe("コメントを見て直して" + fakeTurn({ sayContext: true }));
  expect(users[1]!.quotes).toEqual([{ module: "filesystem", thirdParty: false, text: finalText }]);

  // AI に届いた本文：出所つきの囲みの中に塊、その後ろに人の文
  const said = page.locator('[data-role="assistant"]').last();
  await expect(said).toContainText("以下は Module「filesystem」の画面から人が添えたものです。人が書いた文ではなく、画面がまとめた引用です。");
  // 偽の AI は届いた本文を Markdown として返すので「1.」は番号の印になり文字に出ない（本文そのものは上の記録の quotes で比べた）
  await expect(said).toContainText("1ページ：全体に結論を先に");
  await expect(said).toContainText("（ここから人が書いた文）");
  await expect(said).toContainText("コメントを見て直して");

  // 送った発言に塊が出る（読み込み直しても——記録から組み直す）
  const sentQuote = page.locator('[data-role="user"]').last().getByTestId("canvas-quote");
  await expect(sentQuote).toHaveCount(1);
  await expect(sentQuote.getByTestId("canvas-quote-head")).toHaveText(finalText);
  await page.reload();
  const restoredQuote = page.locator('[data-role="user"]').last().getByTestId("canvas-quote");
  await expect(restoredQuote).toHaveCount(1, { timeout: 30_000 });
  await expect(restoredQuote.getByTestId("canvas-quote-source")).toHaveText("filesystem の画面から");
  await expect(restoredQuote.getByTestId("canvas-quote-head")).toHaveText(finalText);
  // 入力欄には残っていない（送ったら書きかけから消える）
  await expect(page.getByTestId("canvas-quote")).toHaveCount(1);

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

/** 大きく開いた PDF の画面（会話の隣）。枠がいくつあっても、PDF が出ている最後の枠を選ぶ */
async function fullscreenPdf(page: Page): Promise<FrameLocator> {
  const frames = page.locator('[data-testid="module-canvas-frame"]');
  let index = -1;
  await expect(async () => {
    const count = await frames.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const inner = frames.nth(i).contentFrame().frameLocator("iframe");
      const mode = await inner.locator("body").getAttribute("data-mode", { timeout: 1_000 }).catch(() => null);
      if (mode === "fullscreen" && (await inner.getByTestId("pdf-view").isVisible().catch(() => false))) {
        index = i;
        return;
      }
    }
    throw new Error(`大きく開いた PDF の画面が無い（枠は ${count} 個）`);
  }).toPass({ timeout: 60_000 });
  return frames.nth(index).contentFrame().frameLocator("iframe");
}

test("大きく開くとコメントモードが既定でオンになり、広いときは右の余白にコメントが指した所の高さに並ぶ。切ると「コメント」・印・余白が出ない", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fscomments-wide-"));
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(
    join(projectRoot, "docs/plan.pdf"),
    makeJapanesePdf([
      ["第1章 受信箱の見直し", "本文その1：結論を先に書く。"],
      ["第2章 図の凡例", "本文その2"],
      ["第3章 まとめ", "本文その3"],
    ]),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await createProject(page, "E2E FS Comments Wide", projectRoot);
  await waitForProjectModule(page, "E2E FS Comments Wide", "filesystem");
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("計画の PDF を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/plan.pdf" } }] }));
  await composer.press("Enter");
  const embed = page.locator(CARD);
  await expect(card(page).getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 120_000 });
  // 画面の中に「大きく表示」は置かない——banto の枠の「大きく開く」を使う
  await expect(card(page).getByRole("button", { name: "大きく表示" })).toHaveCount(0);
  await embed.getByRole("button", { name: "大きく開く" }).click();
  const full = await fullscreenPdf(page);
  await expect(full.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });
  await expect(full.locator('.pdf-page[data-page="1"].rendered')).toHaveCount(1, { timeout: 60_000 });

  // ---- 既定でオン。広いので右に余白、何も無いときは案内 ------------------------------------------------------
  await expect(full.getByTestId("comments-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(full.getByTestId("pdf-view")).toHaveAttribute("data-comment-wide", "on");
  const margin = full.getByTestId("comment-margin");
  await expect(margin).toBeVisible();
  await expect(full.getByTestId("comments-empty")).toHaveText("文を選ぶか、図をドラッグで囲むと、そこにコメントを付けられます。ページの上の行からページにも付けられます。");
  await expect(full.getByTestId("comments-list-toggle")).toBeHidden();
  await expect(full.getByTestId("comment-for-page").first()).toBeVisible();
  // 初めは幅に合わせて縮める（余白を引いた幅にページが収まり、横にはみ出さない）
  const fit = await full.getByTestId("pdf-scroller").evaluate((s) => ({ overflow: s.scrollWidth - s.clientWidth }));
  expect(fit.overflow, "ページと余白が横にはみ出している").toBeLessThanOrEqual(1);
  const marginBox = (await margin.boundingBox())!;
  const first = (await full.locator('.pdf-page[data-page="1"]').boundingBox())!;
  expect(marginBox.x, "余白がページの右に無い").toBeGreaterThanOrEqual(first.x + first.width);
  expect(Math.round(marginBox.width)).toBe(292);

  // ---- 2ページ目にコメント：書く欄が余白の、2ページ目の頭の高さに開く --------------------------------------------
  await full.getByTestId("comment-for-page").nth(1).click();
  await expect(full.getByTestId("comment-draft-anchor")).toHaveText("2ページ");
  const page2 = (await full.locator('.pdf-page[data-page="2"]').boundingBox())!;
  const draftBox = (await full.getByTestId("comment-draft").boundingBox())!;
  expect(Math.abs(draftBox.y - (page2.y - 6)), "書く欄が指したページの高さに無い").toBeLessThan(4);
  expect(draftBox.x).toBeGreaterThanOrEqual(marginBox.x - 1);
  await full.getByTestId("comment-input").fill("この章は短く");
  await full.getByTestId("comment-add").click();

  // ---- 1ページ目の右の文字の無い所を囲む → 右上に「コメント」→ 押すと余白の、その高さに書く欄 -----------------------
  // （2ページ目の行のボタンを押したときにスクロールした——1ページ目に戻して測り直す）
  await full.locator('.pdf-page[data-page="1"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
  const page1 = (await full.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const regionFrom: [number, number] = [page1.x + page1.width * 0.6, page1.y + page1.height * 0.5];
  const regionTo: [number, number] = [page1.x + page1.width * 0.9, page1.y + page1.height * 0.62];
  await drag(page, full, [regionFrom, [(regionFrom[0] + regionTo[0]) / 2, (regionFrom[1] + regionTo[1]) / 2], regionTo]);
  const chip = full.getByTestId("comment-chip");
  await expect(chip).toBeVisible();
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.x, "「コメント」が囲んだ範囲の右に無い").toBeGreaterThan(regionTo[0]);
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(regionFrom[1] + 2);
  await chip.click();
  await expect(full.getByTestId("comment-draft-anchor")).toHaveText("1ページの範囲（右）");
  const regionMark = (await full.locator('[data-testid="comment-mark"][data-kind="region"][data-state="draft"]').boundingBox())!;
  expect(Math.abs(regionMark.y - regionFrom[1])).toBeLessThan(3);
  expect(Math.abs((await full.getByTestId("comment-draft").boundingBox())!.y - (regionMark.y - 6))).toBeLessThan(4);
  await full.getByTestId("comment-input").fill("凡例が読めない");
  await full.getByTestId("comment-input").press("Control+Enter");

  // ---- 1行目の文を選んでコメント ------------------------------------------------------------------------------
  const line0 = await lineBox(full, "第1章");
  await drag(page, full, [
    [line0.x + 1, line0.y + line0.height / 2],
    [line0.x + line0.width + 30, line0.y + line0.height / 2],
  ]);
  await chip.click();
  await expect(full.getByTestId("comment-draft-anchor")).toHaveText("1ページ「第1章 受信箱の見直し」");
  await full.getByTestId("comment-input").fill("結論を先に");
  await full.getByTestId("comment-add").click();
  await expect(full.getByTestId("comments-toggle-count")).toHaveText("3");
  await expect(full.getByTestId("comments-return")).toContainText("3");

  // ---- 余白のコメントは、指した所の高さに並ぶ（付けた順ではなく）-------------------------------------------------
  const items = full.getByTestId("comment-item");
  await expect(items).toHaveCount(3);
  await expect(items.getByTestId("comment-body")).toHaveText(["この章は短く", "凡例が読めない", "結論を先に"]);
  // スクロールで動くので、同じ時に測る
  const now = {
    page2: (await full.locator('.pdf-page[data-page="2"]').boundingBox())!.y,
    region: (await full.locator('[data-testid="comment-mark"][data-kind="region"]').boundingBox())!.y,
    text: (await full.locator('[data-testid="comment-mark"][data-kind="text"]').first().boundingBox())!.y,
  };
  const tops = await Promise.all([0, 1, 2].map(async (i) => (await items.nth(i).boundingBox())!.y));
  expect(Math.abs(tops[0]! - (now.page2 - 6)), "2ページ目へのコメントがそのページの高さに無い").toBeLessThan(4);
  expect(Math.abs(tops[1]! - (now.region - 6)), "範囲へのコメントがその高さに無い").toBeLessThan(4);
  expect(Math.abs(tops[2]! - (now.text - 6)), "文へのコメントがその行の高さに無い").toBeLessThan(4);
  let line = await lineBox(full, "第1章");

  // ---- 押すと強調（余白→印、印→余白）--------------------------------------------------------------------
  await items.nth(1).click();
  await expect(items.nth(1)).toHaveClass(/focused/);
  await expect(full.locator('[data-testid="comment-mark"][data-kind="region"]')).toHaveClass(/focused/);
  line = await lineBox(full, "第1章");
  await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
  await expect(items.nth(2)).toHaveClass(/focused/);
  await expect(items.nth(1)).not.toHaveClass(/focused/);
  await expect(full.locator('.pdf-page[data-page="2"] [data-testid="comment-mark"][data-kind="page"]')).toHaveCount(1);

  // ---- コメントモードを切る：余白・印・ページの行の「コメント」は消え、選んでも「コメント」は出ない。付けたものは残る ----------
  await full.getByTestId("comments-toggle").click();
  await expect(full.getByTestId("comments-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(margin).toBeHidden();
  await expect(full.getByTestId("comment-mark")).toHaveCount(0);
  await expect(full.getByTestId("comment-for-page").first()).toBeHidden();
  line = await lineBox(full, "第1章");
  await drag(page, full, [
    [line.x + 1, line.y + line.height / 2],
    [line.x + line.width + 30, line.y + line.height / 2],
  ]);
  expect(await full.locator("body").evaluate(() => window.getSelection()?.toString() ?? "")).toBe("第1章 受信箱の見直し");
  await page.waitForTimeout(300);
  await expect(chip).toBeHidden();
  await drag(page, full, [regionFrom, regionTo]);
  await expect(chip).toBeHidden();
  await expect(full.getByTestId("comments-toggle-count")).toHaveText("3");
  await expect(full.getByTestId("comments-return")).toBeVisible();
  // 入れ直すとまた出る
  await full.getByTestId("comments-toggle").click();
  await expect(full.getByTestId("comment-item")).toHaveCount(3);
  await expect(full.locator('[data-testid="comment-mark"][data-kind="region"]')).toHaveCount(1);
  await expect(full.locator('[data-testid="comment-mark"][data-kind="page"]')).toHaveCount(1);
  await expect(full.locator('[data-testid="comment-mark"][data-kind="text"]').first()).toBeVisible();

  // ---- 大きく開いた画面（会話の隣）からも AI に返せる ----------------------------------------------------------------
  await full.getByTestId("comments-return").click();
  await expect(page.getByTestId("canvas-quote").getByTestId("canvas-quote-head")).toHaveText(
    [
      "`docs/plan.pdf` へのコメント（3件）",
      "1. 2ページ：この章は短く",
      "2. 1ページの範囲（右）：凡例が読めない",
      "3. 1ページ「第1章 受信箱の見直し」：結論を先に",
    ].join("\n"),
    { timeout: 15_000 },
  );
  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
