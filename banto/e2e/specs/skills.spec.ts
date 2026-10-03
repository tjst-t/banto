// **Skill——Module が配り、core が効かせる**（決定・2026-09-23、アーキ仕様 §5.6・§5.7）。
//
// 見ること（規則14——操作が通るだけでなく、画面と会話に出る中身まで）：
//
// 1. 同梱の skills Module が置き場の Skill を配り、設定の一覧に名前・説明・配り手が出る。
//    画面から効かせると、行の状態と件数が変わる
// 2. 新しい会話の始まりに、効かせた Skill の名前・説明・本文の URI が `instructions`
//    として AI に届く。AI は本文も、本文が相対パスで指す兄弟ファイルも読める。
//    メーターに Skill の行と内訳、「この会話で効いている Skill」が出る
// 3. **設定を変えても、続いている会話は変わらない**（resume では読み直されない、実測）。
//    Clear すると新しい会話になり、変えた設定が効く。効かせていなくても本文は読める
// 4. Project の上書き——全体では外したまま、この Project でだけ効かせられる
//
// 偽 Runner は本物の MCP の口に繋いで `instructions` を受け取り、`sayContext` で
// 「banto が実際に送ったもの」をそのまま返す（`e2e/fake-runner.ts`）。

import { test, expect, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR, CORE_BROWSER_URL } from "../config.js";
import { createProject, expectProjectOpen, fakeTurn, openApp, openProjectSettings } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Skills";
const SKILL = "e2e-konpeito";
const SKILL_KEY = `skills/${SKILL}`;
/** 説明にだけ書いた事実（instructions で届く） */
const IN_DESCRIPTION = "推奨保存温度は 17 度";
/** 本文にだけ書いた事実（本文を読まないと分からない） */
const IN_BODY = "包む紙の色は群青色";
/** 兄弟ファイルにだけ書いた事実（本文の相対パスから辿る） */
const IN_REFERENCE = "湿度は 40% 以下に保つ";
/**
 * **instructions の中の、効いている Skill の行**。説明の文字列は本文の frontmatter にも
 * 入っているので、本文を読ませたターンでは「説明が出ているか」で instructions を
 * 見分けられない——行そのものを見る
 */
const ACTIVE_LINE = `**${SKILL}**（本文：\`skill://${SKILL}/SKILL.md\`）：コンペイトウの扱い方。${IN_DESCRIPTION}`;

test.describe.configure({ mode: "serial" });

/**
 * **同梱の skills Module の置き場に、Skill のフォルダを1つ置く**。取り込み口
 * （`import_skill`）はまだ無いので、ファイルを置く——Module はディスクを毎回見る
 * （写しを持たない）ので、置いた時点で配られる。
 */
test.beforeAll(() => {
  const dir = join(DATA_DIR, "modules", "skills", "skills", SKILL);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${SKILL}`,
      `description: コンペイトウの扱い方。${IN_DESCRIPTION}。コンペイトウを扱う仕事のときに使う。`,
      "---",
      "# コンペイトウの扱い",
      "",
      `${IN_BODY}。詳しい保存の仕方は [保存](references/storage.md) を読む。`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "references", "storage.md"), `# 保存\n\n${IN_REFERENCE}。\n`);
});

async function projectAndThread(page: Page): Promise<{ projectId: string; threadId: string }> {
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json()) as Array<{
    id: string;
    name: string;
  }>;
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threads = (await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
  ).json()) as Array<{ id: string; kind: string }>;
  return { projectId: project.id, threadId: threads.find((t) => t.kind === "base")!.id };
}

