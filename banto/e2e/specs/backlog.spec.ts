// **Backlog**（v4-modules.md §4.4、2026-10-03。置き場をブランチに・2026-10-04）——仕事の一覧を、Project のリポジトリの
// **一覧のブランチ**（`backlog`、コードの履歴とつながらない orphan。中は tasks.json 1つ）で持つ Module。
//
// 目録から入れ、Project の根（git のリポジトリ。origin は一時の bare リポジトリ）の作業ツリーに見本の tasks.json
// （モックの見本と同じ 35 件）を置いて、入口から開く。ブランチがまだ無いので画面は「移すコマンド」を案内し、
// そのコマンドをそのまま走らせて移す。規則14——「開けた」で終わらせず、画面が出している中身（見方ごとの件数・区切りの
// 中の行・ストーリーの進み・詳細の依存・閉じたものの理由）と、**ブランチに積まれた中身・コミット・origin**、
// **作業ツリーに触っていないこと**を一つずつ見る。
//
// もう1本は AI の tool：AI が updateItem で進めたものが、人が何もしなくても数秒で画面に出て、
// 「取り組んだ Thread」にそのターンの Thread が残る（host が刻む `dev.banto/thread`）。AI のターンから
// Repositories に送る・取ってくるを頼むので、中継の承認（ブランチごとに初回だけ）を人が答える。
//
// 最後の1本は origin との行き来：送れないと「送っていない」と理由を出し（書き込みは止めない）、戻れば送り、
// origin が先へ進んでいれば開いたときに取り込む。設定のブランチ名で別の一覧・古い形の扱い。
//
// 目録から入れた Module は banto 全体の宣言なので、**終わったら外す**（後の spec の Project に入口が増えない）。
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, openNav, openProjectSettings, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Backlog";
const SAMPLE = new URL("../fixtures/backlog/tasks.json", import.meta.url).pathname;
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  }).trim();
}

// Project の根：コードのコミットが1つあるリポジトリ。作業ツリーに見本の docs/tasks.json（ブランチへ移す前の形）。
// origin は根の中（.git の下）の bare リポジトリ——Project のコンテナにも同じパスで見える
const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-backlog-"));
const tasksFile = join(projectRoot, "docs/tasks.json");
const originDir = join(projectRoot, ".git", "e2e-origin.git");
mkdirSync(join(projectRoot, "docs"));
copyFileSync(SAMPLE, tasksFile);
git(projectRoot, ["init", "-q"]);
git(projectRoot, ["add", "."]);
git(projectRoot, ["commit", "-q", "-m", "code"]);
git(projectRoot, ["init", "-q", "--bare", originDir]);
git(projectRoot, ["remote", "add", "origin", originDir]);
/** 作業ツリーと index の様子（Backlog が触っていないことを最後に見る） */
const workingTreeBefore = () => ({ status: git(projectRoot, ["status", "--porcelain"]), head: git(projectRoot, ["symbolic-ref", "HEAD"]) });
const WORKING_TREE = workingTreeBefore();
const SAMPLE_TEXT = readFileSync(SAMPLE, "utf8");

