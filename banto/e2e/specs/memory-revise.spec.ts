// **AI が Memory を取り消す・改める tool と、必ず人に聞くカード**（アーキ仕様 §2.2「取り消した行は AI に渡さない・
// AI が取り消しと『改める』を頼める」、Backlog #330）。
//
// 見ること（画面と host の記録で）：
//   1. 「承認をすべて自動で許可する」がオンでも、AI が revise_memory を呼ぶと会話に確認のカードが出る（理由・取り消す行の
//      番号と文の頭・足す行の全文、「変える」「変えない」）
//   2. 「変えない」を押すと何も変わらない
//   3. 「変える」を押すと、新しい行が足され、元の行は取り消され、理由と置き換え先が残る。Project の設定の Memory の一覧に
//      「#<番号> に改めました（理由）」が出る
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, openProjectSettings, waitTurnEnded } from "../helpers.js";

test.setTimeout(180_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Memory = { seq: number; text: string; invalidated: boolean; invalidatedReason?: string; replacedBy?: number; originThreadId?: string };

test("AI の revise_memory は自動で許可がオンでもカードで聞き、断ると変わらず、許すと改める", async ({ page }) => {
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

  const on = await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/auto-approve`, { headers, data: { enabled: true } });
  expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
  await page.goto(`/p/${projectId}`);
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveText("自動で許可中", { timeout: 30_000 });

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

  // ---- 1・2. 変えない ----------------------------------------------------------------------------------------
  await composer.fill("Memory を棚卸しして。" + revise("1回目、お返事をいただきました。"));
  await composer.press("Enter");
  const denyCard = cards.filter({ hasText: "Memory の 2 行を取り消し、1 行を足してよいですか" });
  await expect(denyCard, "自動で許可がオンなのに、Memory を変えるカードが出ない").toHaveCount(1, { timeout: 60_000 });
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
  expect((await memory()).every((m) => !m.invalidated), "断ったのに取り消されている").toBe(true);
  expect(await memory()).toHaveLength(2);

  // ---- 3. 変える -----------------------------------------------------------------------------------------------
  await composer.fill("もう一度。" + revise("2回目、お返事をいただきました。"));
  await composer.press("Enter");
  const allowCard = cards.filter({ hasText: "Memory の 2 行を取り消し、1 行を足してよいですか" }).last();
  await expect(cards.filter({ hasText: "Memory の 2 行を取り消し" })).toHaveCount(2, { timeout: 60_000 });
  await allowCard.getByRole("button", { name: "変える", exact: true }).click();
  await expect(allowCard).toContainText("回答：変える", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 2, 60_000);

  const after = await memory();
  const added = after.find((m) => m.text === "置き場は ~/banto")!;
  expect(added, "新しい行が足されていない").toBeTruthy();
  expect(added.invalidated).toBe(false);
  expect(added.originThreadId).toBe(baseId);
  for (const seq of [oldA!.seq, oldB!.seq]) {
    expect(after.find((m) => m.seq === seq)).toMatchObject({ invalidated: true, invalidatedReason: "改めた古い決まりを畳む", replacedBy: added.seq });
  }

  // 人の Memory の一覧に番号と「改めました」が出る
  await openProjectSettings(page, "Memory");
  await expect(page.getByText(`#${added.seq} に改めました（改めた古い決まりを畳む）`)).toHaveCount(2, { timeout: 15_000 });
  expect(pageErrors).toEqual([]);
});
