// **AI が Memory を取り消す・改める tool と、確認のカード**（アーキ仕様 §2.2「AI が取り消しと『改める』を頼める」、Backlog #330。
// 改訂・2026-10-18：「承認をすべて自動で許可する」がオンなら聞かずに通す・取り消した行は人にも見せない）。
//
// 見ること（画面と host の記録で）：
//   1. 自動で許可がオフなら、AI が revise_memory を呼ぶと会話に確認のカードが出る（理由・取り消す行の番号と文・足す行の全文、
//      「変える」「変えない」）。「変えない」を押すと何も変わらない
//   2. 自動で許可がオンなら、カードは押さずに「自動で許可しました」の答え済みで出て、新しい行が足され元の行は取り消される
//   3. 取り消した行は host の一覧（GET /api/projects/:id/memory）にも Project の設定の Memory の一覧にも出ない
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, openProjectSettings, waitTurnEnded } from "../helpers.js";

test.setTimeout(180_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Memory = { seq: number; text: string; invalidated: boolean; originThreadId?: string };

test("AI の revise_memory は自動で許可がオフならカードで聞き、オンなら聞かずに改め、取り消した行は見せない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, "E2E Memory Revise", mkdtempSync(join(tmpdir(), "banto-e2e-memory-revise-")));
  const projectId = currentProjectId(page);
  const memoryApi = `${CORE_BASE_URL}/api/projects/${projectId}/memory`;
  const memory = async () => (await (await page.request.get(memoryApi, { headers })).json()) as Memory[];
  for (const text of ["置き場は ghq 形式", "置き場は ~/banto に改める"]) {
    expect((await page.request.post(memoryApi, { headers, data: { text } })).status()).toBe(201);
  }
  const [oldA, oldB] = await memory();
  const baseId = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as Array<{ id: string; kind: string }>
  ).find((t) => t.kind === "base")!.id;

  const composer = page.getByPlaceholder(/に送る/);
  const cards = page.locator('[data-role="judgment-card"]');
  const revise = (then: string) =>
    fakeTurn({
      tools: [
        {
          server: "banto-memory",
          name: "revise_memory",
          args: { reason: "改めた古い決まりを畳む", changes: [{ retract: [oldA!.seq, oldB!.seq], text: "置き場は ~/banto" }] },
        },
      ],
      then,
    });

  // ---- 1. 自動で許可がオフ：カードで聞く・変えない ------------------------------------------------------------
  await page.goto(`/p/${projectId}`);
  await composer.fill("Memory を棚卸しして。" + revise("1回目、お返事をいただきました。"));
  await composer.press("Enter");
  const denyCard = cards.filter({ hasText: "Memory の 2 行を取り消し、1 行を足してよいですか" });
  await expect(denyCard, "Memory を変えるカードが出ない").toHaveCount(1, { timeout: 60_000 });
  await expect(denyCard).toContainText("改めた古い決まりを畳む");
  await expect(denyCard).toContainText(`#${oldA!.seq}「置き場は ghq 形式」`);
  await expect(denyCard).toContainText("置き場は ~/banto");
  // 取り消す行は全文を、改行で折り返して読める形で出す（2026-10-16、ユーザー「削除するメモリの内容がわからない」）
  await expect(denyCard.getByTestId("tool-input-details")).toBeVisible();
  await expect(denyCard).not.toContainText("\\n");
  await expect(denyCard).toContainText(`#${oldB!.seq}「置き場は ~/banto に改める」`);
  await expect(denyCard.getByRole("button", { name: "変える", exact: true })).toBeVisible();
  await denyCard.getByRole("button", { name: "変えない", exact: true }).click();
  await expect(denyCard).toContainText("回答：変えない", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 1, 60_000);
  expect((await memory()).map((m) => m.seq), "断ったのに変わっている").toEqual([oldA!.seq, oldB!.seq]);

  // ---- 2. 自動で許可がオン：聞かずに改める --------------------------------------------------------------------
  const on = await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/auto-approve`, { headers, data: { enabled: true } });
  expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
  await page.goto(`/p/${projectId}`);
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveText("自動で許可中", { timeout: 30_000 });
  await composer.fill("もう一度。" + revise("2回目、お返事をいただきました。"));
  await composer.press("Enter");
  await waitTurnEnded(page, baseId, 2, 60_000);
  // 途中で読み込み直したので、前のターンのカードは描かれない——このターンのカードだけを見る
  const autoCard = cards.filter({ hasText: "Memory の 2 行を取り消し" }).last();
  await expect(autoCard).toContainText("回答：自動で許可しました", { timeout: 30_000 });
  await expect(autoCard.getByRole("button", { name: "変える", exact: true })).toHaveCount(0);

  // ---- 3. 取り消した行は host の一覧にも設定の画面にも出ない ---------------------------------------------------
  const after = await memory();
  expect(after.map((m) => m.text), "取り消した行が一覧に残っている・新しい行が無い").toEqual(["置き場は ~/banto"]);
  expect(after[0]).toMatchObject({ invalidated: false, originThreadId: baseId });
  await openProjectSettings(page, "Memory");
  const panel = page.getByTestId("project-memory-panel");
  await expect(panel.locator("li")).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.locator("li")).toContainText(`#${after[0]!.seq}置き場は ~/banto`);
  await expect(panel).not.toContainText("ghq 形式");
  await expect(panel).not.toContainText("に改める");
  expect(pageErrors).toEqual([]);
});