/** そのブランチの先頭（無ければ undefined）。`origin` で bare の側 */
function headOf(branch = "backlog", where: "local" | "origin" = "local"): string | undefined {
  try {
    return git(where === "local" ? projectRoot : originDir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}

interface FileItem {
  id: string;
  title: string;
  status: string;
  parent: string | null;
  dependsOn: string[];
  resolution: string | null;
  threads: Array<{ projectId: string; threadId: string }>;
}

/** 一覧のブランチに積まれた中身（git から直接） */
function fileItems(branch = "backlog"): FileItem[] {
  return (JSON.parse(git(projectRoot, ["show", `refs/heads/${branch}:tasks.json`])) as { items: FileItem[] }).items;
}

function fileItem(id: string): FileItem {
  const found = fileItems().find((i) => i.id === id);
  if (!found) throw new Error(`backlog ブランチの tasks.json に ${id} が無い`);
  return found;
}

/** ブランチのコミットの件名（新しい順） */
function subjects(branch = "backlog"): string[] {
  return git(projectRoot, ["log", "--format=%s", `refs/heads/${branch}`]).split("\n");
}

/** 作業ツリーに触らずに、ブランチに中身を直接積む（`dir` は bare でもよい） */
function commitDirect(dir: string, branch: string, text: string, message: string): string {
  const blob = git(dir, ["hash-object", "-w", "--stdin"], text);
  const tree = git(dir, ["mktree"], `100644 blob ${blob}\ttasks.json\n`);
  let parent: string | undefined;
  try {
    parent = git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  } catch {
    parent = undefined;
  }
  const commit = git(dir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
  git(dir, ["update-ref", `refs/heads/${branch}`, commit]);
  return commit;
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

  // ---- ブランチがまだ無い：作業ツリーの docs/tasks.json を移す道を案内する（自動では移さない）------------
  await expect(inner.getByTestId("backlog-source")).toHaveText("backlog");
  await expect(inner.getByTestId("backlog-missing")).toContainText("まだ一覧のブランチ backlog がありません");
  await expect(inner.getByTestId("backlog-leftover")).toContainText("作業ツリーに docs/tasks.json があります");
  const command = (await inner.getByTestId("backlog-move-command").textContent()) ?? "";
  expect(command).toMatch(new RegExp(`^node \\S+/move-to-branch\\.mjs --repo ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --file docs/tasks\\.json --branch backlog --push$`));
  expect(headOf(), "案内しただけでブランチを作った").toBeUndefined();
  await shot(page, "backlog-wide-leftover");
  // 案内されたコマンドを、そのまま走らせて移す（画面は数秒ごとに読み直す——押さずに一覧が出る）
  const moved = execFileSync("sh", ["-c", command], { encoding: "utf8" });
  expect(moved).toContain("docs/tasks.json の 35 件を backlog ブランチに移しました");
  expect(moved).toContain("origin へ送りました");
  expect(git(projectRoot, ["show", "refs/heads/backlog:tasks.json"]) + "\n").toBe(SAMPLE_TEXT);
  expect(headOf("backlog", "origin")).toBe(headOf());
  await expect(inner.getByTestId("backlog-missing")).toHaveCount(0, { timeout: 30_000 });

  // ---- 見方ごとの件数と、次にやるの中身 ----------------------------------------
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

  // ---- ブランチ・origin・作業ツリー ------------------------------------------------------
  // 1件の変更ごとに1コミット（操作の要約）。移したコミットが根で、親を持たない
  expect(subjects()).toEqual([
    expect.stringMatching(/^backlog: moveItem \S+（\S+ の(前|後ろ)）$/),
    expect.stringMatching(/^backlog: moveItem \S+（\S+ の(前|後ろ)）$/),
    "backlog: updateItem module-kit-extract（status → dropped・resolution）",
    "backlog: updateItem backlog-module（dependsOn）",
    "backlog: splitStory backlog-module（3 件）",
    "backlog: createItem dedupe-memories",
    "backlog: createItem measure-recall-accuracy",
    "backlog: docs/tasks.json から移す（35 件）",
  ]);
  expect(git(projectRoot, ["rev-list", "--max-parents=0", "refs/heads/backlog"])).toBe(git(projectRoot, ["rev-list", "--reverse", "refs/heads/backlog"]).split("\n")[0]);
  expect(git(projectRoot, ["log", "-1", "--format=%an <%ae>", "refs/heads/backlog"])).toBe("banto <banto@localhost>");
  // 書くたびに origin へ送っている（Repositories の一覧に無いリポジトリなので、リポジトリの git の設定で）
  await expect.poll(() => headOf("backlog", "origin"), { timeout: 30_000 }).toBe(headOf());
  await expect(inner.getByTestId("backlog-sync")).toHaveCount(0);
  // 作業ツリー・index・いまのブランチは触っていない（docs/tasks.json は移す前のまま残る）
  expect(workingTreeBefore()).toEqual(WORKING_TREE);
  expect(readFileSync(tasksFile, "utf8")).toBe(SAMPLE_TEXT);

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

  // AI のターンから Repositories に頼む（書く前に取ってくる・書いたら送る）——中継の承認を、ブランチごとに初回だけ聞く。
  // 聞かれた中身を見てから答える（規則14）
  for (const tool of ["fetch_branch", "push_branch"]) {
    const card = page.locator('[data-role="judgment-card"]').filter({ hasText: `backlog が repositories の ${tool}` });
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText("branch: backlog");
    await card.getByRole("button", { name: "許可する" }).click();
    await card.getByRole("button", { name: "この内容で送る" }).click();
  }

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
  expect(subjects()[0]).toBe("backlog: updateItem elicitation-answers（status → in-progress）");
  // AI のターンから書いたものも送られている（Repositories が引き受けないので、リポジトリの git の設定で）
  await expect.poll(() => headOf("backlog", "origin"), { timeout: 30_000 }).toBe(headOf());
  await expect(page.getByText("進めているにしました。", { exact: true })).toBeVisible();
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

test("送れないときは「送っていない」と理由を出し、戻れば送る。origin が先なら開いたときに取り込む。設定のブランチ名で別の一覧", async ({ page }) => {
  const id = await gotoProject(page);

  // ---- 送れない：書き込みは止めず、上に「送っていない」と理由 ----------------------------------
  git(projectRoot, ["remote", "set-url", "origin", join(projectRoot, ".git", "no-such-origin.git")]);
  let inner = await openBacklog(page);
  await inner.getByTestId("backlog-view-all").click();
  const countBefore = fileItems().length;
  await inner.getByTestId("backlog-add-open").click();
  await inner.getByTestId("backlog-composer-title").fill("Offline note");
  await inner.getByTestId("backlog-composer-title").press("Enter");
  await expect(inner.getByTestId("backlog-composer-note")).toHaveText(/^1 件足しました。/, { timeout: 30_000 });
  await inner.getByTestId("backlog-composer-title").press("Escape");
  expect(fileItems().map((i) => i.id)).toContain("offline-note");
  expect(fileItems().length).toBe(countBefore + 1);
  await expect(inner.getByTestId("backlog-sync-ahead")).toHaveText("origin に送っていない変更が 1 件あります。", { timeout: 30_000 });
  await expect(inner.getByTestId("backlog-sync-push-error")).toContainText("送れなかった理由：");
  await expect(inner.getByTestId("backlog-sync-push-error")).toContainText("no-such-origin.git");
  await shot(page, "backlog-wide-unpushed");
  expect(headOf("backlog", "origin")).not.toBe(headOf());

  // ---- 戻れば、次の書き込みでまとめて送られ、知らせは消える ------------------------------------
  git(projectRoot, ["remote", "set-url", "origin", originDir]);
  await inner.locator('[data-item-id="offline-note"] [data-testid="backlog-row-open"]').click();
  await inner.getByTestId("backlog-detail").getByTestId("backlog-close-drop").click();
  await inner.getByTestId("backlog-detail").getByTestId("backlog-drop-reason").fill("試しに足しただけ");
  await inner.getByTestId("backlog-detail").getByTestId("backlog-drop-submit").click();
  await expect(inner.getByTestId("backlog-detail").getByTestId("backlog-closed-note")).toHaveText("やめました：試しに足しただけ", { timeout: 30_000 });
  await expect(inner.getByTestId("backlog-sync")).toHaveCount(0, { timeout: 30_000 });
  expect(headOf("backlog", "origin")).toBe(headOf());

  // ---- origin が先へ進んだ（別の手元から送られた）：開いたときに取り込む --------------------------
  const remoteDoc = JSON.parse(git(originDir, ["show", "refs/heads/backlog:tasks.json"])) as { items: Array<Record<string, unknown>> };
  remoteDoc.items.push({ ...remoteDoc.items.find((i) => i.id === "offline-note")!, id: "from-elsewhere", title: "別の手元から足したもの", status: "ready", resolution: null, closedAt: null });
  commitDirect(originDir, "backlog", `${JSON.stringify(remoteDoc, null, 2)}\n`, "backlog: createItem from-elsewhere");
  await page.goto(`/p/${id}`);
  inner = await openBacklog(page);
  await inner.getByTestId("backlog-view-all").click();
  await expect(inner.locator('[data-item-id="from-elsewhere"] [data-testid="backlog-row-title"]')).toHaveText("別の手元から足したもの", { timeout: 30_000 });
  expect(headOf()).toBe(headOf("backlog", "origin"));
  await expect(inner.getByTestId("backlog-sync")).toHaveCount(0);

  // ---- 設定：ブランチ名を変えると別の一覧。無ければ「足す」へ誘い、最初の項目で orphan を作る ----------
  const openConfig = async () => {
    await openProjectSettings(page);
    await page.getByRole("button", { name: "Backlog", exact: true }).click();
    const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="backlog"]');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    return canvas.locator("iframe").contentFrame().frameLocator("iframe");
  };
  const setBranch = async (branch: string, expectState: RegExp) => {
    const config = await openConfig();
    await expect(config.getByTestId("backlog-config-branch")).not.toHaveValue("", { timeout: 30_000 });
    await config.getByTestId("backlog-config-branch").fill(branch);
    await config.getByTestId("backlog-config-save").click();
    await expect(config.getByTestId("backlog-config-note")).toHaveText(`保存しました（${branch}）`, { timeout: 30_000 });
    await expect(config.getByTestId("backlog-config-branch-state")).toHaveText(expectState);
  };

  await setBranch("planning", /^planning ブランチはまだありません/);
  await page.goto(`/p/${id}`);
  inner = await openBacklog(page);
  await expect(inner.getByTestId("backlog-source")).toHaveText("planning");
  await expect(inner.getByTestId("backlog-missing")).toContainText("まだ一覧のブランチ planning がありません");
  await expect(inner.getByTestId("backlog-leftover")).toContainText("--branch planning");
  await inner.getByTestId("backlog-invite-add").click();
  await inner.getByTestId("backlog-composer-title").fill("First item");
  await inner.getByTestId("backlog-composer-title").press("Enter");
  await expect(inner.getByTestId("backlog-missing")).toHaveCount(0, { timeout: 30_000 });
  expect(fileItems("planning").map((i) => i.id)).toEqual(["first-item"]);
  expect(git(projectRoot, ["rev-list", "--parents", "refs/heads/planning"]).split(" ")).toHaveLength(1);
  await expect.poll(() => headOf("planning", "origin"), { timeout: 30_000 }).toBe(headOf("planning"));

  // 古い形の中身のブランチ：読まず・書かず、書き出して変換するコマンドを案内する
  const legacyText = JSON.stringify({ tasks: [{ id: "a", title: "A", status: "pending" }] });
  const legacyHead = commitDirect(projectRoot, "legacy", legacyText, "old");
  await setBranch("legacy", /^legacy ブランチの tasks\.json は読めません：古い tasks\.json の形です/);
  await page.goto(`/p/${id}`);
  inner = await openBacklog(page);
  await expect(inner.getByTestId("backlog-refused")).toContainText("古い tasks.json の形です");
  await expect(inner.getByTestId("backlog-convert-command")).toHaveText(
    /^git show legacy:tasks\.json > old-tasks\.json && node \S+\/convert-tasks-json\.mjs old-tasks\.json <書き出す先>$/,
  );
  await expect(inner.getByTestId("backlog-add-open")).toHaveCount(0);
  await shot(page, "backlog-wide-legacy");
  expect(headOf("legacy")).toBe(legacyHead);

  // 元に戻す（この spec の後に Project を開いても、見本が出るように）
  await setBranch("backlog", /^backlog ブランチに \d+ 件あります。$/);
  expect(workingTreeBefore()).toEqual(WORKING_TREE);
});