/** その Project の会話を開く（`/p/<id>`——入力欄が出るまで待つ）。 */
async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/p/${projectId}`);
  await expectProjectOpen(page, PROJECT_NAME);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
}

/** 1ターン送り、**そのターンが host に記録されるまで**待って、最後の返事を返す。 */
async function sendAndWait(page: Page, threadId: string, text: string): Promise<string> {
  const assistants = async () =>
    (
      (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()) as {
        messages: { role: string; text: string }[];
      }
    ).messages.filter((m) => m.role === "assistant");
  const before = (await assistants()).length;
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(text);
  await composer.press("Enter");
  await expect.poll(async () => (await assistants()).length, { timeout: 60_000 }).toBe(before + 1);
  return (await assistants()).at(-1)!.text;
}

const readBoth = fakeTurn({
  sayContext: true,
  resources: [
    { server: "skills", uri: `skill://${SKILL}/SKILL.md` },
    { server: "skills", uri: `skill://${SKILL}/references/storage.md` },
  ],
});

test("配られている Skill が設定の一覧に出て、画面から効かせられる", async ({ page }) => {
  await page.goto(`/settings?bantoHost=${CORE_BROWSER_URL}`);
  await page.getByRole("button", { name: "Skill", exact: true }).click();

  const row = page.locator(`[data-testid="skill-row"][data-skill="${SKILL_KEY}"]`);
  await expect(row, "置いた Skill が一覧に出ない").toBeVisible({ timeout: 20_000 });
  // **行の中身**——名前・説明・配っている Module
  await expect(row).toContainText(SKILL);
  await expect(row).toContainText(IN_DESCRIPTION);
  await expect(row).toContainText("skills");
  // 既定は「効かせない」（§5.7——黙って毎ターンの費用を増やさない）
  await expect(row).toHaveAttribute("data-state", "off");
  await expect(page.getByTestId("skills-enabled-count")).toHaveText("既定で効かせるもの：0 / 1");
  await expect(page.getByTestId("skills-problems"), "読めない Skill が出ている").toHaveCount(0);

  await row.getByRole("switch", { name: `${SKILL} を効かせる` }).click();
  await expect(row).toHaveAttribute("data-state", "on", { timeout: 10_000 });
  await expect(page.getByTestId("skills-enabled-count")).toHaveText("既定で効かせるもの：1 / 1");

  // 読み直しても残る（設定は host にある）
  await page.reload();
  await expect(page.locator(`[data-testid="skill-row"][data-skill="${SKILL_KEY}"]`)).toHaveAttribute(
    "data-state",
    "on",
    { timeout: 20_000 },
  );
});

