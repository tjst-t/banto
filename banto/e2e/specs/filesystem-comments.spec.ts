// **PDF にコメントを付けて AI に返す**（v4-modules.md §2.2「PDF・Office…」の「コメント」・v4-frontend.md §6.2「画面から
// 会話の入力欄へ文を渡す」、Backlog #307、2026-10-15）。
//
// 規則14——押せたで終わらせず、画面が出している中身を一つずつ見る：一覧の件数・指した場所の見出し・コメントの文・
// ツールバーの数・飛んだ先の印、入力欄の塊の出所と中身の頭と全文、送った発言の塊、AI に届いた本文、記録。
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

/** 1ページ目の文字の層で、最初の3つの要素を選ぶ（人がドラッグして選んだのと同じ選択） */
async function selectFirstLine(view: FrameLocator): Promise<string> {
  await expect(view.locator('.pdf-page[data-page="1"].rendered .textLayer span').first()).toBeVisible({ timeout: 60_000 });
  return view.locator('.pdf-page[data-page="1"] .textLayer').evaluate((layer) => {
    const spans = [...layer.querySelectorAll("span")].filter((s) => s.textContent);
    const range = document.createRange();
    range.setStartBefore(spans[0]!);
    range.setEndAfter(spans[2]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
}

const CARD = '[data-testid="inline-module-view"][data-module="filesystem"]';

function card(page: Page): FrameLocator {
  return page.locator(CARD).frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
}

test("PDF の選んだ文・範囲・ページ（と表のセル）にコメントを付け、AI に返すと入力欄に塊が出て、送ると出所つきで AI に届く", async ({ page }) => {
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

  // ---- 一覧を開く：まだ何も無い。会話の中なので「AI に返す」（押せない）があり、「コピー」は無い ----------------
  await expect(view.getByTestId("comments-panel")).toBeHidden();
  await view.getByTestId("comments-toggle").click();
  await expect(view.getByTestId("comments-panel")).toBeVisible();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（0件）");
  await expect(view.getByTestId("comments-return")).toBeDisabled();
  await expect(view.getByTestId("comments-copy")).toHaveCount(0);
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("");

  // ---- 選んだ文にコメント ---------------------------------------------------------------
  expect(await selectFirstLine(view)).toBe("第1章 受信箱の見直し");
  await view.getByTestId("comment-from-selection").click();
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText("1ページ「第1章 受信箱の見直し」");
  await view.getByTestId("comment-input").fill("ここは結論を先に");
  await view.getByTestId("comment-add").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（1件）");
  await expect(view.getByTestId("comment-draft")).toHaveCount(0);

  // ---- ドラッグした範囲にコメント（ページの左上を囲む）---------------------------------------
  await view.getByTestId("comment-region").click();
  await expect(view.getByTestId("comment-region")).toHaveAttribute("aria-pressed", "true");
  // 会話の中のカード（ページを並べる枠は 520px）は試験のブラウザの画面より高く、会話は一番下へスクロールしているので、
  // 1ページ目の頭は画面の外にあることがある（スクロールしても会話の自動スクロールで戻る）。画面に見えている部分のうち、
  // ページの上 1/3 に入るところを囲む
  const box = (await view.locator('.pdf-page[data-page="1"]').boundingBox())!;
  // 画面の上には会話のヘッダが重なっている——押した所が本当にカード（iframe）の上になる最初の高さから始める
  const x0 = box.x + box.width * 0.1;
  let top = Math.max(box.y, 0) + 10;
  while (top < box.y + box.height / 3 && !(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.tagName === "IFRAME", [x0, top]))) top += 10;
  top += 10;
  const bottom = Math.min(top + 100, box.y + box.height / 3 - 10);
  expect(bottom - top).toBeGreaterThan(40);
  await page.mouse.move(x0, top);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, (top + bottom) / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.4, bottom, { steps: 4 });
  await page.mouse.up();
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText("1ページの範囲（左上）");
  await expect(view.getByTestId("comment-region")).toHaveAttribute("aria-pressed", "false");
  await view.getByTestId("comment-input").fill("凡例が読めない");
  await view.getByTestId("comment-add").click();

  // ---- ページにコメント ----------------------------------------------------------------
  await view.getByTestId("comment-for-page").click();
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText("1ページ");
  await view.getByTestId("comment-input").fill("この章は消す");
  await view.getByTestId("comment-add").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（3件）");
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("3");

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

  // ---- 読み込み直しても残る（置き場は FileSystem の Project ごとの置き場）---------------------------------
  await page.reload();
  view = card(page);
  await expect(view.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });
  await expect(view.getByTestId("comments-toggle-count")).toHaveText("4", { timeout: 30_000 });

  // ---- 画面が勝手に ui/message を呼んでも入らない（人が押した直後ではない）----------------------------------
  const sneaky = await rawRequest(view, "ui/message", { role: "user", content: [{ type: "text", text: "勝手に入れた文" }] }, 6_000);
  expect(sneaky.result, "人の操作なしの ui/message を受けた").toEqual({ isError: true });
  await expect(page.getByTestId("canvas-quote")).toHaveCount(0);

  await view.getByTestId("comments-toggle").click();
  expect(await listed(view)).toEqual([
    { anchor: "1ページ「第1章 受信箱の見直し」", body: "ここは結論を先に" },
    { anchor: "1ページの範囲（左上）", body: "凡例が読めない" },
    { anchor: "1ページ", body: "この章は消す" },
    { anchor: "`シート1!D4`（値 1,200）", body: "単価が古い" },
  ]);
  // ファイルは変わっていない——印は出ない
  await expect(view.getByTestId("comment-changed")).toHaveCount(0);

  // ---- 押すと飛ぶ：範囲には枠、文には印 ----------------------------------------------------------
  await view.getByTestId("comment-anchor").nth(1).click();
  await expect(view.locator('.pdf-page[data-page="1"] [data-testid="comment-region-focus"]')).toBeVisible();
  await view.getByTestId("comment-anchor").nth(0).click();
  await expect(view.locator('.pdf-page[data-page="1"] [data-testid="comment-region-focus"]')).toHaveCount(0);
  // 文字の層の部品の分け方（空白だけの部品があるか）は pdf.js の描き方次第なので、つなげて空白を除いた文で比べる
  await expect
    .poll(async () => (await view.locator('.pdf-page[data-page="1"] .textLayer .comment-focus').allTextContents()).join("").replace(/\s/g, ""))
    .toBe("第1章受信箱の見直し");

  // ---- 直す・消す --------------------------------------------------------------------
  await view.getByTestId("comment-item").nth(1).getByTestId("comment-edit").click();
  await view.getByTestId("comment-edit-input").fill("左上の図の凡例が読めない");
  await view.getByTestId("comment-edit-save").click();
  await view.getByTestId("comment-item").nth(2).getByTestId("comment-delete").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（3件）");
  expect(await listed(view)).toEqual([
    { anchor: "1ページ「第1章 受信箱の見直し」", body: "ここは結論を先に" },
    { anchor: "1ページの範囲（左上）", body: "左上の図の凡例が読めない" },
    { anchor: "`シート1!D4`（値 1,200）", body: "単価が古い" },
  ]);

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
    "2. 1ページの範囲（左上）：左上の図の凡例が読めない",
    "3. `シート1!D4`（値 1,200）：単価が古い",
  ].join("\n");
  await expect(quote.getByTestId("canvas-quote-head")).toHaveText(expected);
  // 一覧は空になり、1回だけ戻せる
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（0件）");
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
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（3件）");
  await expect(view.getByTestId("comments-undo")).toHaveCount(0);
  await view.getByTestId("comment-item").nth(2).getByTestId("comment-delete").click();
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（2件）");
  await view.getByTestId("comments-return").click();
  const twoLines = [
    "`docs/plan.pdf` へのコメント（2件）",
    "1. 1ページ「第1章 受信箱の見直し」：ここは結論を先に",
    "2. 1ページの範囲（左上）：左上の図の凡例が読めない",
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
  await expect(view.getByTestId("comments-count")).toHaveText("コメント（0件）");
  await view.getByTestId("comment-for-page").click();
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
