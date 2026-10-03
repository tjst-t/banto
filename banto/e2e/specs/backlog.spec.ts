// **Backlog**（v4-modules.md §4.4、2026-10-03）——仕事の一覧を Project の tasks.json で持つ Module。
//
// 目録から入れ、Project の根に見本の tasks.json（モックの見本と同じ 35 件）を置いて、入口から開く。
// 規則14——「開けた」で終わらせず、画面が出している中身（見方ごとの件数・区切りの中の行・ストーリーの
// 進み・詳細の依存・閉じたものの理由）と、**ファイルに書かれた中身**を一つずつ見る。
//
// もう1本は AI の tool：AI が updateItem で進めたものが、人が何もしなくても数秒で画面に出て、
// 「取り組んだ Thread」にそのターンの Thread が残る（host が刻む `dev.banto/thread`）。
//
// 目録から入れた Module は banto 全体の宣言なので、**終わったら外す**（後の spec の Project に入口が増えない）。
import { test, expect, type Page } from "../test-base.js";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, openNav, openProjectSettings, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Backlog";
const SAMPLE = new URL("../fixtures/backlog/tasks.json", import.meta.url).pathname;
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-backlog-"));
const tasksFile = join(projectRoot, "docs/tasks.json");
mkdirSync(join(projectRoot, "docs"));
copyFileSync(SAMPLE, tasksFile);

interface FileItem {
  id: string;
  title: string;
  status: string;
  parent: string | null;
  dependsOn: string[];
  resolution: string | null;
  threads: Array<{ projectId: string; threadId: string }>;
}

function fileItems(): FileItem[] {
  return (JSON.parse(readFileSync(tasksFile, "utf8")) as { items: FileItem[] }).items;
}

function fileItem(id: string): FileItem {
  const found = fileItems().find((i) => i.id === id);
  if (!found) throw new Error(`tasks.json に ${id} が無い`);
  return found;
}

/** 撮った画面の置き場（コミットしない）。BANTO_E2E_SHOTS_DIR があればそこにも写す */
async function shot(page: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  const dir = process.env.BANTO_E2E_SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, join(dir, `${name}.png`));
  }
}

async function projectId(page: Page): Promise<string> {
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === PROJECT_NAME);
  if (!project) throw new Error(`${PROJECT_NAME} が host に無い`);
  return project.id;
}

