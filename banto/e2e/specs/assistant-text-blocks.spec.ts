// **流れているときと、記録から組み直したとき（リロード後）で、AI の発言が同じに見える**
// （`live-text-join-differs-from-record`、2026-09-26、ユーザー指示で直す）。
//
// SDK は AI の文を**ブロックごとに別のメッセージ**で届ける。別々に届く文は別々の発言
// （別の応答・CLI が出す「API Error: …」など——実データで測った、`docs/notes/2026-09-26-text-block-join.md`）。
// 以前は、流れている吹き出しは改行なしで貼り合わせ（「…です。API Error: …」がくっつく）、記録は改行1つで
// つないでいた（Markdown では同じ段落）。どちらも**段落を分ける**に揃えた。
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitTurnEnded } from "../helpers.js";

test.setTimeout(120_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Text Blocks";

async function baseThreadId(page: Page): Promise<string> {
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json();
  return threads[0].id;
}

async function lastRecordedAssistant(page: Page): Promise<string | undefined> {
  const t = await (await page.request.get(`${CORE_BASE_URL}/api/threads/${await baseThreadId(page)}`, { headers: HEADERS })).json();
  return (t.messages as { role: string; text: string }[]).filter((m) => m.role === "assistant").at(-1)?.text;
}

/** 最後の AI の発言の段落（`<p>`）の中身 */
async function paragraphs(page: Page): Promise<string[]> {
  return (await page.locator('[data-role="assistant"]').last().locator("p").allInnerTexts()).map((t) => t.trim());
}

test("別々に届いた文は、流れているときもリロード後も、別の段落として同じに出る", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-textblocks-")));

  // 偽 Runner は `streamMs` のとき、行ごとに別の assistant メッセージとして届ける（本物の SDK のブロックと同じ形）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("2つに分けて答えて。" + fakeTurn({ say: "最初の段落です。\n2つ目の段落です。", streamMs: 400 }));
  await composer.press("Enter");

  // 記録に返事が入るまで待つ（流れている途中ではなく、終わった形で比べる）
  // （返事は書き終えるごとに記録に入るので、最初の段落が入った時点ではまだ終わっていない——ターンの終わりを待つ。2026-10-05）
  await waitTurnEnded(page, await baseThreadId(page), 1);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });

  // 流れていたときの見え方：2つの段落（貼り合わさっていない）
  await expect.poll(() => paragraphs(page)).toEqual(["最初の段落です。", "2つ目の段落です。"]);
  // 記録も段落を分けてつないでいる
  expect(await lastRecordedAssistant(page)).toBe("最初の段落です。\n\n2つ目の段落です。");

  // リロード（記録から組み直す）しても同じ見え方
  await page.reload();
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => paragraphs(page), { timeout: 30_000 }).toEqual(["最初の段落です。", "2つ目の段落です。"]);
});
