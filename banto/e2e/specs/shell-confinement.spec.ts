// Shell Module が Project の外へ出られないこと（Phase 1、`phase1-modules-verified-in-browser`）。
//
// **これは「やったらできた」ではなく「やってもできない」を見るテスト。**
// 閉じ込め（Project のコンテナ）は壊れていても静かで、普通の作業は Project の中で完結するため
// **全部成功してしまう**。壊れているのは「外に出られてしまう」ときだけ分かる。
//
// 両側から見る（片側だけでは証明にならない）：
//   - Project の中は**読める**   ……Shell そのものが動いていることの確認
//   - Project の外は**読めない** ……閉じ込めが効いていることの確認
// 中も外も失敗するなら、それは閉じ込めではなく Shell が壊れているだけ。
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";

/**
 * **AI を通さずに、AI が通る経路そのもの**（代理サーバ）で runCommand を呼ぶ。
 *
 * 会話越しの検証だけでは「AI が tool を呼ばずに断った」場合と区別が付かず、
 * **閉じ込めが壊れていても緑になる**（規則14、2026-09-10）。ここは AI の気まぐれを
 * 挟まずに、**実際に呼んで、実際に断られたこと**を見る。
 */
async function runThroughAgentRelay(
  projectId: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const client = new Client({ name: "e2e-shell-confinement", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/shell-${projectId}`), {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: "runCommand", arguments: { command } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
    return JSON.parse(text) as { stdout: string; stderr: string; exitCode: number | null };
  } finally {
    await client.close();
  }
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Shell Confinement";

test("Shell は Project の中を読めて、外は読めない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-shell-"));
  // **コンテナに見せていない場所**に置く。`/etc` や PATH の下はコンテナの中にも（別の中身で）あるので
  // そこを使うと「外に出られた」の証明にならない
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
  await createProject(page, PROJECT_NAME, projectRoot);

  const composer = page.getByPlaceholder(/に送る/);
  const { threadId, projectId } = await (async () => {
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
    return { threadId: threads[0].id as string, projectId: project.id as string };
  })();

  // --- ① Project の中は読める（Shell が動いていることの確認） ---
  await composer.fill(
    "Project の中のファイルを読んでください。" +
      fakeTurn({
        tools: [
          { server: "shell", name: "runCommand", args: { command: `cat ${join(projectRoot, "inside.txt")}` } },
        ],
      }),
  );
  await composer.press("Enter");
  try {
    await expect(page.getByText(insideMarker, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
  } catch (err) {
    throw new Error(`${(err as Error).message}\n\n${await captureFreezeEvidence(page, threadId, insideMarker)}`);
  }

  // --- ② Project の外は読めない ---
  await composer.fill(
    "次に Project の外のファイルを読んでください。" +
      fakeTurn({
        tools: [
          { server: "shell", name: "runCommand", args: { command: `cat ${join(outsideDir, "outside.txt")}` } },
        ],
      }),
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

  // --- ③ **実際に呼んで、実際に断られた**ことを見る（追加・2026-09-10、規則14）---
  //
  // ②までは「会話に外の中身が出ていない」しか見ていない——**AI が tool を呼ばずに
  // 「できません」と答えただけ**でも通ってしまう（閉じ込めが壊れていても緑）。
  // AI を挟まず、AI が通るのと同じ経路（代理サーバ）で runCommand を直接呼ぶ。
  const outside = await runThroughAgentRelay(projectId, `cat ${join(outsideDir, "outside.txt")}`);
  expect(outside.exitCode, "Project の外の読み取りが成功した＝閉じ込めが効いていない").not.toBe(0);
  expect(outside.stdout, "外のファイルの中身が返ってきた").not.toContain(outsideSecret);

  // **中は読める**（同じ経路で。中も外も失敗するなら、それは閉じ込めではなく
  // Shell が壊れているだけ——両側を同じ道具で見る）
  const inside = await runThroughAgentRelay(projectId, `cat ${join(projectRoot, "inside.txt")}`);
  expect(inside.exitCode, "Project の中の読み取りまで失敗している（Shell が壊れている）").toBe(0);
  expect(inside.stdout).toContain(insideMarker);

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
