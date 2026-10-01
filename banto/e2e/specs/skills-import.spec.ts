// **Skill の取り込み**（決定・2026-09-23、アーキ仕様 §5.7「取り込むかどうかは人が決める。
// AI は提案できる」）。
//
// 見ること（規則14——画面が出るだけでなく、出ている中身と、その結果まで）：
//
// 1. AI が `import_skill` を呼ぶと、会話の中に**取り込む前の確認**が出る——出所
//    （リポジトリ・フォルダ・ref・固定した commit）、`SKILL.md` の中身、`scripts/` の有無、
//    届かない記述。**押すまで置き場には入らない**。「取り込まない」を押せば入らない
// 2. 「取り込む」を押すと入り、core の Skill の一覧に出る（効いてはいない）
// 3. 人が設定の「Skill の置き場」から ZIP を取り込め、入っているものを出所つきで見て、消せる
//
// GitHub は偽物（`e2e/github-fixture.ts`）。**本物を叩かない**（規則6）。

import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp } from "../helpers.js";
import {
  GITHUB_FIXTURE_COMMIT,
  GITHUB_FIXTURE_DESCRIPTION,
  GITHUB_FIXTURE_REPO,
  GITHUB_FIXTURE_SKILL,
} from "../github-fixture.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Skill Import";
const ZIP_SKILL = "e2e-ume";
const ZIP_NAME = `${ZIP_SKILL}.zip`;

test.describe.configure({ mode: "serial" });

/** core が見ている Skill の一覧（banto 全体の層）。 */
async function coreSkills(page: Page): Promise<Array<{ name: string; enabled: boolean }>> {
  const res = await page.request.get(`${CORE_BASE_URL}/api/skills`, { headers: HEADERS });
  return ((await res.json()) as { skills: Array<{ name: string; enabled: boolean }> }).skills;
}

/**
 * **何があっても後片づけする**——同じ実行の `skills.spec.ts` は置き場に自分の1本しか
 * 無いことを数えている。人の操作と同じ口（`remove_skill`）で消す。
 */
test.afterAll(async ({ request }) => {
  for (const name of [GITHUB_FIXTURE_SKILL, ZIP_SKILL]) {
    await request
      .post(`${CORE_BASE_URL}/api/ui-tool-call`, {
        headers: HEADERS,
        data: { server: "skills", tool: "remove_skill", arguments: { name } },
      })
      .catch(() => undefined);
  }
});

function proposeImport(): string {
  return (
    "この Skill を取り込みたい。" +
    fakeTurn({
      tools: [{ server: "skills", name: "import_skill", args: { source: `${GITHUB_FIXTURE_REPO}/skills/${GITHUB_FIXTURE_SKILL}` } }],
    })
  );
}

/** 会話の中の、いちばん新しい Module の画面。 */
function lastCanvas(page: Page) {
  return page.locator('[data-testid="module-canvas-frame"]').last().contentFrame().frameLocator("iframe");
}

test("AI が取り込みを提案すると、会話の中に取り込む前の確認が出る——「取り込まない」なら入らない", async ({
  page,
}) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-skill-import-")));
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(proposeImport());
  await composer.press("Enter");

  const frame = lastCanvas(page);
  await expect(frame.getByText("Skill の取り込み——取り込む前の確認")).toBeVisible({ timeout: 60_000 });
  await expect(frame.locator("#preview-title")).toHaveText(`Skill「${GITHUB_FIXTURE_SKILL}」`, { timeout: 30_000 });
  // **出所**——どのリポジトリの、どのフォルダの、どの時点か（ref を省いたので commit に固定）
  const meta = frame.locator("#preview-meta");
  await expect(meta).toContainText(`GitHub ${GITHUB_FIXTURE_REPO} / skills/${GITHUB_FIXTURE_SKILL}`);
  await expect(meta).toContainText("（指定なし——既定のブランチ）");
  await expect(meta).toContainText(GITHUB_FIXTURE_COMMIT);
  await expect(meta).toContainText(GITHUB_FIXTURE_DESCRIPTION);
  // **SKILL.md の中身そのもの**
  await expect(frame.locator("#preview-skillmd")).toContainText("剪定は落葉期に行う。");
  // **scripts/ の有無と、届かない記述**（banto では実行されない）
  const warnings = frame.locator("#preview-warnings");
  await expect(warnings).toContainText("scripts/ が同梱されています");
  await expect(warnings).toContainText("9 行目：開花予想は `python scripts/forecast.py` で出す。");
  await expect(frame.locator("#preview-files")).toContainText("references/pruning.md");
  await expect(frame.locator("#preview-files")).toContainText("scripts/forecast.py");

  // **押すまで入らない**
  expect((await coreSkills(page)).map((s) => s.name)).not.toContain(GITHUB_FIXTURE_SKILL);

  await frame.getByRole("button", { name: "取り込まない" }).click();
  await expect(frame.locator("#result")).toHaveText("取り込みませんでした。", { timeout: 15_000 });
  expect((await coreSkills(page)).map((s) => s.name), "取り込まないと言ったのに入った").not.toContain(
    GITHUB_FIXTURE_SKILL,
  );
});