/** 前の試験で作った Project を開く（開いた直後の自動の移り先には頼らない） */
async function gotoProject(page: Page): Promise<string> {
  await openApp(page);
  const id = await projectId(page);
  await page.goto(`/p/${id}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await waitForProjectModule(page, PROJECT_NAME, "backlog");
  return id;
}

async function openBacklog(page: Page) {
  // 携帯の幅では検索の入口はナビ（≡）の中
  await openNav(page);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  // Project 名にも Backlog が入るので、入口の行を名指しする
  const entry = page.locator('[role="option"][data-value^="launcher:backlog:"]');
  await expect(entry).toContainText("この Project の仕事の一覧", { timeout: 30_000 });
  await entry.click();
  await expect(page.getByText(/^Canvas — backlog$/)).toBeVisible({ timeout: 30_000 });
  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  // 古い形のファイルでは見方を出さない——どの状態でも出る見出しの場所で待つ
  await expect(inner.getByTestId("backlog-source")).toBeVisible({ timeout: 60_000 });
  return inner;
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/backlog`, {
    headers: { ...headers, "content-type": "application/json" },
    data: { name: "backlog" },
  });
  // 前の回が外し損ねていても、それでよい（ここは前提を整えるところ）
  if (!res.ok() && !(await res.text()).includes("その名前はもう使われています")) {
    throw new Error(`Backlog を目録から入れられませんでした: ${res.status()}`);
  }
});

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/backlog`, { headers });
});

test("入口から開いた一覧で、見る・選ぶ・足す・分ける・依存を足す・やめる・並べ替える", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "backlog");
  const inner = await openBacklog(page);

  // ---- 見方ごとの件数と、次にやるの中身 ----------------------------------------
  await expect(inner.getByTestId("backlog-source")).toHaveText("docs/tasks.json");
  for (const [view, n] of [["next", 12], ["all", 28], ["bugs", 5], ["closed", 7]] as const) {
    await expect(inner.getByTestId(`backlog-view-${view}`).locator(".count")).toHaveText(String(n));
  }
  const doing = inner.locator('[data-section="doing"] [data-testid="backlog-row"]');
  await expect(doing.getByTestId("backlog-row-title")).toHaveText([
    "段階3：URL から clone・新しいリポジトリ・「Project も作る」",
    "AI が tool から Fork を立てる（名前と最初の指示つき）",
    "AI が同じ Module を使っている最中だと、人が画面で押した操作が無言で止まる",
  ]);
  // 次にやるでは、タスクの頭にストーリー名が付く。バグには札
  await expect(doing.nth(0).getByTestId("backlog-row-story")).toHaveText("Repositories の続き");
  await expect(doing.nth(2).getByTestId("backlog-bug-tag")).toBeVisible();
  await expect(doing.nth(0).getByTestId("backlog-rank")).toHaveAttribute("data-state", "in-progress");
  const actionable = inner.locator('[data-section="actionable"] [data-testid="backlog-row"]');
  await expect(actionable).toHaveCount(9);
  await expect(inner.locator('[data-section="actionable"] h3 .hint')).toHaveText(
    "ほかに待っているもの・積んだだけのものが 12 件（「すべて」で見る）",
  );
  await shot(page, "backlog-wide-next");

  // ---- すべて：マイルストーンごと、ストーリーの下に子、閉じた子は畳む ----------------------
  await inner.getByTestId("backlog-view-all").click();
  await expect(inner.locator('[data-testid="backlog-section"] > h3')).toHaveText([
    /^標準 Module を揃える\s*7$/,
    /^並べて任せる\s*4$/,
    /^毎日使える画面\s*1$/,
    /^マイルストーン無し\s*6$/,
  ]);
  const repoStory = inner.locator('[data-item-id="repositories-next"] > [data-testid="backlog-row"]');
  await expect(repoStory.getByTestId("backlog-progress")).toHaveText("2/5");
  await expect(repoStory.getByTestId("backlog-story-mark")).toHaveAttribute("data-ratio", "40");
  await expect(inner.locator('[data-item-id="repositories-next"] [data-testid="backlog-closed-kids"]')).toHaveText(
    "閉じたタスク 2 件を出す",
  );
  await expect(inner.locator('[data-item-id="repositories-publish"] [data-testid="backlog-waiting"]')).toHaveText(
    "待ち：段階3：URL から clone・新しいリポジトリ・「Project も作る」",
  );
  await shot(page, "backlog-wide-all");

  // ---- キー操作：j/k で選び、Enter で詳細、Esc で閉じる --------------------------------
  await inner.getByTestId("backlog-view").focus();
  await inner.getByTestId("backlog-view").press("j");
  await inner.getByTestId("backlog-view").press("j");
  await inner.getByTestId("backlog-view").press("Enter");
  const detail = inner.getByTestId("backlog-detail");
  await expect(detail.getByTestId("backlog-detail-title")).toHaveText("段階3：URL から clone・新しいリポジトリ・「Project も作る」");
  await expect(detail.getByTestId("backlog-detail-parent")).toHaveText("Repositories の続き");
  await expect(detail.getByTestId("backlog-dep-before")).toHaveText([/段階2：GitHub のアカウント.*終わった/]);
  await expect(detail.getByTestId("backlog-dep-after")).toHaveCount(2);
  await expect(detail.getByTestId("backlog-dep-summary")).toHaveText("待っていたものは全部終わりました。終われば 2 件が進めます。");
  await expect(detail.getByTestId("backlog-threads")).toHaveText(/Thread banto-base/);
  await inner.getByTestId("backlog-view").press("k");
  await expect(detail.getByTestId("backlog-detail-title")).toHaveText("Repositories の続き");
  await shot(page, "backlog-wide-detail");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // ---- C で、その場で足す（続けて2件）----------------------------------------------
  await inner.getByTestId("backlog-view").press("c");
  const composer = inner.getByTestId("backlog-composer-title");
  await composer.fill("Measure recall accuracy");
  await composer.press("Enter");
  await expect(inner.getByTestId("backlog-composer-note")).toHaveText(/^1 件足しました。/, { timeout: 30_000 });
  await composer.fill("Dedupe memories");
  await composer.press("Enter");
  await expect(inner.getByTestId("backlog-composer-note")).toHaveText(/^2 件足しました。/, { timeout: 30_000 });
  await composer.press("Escape");
  expect(fileItems().slice(-2).map((i) => [i.id, i.status])).toEqual([
    ["measure-recall-accuracy", "backlog"],
    ["dedupe-memories", "backlog"],
  ]);
  await expect(inner.locator('[data-item-id="dedupe-memories"] [data-testid="backlog-row-title"]')).toHaveText("Dedupe memories");
  await expect(inner.getByTestId("backlog-view-all").locator(".count")).toHaveText("30");

  // ---- ストーリーをタスクに分ける（上から順に待つ）------------------------------------
  await inner.locator('[data-item-id="backlog-module"] > [data-testid="backlog-row"] [data-testid="backlog-row-open"]').click();
  await detail.getByTestId("backlog-split-open").click();
  await detail.getByTestId("backlog-split-input").fill("Store\nAgent tools\nScreen");
  await expect(detail.getByTestId("backlog-split-submit")).toHaveText("3 件のタスクに分ける");
  await detail.getByTestId("backlog-split-submit").click();
  await expect(detail.getByTestId("backlog-detail-kids").locator(".t")).toHaveText(["Store", "Agent tools", "Screen"], {
    timeout: 30_000,
  });
  expect(fileItem("screen")).toMatchObject({ parent: "backlog-module", status: "ready", dependsOn: ["agent-tools"] });
  await expect(inner.locator('[data-item-id="backlog-module"] > [data-testid="backlog-row"] [data-testid="backlog-progress"]')).toHaveText("0/3");

  // ---- 依存を足す（検索して選ぶ）---------------------------------------------------
  await detail.getByTestId("backlog-dep-add").click();
  await inner.getByTestId("backlog-picker").locator("input").fill("Claude ログイン");
  await expect(inner.getByTestId("backlog-picker-option")).toHaveCount(1);
  await inner.getByTestId("backlog-picker").locator("input").press("Enter");
  await expect(detail.getByTestId("backlog-dep-before")).toHaveText([/Claude ログインの中継を core に常設する.*着手できる/], {
    timeout: 30_000,
  });
  expect(fileItem("backlog-module").dependsOn).toEqual(["claude-login-relay-owner"]);
  // 輪になる依存：これを待っている相手は最初から候補に出さない。遠回りの輪は Module が理由つきで断り、ファイルは変わらない
  // （Canvas が狭いと詳細は一覧と入れ替わるので、閉じてから選ぶ）
  await detail.getByTestId("backlog-detail-close").click();
  await inner.locator('[data-item-id="claude-login-relay-owner"] [data-testid="backlog-row-open"]').click();
  await detail.getByTestId("backlog-dep-add").click();
  await inner.getByTestId("backlog-picker").locator("input").fill("Backlog——仕事");
  await expect(inner.getByTestId("backlog-picker-option")).toHaveCount(0);
  await inner.getByTestId("backlog-picker").locator("input").press("Escape");
  await detail.getByTestId("backlog-detail-close").click();
  await inner.locator('[data-item-id="store"] [data-testid="backlog-row-open"]').click();
  await detail.getByTestId("backlog-dep-add").click();
  await inner.getByTestId("backlog-picker").locator("input").fill("Screen");
  await inner.getByTestId("backlog-picker").locator("input").press("Enter");
  await expect(inner.getByTestId("toast").filter({ hasText: "変えられませんでした" })).toContainText(
    "依存が輪になっています：store → screen → agent-tools → store",
    { timeout: 30_000 },
  );
  expect(fileItem("store").dependsOn).toEqual([]);
  await expect(detail.getByTestId("backlog-dep-summary")).toHaveText("待つものはありません。終われば 1 件が進めます。");

  // ---- やめる（理由つき）→ 閉じたものに理由が出る -------------------------------------
  await detail.getByTestId("backlog-detail-close").click();
  await inner.locator('[data-item-id="module-kit-extract"] [data-testid="backlog-row-open"]').click();
  await detail.getByTestId("backlog-close-drop").click();
  await expect(detail.getByTestId("backlog-drop-submit")).toBeDisabled();
  await detail.getByTestId("backlog-drop-reason").fill("repositories-next と重なっていた");
  await detail.getByTestId("backlog-drop-submit").click();
  await expect(detail.getByTestId("backlog-closed-note")).toHaveText("やめました：repositories-next と重なっていた", {
    timeout: 30_000,
  });
  expect(fileItem("module-kit-extract")).toMatchObject({ status: "dropped", resolution: "repositories-next と重なっていた" });
  await detail.getByTestId("backlog-detail-close").click();
  await inner.getByTestId("backlog-view-closed").click();
  await expect(inner.getByTestId("backlog-view-closed").locator(".count")).toHaveText("8");
  await expect(inner.locator('[data-item-id="module-kit-extract"] .row-note')).toHaveText("やめた：repositories-next と重なっていた");

  // ---- 並べ替え：ドラッグと、行のメニュー --------------------------------------------
  await inner.getByTestId("backlog-view-next").click();
  const titles = () => actionable.getByTestId("backlog-row-title").allTextContents();
  const before = await titles();
  await actionable.nth(2).dragTo(actionable.nth(0), { targetPosition: { x: 200, y: 4 } });
  await expect.poll(titles, { timeout: 30_000 }).toEqual([before[2], before[0], before[1], ...before.slice(3)]);
  const order = fileItems().map((i) => i.id);
  expect(order.indexOf("publish-host-verify")).toBeLessThan(order.indexOf("vault-directory-call-id"));

  await actionable.nth(0).hover();
  await actionable.nth(0).getByTestId("backlog-row-menu").click();
  await inner.getByTestId("backlog-menu-down").click();
  await expect.poll(titles, { timeout: 30_000 }).toEqual([before[0], before[2], before[1], ...before.slice(3)]);

  expect(pageErrors).toEqual([]);
});

test("AI が tool で進めたものが、人が何もしなくても画面に出て、その Thread が残る", async ({ page }) => {
  const id = await gotoProject(page);
  const inner = await openBacklog(page);
  const doing = inner.locator('[data-section="doing"]');
  await expect(doing.locator('[data-item-id="elicitation-answers"]')).toHaveCount(0);

  const composer = page.getByPlaceholder(/に送る/).first();
  await composer.fill(
    "受信箱から答える仕事を始めます。" +
      fakeTurn({
        tools: [{ server: "backlog", name: "updateItem", args: { id: "elicitation-answers", status: "in-progress" } }],
        then: "進めているにしました。",
      }),
  );
  await composer.press("Enter");

  // 画面は数秒ごとに読み直す——押さずに出る
  await expect(doing.locator('[data-item-id="elicitation-answers"] [data-testid="backlog-row-title"]')).toHaveText(
    "Module からの問いに、受信箱から答えられるようにする",
    { timeout: 120_000 },
  );
  await expect(inner.getByTestId("backlog-view-next").locator(".count")).toHaveText("13");

  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${id}/threads`, { headers })).json()) as Array<{
    id: string;
    kind: string;
  }>;
  const base = threads.find((t) => t.kind === "base")!;
  expect(fileItem("elicitation-answers")).toMatchObject({
    status: "in-progress",
    threads: [{ projectId: id, threadId: base.id }],
  });
  await inner.locator('[data-item-id="elicitation-answers"] [data-testid="backlog-row-open"]').click();
  await expect(inner.getByTestId("backlog-threads")).toHaveText(`Thread ${base.id}`);
});