test("新しい会話の始まりに名前と説明が届き、本文と兄弟ファイルも読める。メーターに内訳が出る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-skills-"));
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  const { threadId } = await projectAndThread(page);

  const reply = await sendAndWait(page, threadId, `文脈を見せて${readBoth}`);
  // ① instructions——名前・説明・本文の URI が、skills の案内として届いている
  expect(reply, "instructions が届いていない").toContain("## skills");
  expect(reply, "効かせた Skill の行（名前・本文の URI・説明）が無い").toContain(ACTIVE_LINE);
  // ② 本文（説明には無い事実）と、本文が相対パスで指す兄弟ファイル
  expect(reply, "本文が読めていない").toContain(IN_BODY);
  expect(reply, "兄弟ファイルが読めていない").toContain(IN_REFERENCE);
  // 画面にも同じものが出ている
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(IN_BODY);

  // ③ 会話に刻まれている
  const skills = (await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}/skills`, { headers: HEADERS })
  ).json()) as { set: { active: { name: string }[] } | null; footprint: { totalChars: number } };
  expect(skills.set?.active.map((s) => s.name)).toEqual([SKILL]);
  expect(skills.footprint.totalChars).toBeGreaterThan(0);

  // ④ メーター——Skill の行と、その内訳（Skill ごと）、この会話で効いている Skill
  await page.getByRole("button", { name: /文脈使用量/ }).click();
  const skillLine = page.getByRole("button", { name: /^Skill\s*[\d,]+（/ });
  await expect(skillLine, "メーターに Skill の行が無い").toBeVisible({ timeout: 15_000 });
  await skillLine.click();
  await expect(page.getByText(`${SKILL}（skills）`), "Skill ごとの内訳が出ない").toBeVisible();
  const threadSkills = page.getByTestId("thread-skills");
  await expect(threadSkills.getByTestId("thread-skill")).toHaveCount(1);
  await expect(threadSkills.getByTestId("thread-skill")).toContainText(SKILL);
  await expect(threadSkills.getByTestId("thread-skill")).toContainText(IN_DESCRIPTION);
  await page.keyboard.press("Escape");
});

test("設定を変えても続いている会話は変わらない。Clear すると変えた設定が効く", async ({ page }) => {
  await openApp(page);
  const { projectId, threadId } = await projectAndThread(page);

  // 全体で外す
  await page.goto(`/settings?bantoHost=${CORE_BROWSER_URL}`);
  await page.getByRole("button", { name: "Skill", exact: true }).click();
  const row = page.locator(`[data-testid="skill-row"][data-skill="${SKILL_KEY}"]`);
  await row.getByRole("switch", { name: `${SKILL} を外す` }).click();
  await expect(row).toHaveAttribute("data-state", "off", { timeout: 10_000 });

  // **続いている会話**——始まりに決まった集合のまま（resume では読み直されない）
  await openProject(page, projectId);
  const continued = await sendAndWait(page, threadId, `もう一度${fakeTurn({ sayContext: true })}`);
  expect(continued, "続いている会話の途中で、効かせる集合が変わった").toContain(ACTIVE_LINE);

  // **Clear → 新しい会話**——外した設定が効く。ただし「在る」ことは言う
  await page.getByRole("button", { name: "Thread の操作" }).first().click();
  await page.getByRole("menuitem", { name: "Clear" }).click();
  await expect(page.locator('[data-testid="thread-marker"][data-kind="clear"]').first()).toBeVisible({
    timeout: 15_000,
  });
  const fresh = await sendAndWait(page, threadId, `Clear の後${readBoth}`);
  expect(fresh, "外したのに効いている行が届いている").not.toContain(ACTIVE_LINE);
  expect(fresh, "効かせていない Skill が在ることを言っていない").toContain("1つも効かせていない");
  // 効かせていなくても、探せば本文は読める（pull は生きている）
  expect(fresh, "効かせていない Skill の本文が読めない").toContain(IN_BODY);

  // メーター——この会話では何も効いていない
  await page.getByRole("button", { name: /文脈使用量/ }).click();
  await expect(page.getByTestId("thread-skills")).toContainText("なし", { timeout: 15_000 });
  await expect(page.getByTestId("thread-skill")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("全体では外したまま、この Project でだけ効かせられる", async ({ page }) => {
  await openApp(page);
  const { projectId, threadId } = await projectAndThread(page);
  await openProject(page, projectId);
  await openProjectSettings(page, "この Project の Skill");

  const row = page.locator(`[data-testid="skill-row"][data-skill="${SKILL_KEY}"]`);
  await expect(row).toHaveAttribute("data-state", "off", { timeout: 20_000 });
  await expect(row.getByRole("combobox")).toContainText("全体の既定に従う（効かせない）");
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: "この Project で効かせる" }).click();
  await expect(row).toHaveAttribute("data-state", "on", { timeout: 10_000 });
  await expect(page.getByTestId("skills-enabled-count")).toHaveText("この Project で効くもの：1 / 1");

  // 全体の既定は外したまま
  await page.getByRole("button", { name: "Skill", exact: true }).click();
  await expect(page.locator(`[data-testid="skill-row"][data-skill="${SKILL_KEY}"]`)).toHaveAttribute(
    "data-state",
    "off",
    { timeout: 20_000 },
  );

  // 新しい会話（Clear の後）で効く
  await page.request.post(`${CORE_BASE_URL}/api/threads/${threadId}/clear`, { headers: HEADERS });
  await openProject(page, projectId);
  const reply = await sendAndWait(page, threadId, `Project の上書き${fakeTurn({ sayContext: true })}`);
  expect(reply, "Project の上書きが会話に効いていない").toContain(ACTIVE_LINE);
});