test("「取り込む」を押すと入り、core の Skill の一覧に出る（効かせてはいない）", async ({ page }) => {
  await openApp(page);
  await page.getByText(PROJECT_NAME, { exact: true }).first().click();
  const composer = page.getByPlaceholder(/に送る/);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(proposeImport());
  await composer.press("Enter");

  const frame = lastCanvas(page);
  await expect(frame.locator("#preview-title")).toHaveText(`Skill「${GITHUB_FIXTURE_SKILL}」`, { timeout: 60_000 });
  // まだ入っていないので「入れ替わる」は出ない
  await expect(frame.locator("#preview-warnings")).not.toContainText("同じ名前の Skill がもう入っています");
  await frame.getByRole("button", { name: "取り込む" }).click();
  await expect(frame.locator("#result")).toContainText(`取り込みました：Skill「${GITHUB_FIXTURE_SKILL}」`, {
    timeout: 15_000,
  });

  await expect
    .poll(async () => (await coreSkills(page)).find((s) => s.name === GITHUB_FIXTURE_SKILL), { timeout: 15_000 })
    .toEqual(expect.objectContaining({ name: GITHUB_FIXTURE_SKILL, enabled: false }));

  // 設定の Skill の一覧にも出る——効かせるかは人がここで選ぶ
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await page.getByRole("button", { name: "Skill", exact: true }).click();
  const row = page.locator(`[data-testid="skill-row"][data-skill="skills/${GITHUB_FIXTURE_SKILL}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(GITHUB_FIXTURE_DESCRIPTION);
  await expect(row).toHaveAttribute("data-state", "off");
});

test("「Skill の置き場」から人が ZIP を取り込み、出所つきで見て、消せる", async ({ page }) => {
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await page.getByRole("button", { name: "Skill の置き場", exact: true }).click();
  const pane = page.locator('[data-testid="module-settings-canvas"][data-module="skills"]');
  await expect(pane).toBeVisible({ timeout: 30_000 });
  const inner = pane.locator("iframe").contentFrame().frameLocator("iframe");

  // **入っているものが出所つきで出る**（前の試験で GitHub から入れたもの）
  const sakura = inner.locator(`[data-skill="${GITHUB_FIXTURE_SKILL}"]`);
  await expect(sakura).toContainText(`GitHub ${GITHUB_FIXTURE_REPO}`, { timeout: 30_000 });
  await expect(sakura).toContainText(GITHUB_FIXTURE_COMMIT);

  // ZIP を選んで中身を見る（入れ子のフォルダの中に Skill がある形）
  await inner.getByRole("button", { name: "ZIP", exact: true }).click();
  const zip = zipSync({
    [`download/${ZIP_SKILL}/SKILL.md`]: strToU8(
      `---\nname: ${ZIP_SKILL}\ndescription: ウメの扱い方。塩は 18%。\n---\n# ウメ\n\n梅干しは土用に干す。\n`,
    ),
  });
  await inner.locator("#zip-file").setInputFiles({ name: ZIP_NAME, mimeType: "application/zip", buffer: Buffer.from(zip) });
  await inner.getByRole("button", { name: "中身を見る" }).click();
  await expect(inner.locator("#preview-title")).toHaveText(`Skill「${ZIP_SKILL}」`, { timeout: 30_000 });
  await expect(inner.locator("#preview-meta")).toContainText(`ZIP ${ZIP_NAME}`);
  await expect(inner.locator("#preview-skillmd")).toContainText("梅干しは土用に干す。");
  await expect(inner.locator("#preview-warnings"), "scripts が無いのに警告が出ている").toBeEmpty();

  await inner.getByRole("button", { name: "取り込む" }).click();
  await expect(inner.locator("#result")).toContainText(`取り込みました：Skill「${ZIP_SKILL}」`, { timeout: 15_000 });
  await expect(inner.locator(`[data-skill="${ZIP_SKILL}"]`)).toContainText(`ZIP ${ZIP_NAME}`, { timeout: 15_000 });
  expect((await coreSkills(page)).map((s) => s.name)).toEqual(expect.arrayContaining([ZIP_SKILL, GITHUB_FIXTURE_SKILL]));

  // **消す**——押し間違いで消さない（2度目で消す）
  for (const name of [ZIP_SKILL, GITHUB_FIXTURE_SKILL]) {
    const entry = inner.locator(`[data-skill="${name}"]`);
    await entry.getByRole("button", { name: "消す" }).click();
    await expect(entry.getByRole("button", { name: "本当に消す" })).toBeVisible();
    expect((await coreSkills(page)).map((s) => s.name), "1度押しただけで消えた").toContain(name);
    await entry.getByRole("button", { name: "本当に消す" }).click();
    await expect(inner.locator(`[data-skill="${name}"]`)).toHaveCount(0, { timeout: 15_000 });
  }
  const left = (await coreSkills(page)).map((s) => s.name);
  expect(left).not.toContain(ZIP_SKILL);
  expect(left).not.toContain(GITHUB_FIXTURE_SKILL);
});
