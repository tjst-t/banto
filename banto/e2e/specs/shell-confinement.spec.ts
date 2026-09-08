// Shell Module が Project の外へ出られないこと（Phase 1、`phase1-modules-verified-in-browser`）。
//
// **これは「やったらできた」ではなく「やってもできない」を見るテスト。**
// 閉じ込め（Landlock）は壊れていても静かで、普通の作業は Project の中で完結するため
// **全部成功してしまう**。壊れているのは「外に出られてしまう」ときだけ分かる。
//
// 両側から見る（片側だけでは証明にならない）：
//   - Project の中は**読める**   ……Shell そのものが動いていることの確認
//   - Project の外は**読めない** ……閉じ込めが効いていることの確認
// 中も外も失敗するなら、それは閉じ込めではなく Shell が壊れているだけ。
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Shell Confinement";

test("Shell は Project の中を読めて、外は読めない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-shell-"));
  // **許可リストに無い場所**に置く。`/etc` や PATH の下は読み取りが許されているので
  // そこを使うと「外に出られた」の証明にならない（v4-security.md の許可リストの組み方）
  const outsideDir = mkdtempSync(join(tmpdir(), "banto-e2e-outside-"));

  const insideMarker = `中は読める${Date.now()}`;
  const outsideSecret = `外は読めないはず${Date.now()}`;
  writeFileSync(join(projectRoot, "inside.txt"), `${insideMarker}\n`);
  writeFileSync(join(outsideDir, "outside.txt"), `${outsideSecret}\n`);

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // **落ちたときに証拠を残す**（規則6——間欠に落ちるものは、待ちを延ばさず測る）。
  // `ui-codeblock-cjk`：画面の文字が途中で止まる。止まったのが
  // 「絵を描く側（rAF が回っていない）」なのか「文字が届いていない側」なのかは、
  // 落ちた瞬間の状態を見ないと分からない
  await page.addInitScript(() => {
    (window as unknown as { __rafTicks: number }).__rafTicks = 0;
    const tick = () => {
      (window as unknown as { __rafTicks: number }).__rafTicks++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  const composer = page.getByPlaceholder(/に送る/);
  const threadId = await (async () => {
    const projects = await (
      await page.request.get(`${CORE_BASE_URL}/api/projects`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      })
    ).json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
    const threads = await (
      await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      })
    ).json();
    return threads[0].id as string;
  })();

  // --- ① Project の中は読める（Shell が動いていることの確認） ---
  await composer.fill(
    `shell の runCommand で \`cat ${join(projectRoot, "inside.txt")}\` を実行して、出力をそのまま見せて。`,
  );
  await composer.press("Enter");
  try {
    await expect(page.getByText(insideMarker, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
  } catch (err) {
    throw new Error(`${(err as Error).message}\n\n${await captureFreezeEvidence(page, threadId, insideMarker)}`);
  }

  // --- ② Project の外は読めない ---
  await composer.fill(
    `次に shell の runCommand で \`cat ${join(outsideDir, "outside.txt")}\` を実行して、` +
      `成功しても失敗しても、その結果をそのまま報告して。`,
  );
  await composer.press("Enter");

  // ターンが終わるまで待つ（assistant の返事が増えるまで）
  const assistantCount = async () => {
    const t = await (
      await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      })
    ).json();
    return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
  };
  const before = await assistantCount();
  await expect.poll(assistantCount, { timeout: 180_000 }).toBeGreaterThan(before);

  // **外の中身が、画面にも記録にも出ていないこと**——閉じ込めが破れていたら必ず出る
  await expect(page.getByText(outsideSecret, { exact: false })).toHaveCount(0);
  const thread = await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  expect(
    (thread.messages as { text: string }[]).some((m) => m.text.includes(outsideSecret)),
    "Project の外のファイルの中身が会話に入っている＝閉じ込めが効いていない",
  ).toBe(false);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});

/**
 * 文字が途中で止まったときの証拠を集める（`ui-codeblock-cjk`）。
 *
 * 見たいのは「どちらが止まったか」：
 *   - **絵を描く側**なら、rAF が進んでいない／`data-status="running"` のまま残る
 *     （assistant-ui の typewriter は requestAnimationFrame で1文字ずつ出す）
 *   - **文字が届いていない側**なら、host には全文があるのに画面の文字が短いまま
 *
 * 2026-09-07 の犯人は**どちらでもなく**、コードブロックの部分木だけが memo 化で
 * 取り残されていた（`markdown-text.tsx` の直し、`docs/notes/2026-09-07-...`）。
 * この採取は残す——次に同じ形で落ちたとき、また一から測り直さないため。
 */
async function captureFreezeEvidence(page: Page, threadId: string, marker: string): Promise<string> {
  const thread = await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  const hostTexts = (thread.messages as { role: string; text: string }[]).map(
    (m) => `${m.role}: ${JSON.stringify(m.text.slice(0, 400))}`,
  );
  const ticksA = await page.evaluate(() => (window as unknown as { __rafTicks: number }).__rafTicks);
  await page.waitForTimeout(1000);
  const dom = await page.evaluate(() => ({
    ticks: (window as unknown as { __rafTicks: number }).__rafTicks,
    markdown: Array.from(document.querySelectorAll(".aui-md")).map((el) => ({
      status: el.getAttribute("data-status"),
      text: (el.textContent ?? "").slice(0, 400),
    })),
    body: (document.body.textContent ?? "").slice(0, 600),
  }));
  return [
    `--- 止まった位置の証拠（marker=${JSON.stringify(marker)}） ---`,
    `[HOST] ${hostTexts.join("\n       ")}`,
    `[DOM markdown] ${JSON.stringify(dom.markdown, null, 1)}`,
    `[rAF] 1秒間のフレーム数 = ${dom.ticks - ticksA}（0 なら描画側が止まっている）`,
    `[BODY] ${JSON.stringify(dom.body)}`,
  ].join("\n");
}