test("携帯の幅でも崩れない——一覧は横にはみ出さず、詳細は一覧と入れ替わる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoProject(page);
  const inner = await openBacklog(page);
  await inner.getByTestId("backlog-view-all").click();
  const overflow = await inner.locator("body").evaluate(() => {
    const body = document.querySelector<HTMLElement>(".body")!;
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, list: body.scrollWidth - body.clientWidth };
  });
  expect(overflow).toEqual({ page: 0, list: 0 });
  await shot(page, "backlog-390-all");

  await inner.locator('[data-item-id="repositories-next"] > [data-testid="backlog-row"] [data-testid="backlog-row-open"]').click();
  await expect(inner.getByTestId("backlog-detail")).toBeVisible();
  await expect(inner.getByTestId("backlog-list-pane")).toBeHidden();
  await shot(page, "backlog-390-detail");
  await inner.getByTestId("backlog-detail-close").click();
  await expect(inner.getByTestId("backlog-list-pane")).toBeVisible();
});

test("設定で場所を変えると、無いファイルは「足す」へ誘い、古い形は読まずに変換を案内する", async ({ page }) => {
  const id = await gotoProject(page);

  const openConfig = async () => {
    await openProjectSettings(page);
    await page.getByRole("button", { name: "Backlog", exact: true }).click();
    const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="backlog"]');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    return canvas.locator("iframe").contentFrame().frameLocator("iframe");
  };
  const setPath = async (path: string, expectFile: RegExp) => {
    const config = await openConfig();
    await expect(config.getByTestId("backlog-config-path")).not.toHaveValue("", { timeout: 30_000 });
    await config.getByTestId("backlog-config-path").fill(path);
    await config.getByTestId("backlog-config-save").click();
    await expect(config.getByTestId("backlog-config-note")).toHaveText(`保存しました（${path}）`, { timeout: 30_000 });
    await expect(config.getByTestId("backlog-config-file")).toHaveText(expectFile);
  };

  // 無い場所
  await setPath("planning/backlog.json", /^planning\/backlog\.json はまだありません/);
  await page.goto(`/p/${id}`);
  let inner = await openBacklog(page);
  await expect(inner.getByTestId("backlog-missing")).toContainText("まだ planning/backlog.json がありません");
  await inner.getByTestId("backlog-invite-add").click();
  await inner.getByTestId("backlog-composer-title").fill("First item");
  await inner.getByTestId("backlog-composer-title").press("Enter");
  await expect(inner.getByTestId("backlog-missing")).toHaveCount(0, { timeout: 30_000 });
  expect(JSON.parse(readFileSync(join(projectRoot, "planning/backlog.json"), "utf8")).items[0].id).toBe("first-item");

  // 古い形（今の docs/tasks.json の形）
  const legacy = join(projectRoot, "legacy.json");
  const legacyText = JSON.stringify({ tasks: [{ id: "a", title: "A", status: "pending" }] });
  writeFileSync(legacy, legacyText);
  await setPath("legacy.json", /^legacy\.json は読めません：古い tasks\.json の形です/);
  await page.goto(`/p/${id}`);
  inner = await openBacklog(page);
  await expect(inner.getByTestId("backlog-refused")).toContainText("古い tasks.json の形です");
  await expect(inner.getByTestId("backlog-convert-command")).toHaveText(/^node \S+\/convert-tasks-json\.mjs legacy\.json <書き出す先>$/);
  await expect(inner.getByTestId("backlog-add-open")).toHaveCount(0);
  await shot(page, "backlog-wide-legacy");
  expect(readFileSync(legacy, "utf8")).toBe(legacyText);

  // 元に戻す（この spec の後に Project を開いても、見本が出るように）
  await setPath("docs/tasks.json", /^docs\/tasks\.json に \d+ 件あります。$/);
});
