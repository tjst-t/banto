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
import { test, expect } from "@playwright/test";
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
  await expect(page.getByText(insideMarker, { exact: false }).first()).toBeVisible({ timeout: 120_000 });

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
