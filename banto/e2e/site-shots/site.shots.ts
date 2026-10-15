// **公開サイト（site/）のスクリーンショットを、本物の banto の画面から撮る**（追加・2026-10-14）。
//
// 流し方は `playwright.config.ts`（この隣）の頭。場面（`scene.ts`）は API で組み、画面は撮るときに開く：
//   1. Project を4つ作り、Project の根に小さなリポジトリを置く（家計簿アプリ・社内ポータル・qemu-bmc・ブログ）
//   2. 家計簿アプリに Fork を4本立て、それぞれの会話を進める——作業中（tool の返事待ち）・未読（まとめ無し）・
//      決めることがある（ターンの終わりのまとめ）・読んだもの。Base は push で人の判断を待つ
//   3. ほかの Project も進める——社内ポータルは判断待ち（回る）、qemu-bmc は待たずに流した結合テストが終わって AI が
//      返した（まとめで決めることを聞く）、ブログはビルドが終わって AI が返した（まとめ・次に頼めること）
//   4. 撮る：hero・approval・inbox（全面・1枚のカード・携帯）・fork・module（Backlog）・mobile（会話と Drawer）
//
// ターンの終わりのまとめ（report_turn）は Project の設定でオンにする（4つともオン）。まとめを呼ばずに作業を終えたターンは
// Stop hook に1度差し戻され、偽の AI はそのまま終える（まとめの無い「返ってきた会話」になる）
//
// 撮るのは**待っているものが出そろってから**（規則14——成功したときにだけ出るものを待つ）。読み込み中の表示を
// 写さないように、撮る直前に、その画面が出すはずの中身を名指しで待つ。
// 撮るものを絞るときは BANTO_SITE_SHOTS_ONLY=hero,inbox（場面はいつも全部作る）
import { test, expect, loginContext, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TOKEN, CORE_BASE_URL, CORE_BROWSER_URL } from "../config.js";
import { openApp, waitTurnEnded, type InboxItem } from "../helpers.js";
import * as scene from "./scene.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });

const OUT_DIR = fileURLToPath(new URL("../../../site/src/assets/screens/", import.meta.url));
const ONLY = process.env.BANTO_SITE_SHOTS_ONLY?.split(",").map((s) => s.trim());
const wants = (name: string) => !ONLY || ONLY.includes(name);
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

// ---- core の口 ------------------------------------------------------------------------------------

async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[site-shots] ${method} ${path} が失敗：${res.status} ${text}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/**
 * 発言を送る。返事の流れ（SSE）は読み捨てる——ターンは host で最後まで走る（接続を切っても止まらない）。
 * 終わりは記録で待つ（`waitTurnEnded`）か、判断待ちで待つ（`waitJudgment`）
 */
function send(threadId: string, prompt: string): void {
  void fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
    .then((res) => res.body?.pipeTo(new WritableStream()))
    .catch(() => undefined);
}

/** レビュー待ちに host が添えるターンの中身（`GET /api/inbox` の `turn`）のうち、ここで見るところ */
type ReviewItem = InboxItem & { turn?: { summary?: { decisions?: unknown[]; nextSuggestions?: unknown[] } } };

async function inbox(): Promise<InboxItem[]> {
  return api<InboxItem[]>("/api/inbox");
}

/** その Thread の答えていない判断待ちが出るまで待って返す（`except` の id は数えない） */
async function waitJudgment(threadId: string, except?: string): Promise<InboxItem> {
  let found: InboxItem | undefined;
  await expect
    .poll(
      async () => {
        found = (await inbox()).find((i) => i.kind === "judgment" && i.threadId === threadId && i.liveness === "live" && i.id !== except);
        return found !== undefined;
      },
      { timeout: 120_000, message: "判断待ちが受信箱に出ない" },
    )
    .toBe(true);
  return found!;
}

/** その Thread のレビュー待ち（未読）を「見た」にする——人が読んだ会話 */
async function markRead(threadId: string): Promise<void> {
  for (const item of await inbox()) {
    if (item.kind === "review" && item.threadId === threadId) await api(`/api/inbox/${item.id}/acknowledge`, "POST");
  }
}

async function waitModules(projectId: string, names: string[]): Promise<void> {
  await api(`/api/projects/${projectId}/modules/prepare`, "POST");
  await expect
    .poll(
      async () => {
        const modules = await api<Array<{ name: string; connected?: boolean }>>(`/api/projects/${projectId}/modules`);
        return names.filter((n) => !modules.some((m) => m.name === n && m.connected === true));
      },
      { timeout: 180_000, message: `${names.join("・")} が立ち上がらない` },
    )
    .toEqual([]);
}

// ---- Project の根 ---------------------------------------------------------------------------------

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(
    "git",
    ["-c", "user.name=dev", "-c", "user.email=dev@example.com", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) },
  ).trim();
}

/** 根を作ってファイルを置き、git のリポジトリにする（origin は根の中の bare——コンテナにも同じパスで見える） */
function makeRoot(prefix: string, files: scene.Files): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "最初の版"]);
  const origin = join(root, ".git", "origin.git");
  git(root, ["init", "-q", "--bare", origin]);
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "origin", "main"]);
  return root;
}

/** Backlog の一覧のブランチ（作業ツリーに触らずに積んで、origin へ送る） */
function putBacklog(root: string, doc: unknown): void {
  const blob = git(root, ["hash-object", "-w", "--stdin"], `${JSON.stringify(doc, null, 2)}\n`);
  const tree = git(root, ["mktree"], `100644 blob ${blob}\ttasks.json\n`);
  const commit = git(root, ["commit-tree", tree, "-m", "仕事の一覧"]);
  git(root, ["update-ref", "refs/heads/backlog", commit]);
  git(root, ["push", "-q", "origin", "backlog"]);
}

// ---- 撮る ---------------------------------------------------------------------------------------------

async function save(target: Page | ReturnType<Page["locator"]>, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await target.screenshot({ path: join(OUT_DIR, `${name}.png`), animations: "disabled", caret: "hide" });
}

/**
 * 会話を一番下まで送る（判断待ちのカードのボタンまで見せる）。開いた直後は、あとから描かれたカードのぶん下が
 * 入力欄に隠れたままのことがある。送ったあと、ボタンが入力欄より上に出たことを確かめる
 */
async function scrollToEnd(page: Page): Promise<void> {
  const card = page.locator('[data-role="judgment-card"]').last();
  const allow = card.getByRole("button", { name: "許可する" });
  const composer = page.getByPlaceholder(/に送る/).first();
  await expect
    .poll(
      async () => {
        await card.evaluate((el) => {
          const viewport = el.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
          if (viewport) viewport.scrollTop = viewport.scrollHeight;
        });
        const [button, input] = await Promise.all([allow.boundingBox(), composer.boundingBox()]);
        return button !== null && input !== null && button.y + button.height < input.y - 24;
      },
      { timeout: 15_000, message: "判断のボタンが入力欄の上に出ない" },
    )
    .toBe(true);
  await page.waitForTimeout(500);
}

/** 明るいテーマで、ログインした状態の画面を開く */
async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await openApp(page, CORE_BROWSER_URL);
}

interface Ids {
  kakeibo: string;
  base: string;
  forks: Record<string, string>;
  portal: string;
  qemu: string;
  blog: string;
}
let ids: Ids;

test.beforeAll(async () => {
  // Backlog は目録から入れる（banto 全体の Module）
  const res = await fetch(`${CORE_BASE_URL}/api/modules/catalog/backlog`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "backlog" }),
  });
  if (!res.ok && !(await res.text()).includes("その名前はもう使われています")) throw new Error(`Backlog を入れられません：${res.status}`);
});

test("場面を作る", async ({ page }) => {
  const kakeiboRoot = makeRoot("kakeibo", scene.KAKEIBO_FILES);
  putBacklog(kakeiboRoot, scene.KAKEIBO_BACKLOG);
  const roots = {
    [scene.KAKEIBO]: kakeiboRoot,
    [scene.PORTAL]: makeRoot("intra-portal", scene.PORTAL_FILES),
    [scene.QEMU]: makeRoot("qemu-bmc", scene.QEMU_FILES),
    [scene.BLOG]: makeRoot("blog", scene.BLOG_FILES),
  };
  const projects: Record<string, string> = {};
  for (const [name, root] of Object.entries(roots)) {
    projects[name] = (await api<{ id: string }>("/api/projects", "POST", { name, root })).id;
  }
  await api("/api/projects/order", "PUT", { ids: Object.values(projects) });
  await Promise.all(Object.values(projects).map((id) => waitModules(id, ["shell", "filesystem"])));
  for (const id of Object.values(projects)) await api(`/api/projects/${id}/turn-summary`, "PUT", { enabled: true });
  // Base Thread は画面が Project を開いたときに作る口（POST）——ここでは画面を開かないので自分で作る
  const baseOf = async (projectId: string) =>
    (await api<Array<{ id: string; kind: string }>>(`/api/projects/${projectId}/threads`)).find((t) => t.kind === "base")?.id ??
    (await api<{ id: string }>(`/api/projects/${projectId}/threads`, "POST")).id;

  const base = await baseOf(projects[scene.KAKEIBO]!);
  const forks: Record<string, string> = {};
  for (const title of [scene.FORK_LOGIN, scene.FORK_CSV, scene.FORK_PAY_A, scene.FORK_PAY_B]) {
    forks[title] = (await api<{ id: string }>(`/api/threads/${base}/fork`, "POST", { title })).id;
  }
  ids = {
    kakeibo: projects[scene.KAKEIBO]!,
    base,
    forks,
    portal: await baseOf(projects[scene.PORTAL]!),
    qemu: await baseOf(projects[scene.QEMU]!),
    blog: await baseOf(projects[scene.BLOG]!),
  };
  const defaultMode = (threadId: string) => api(`/api/threads/${threadId}/permission-mode`, "POST", { mode: "default" });

  // 家計簿アプリ：Fork はそれぞれ進める
  send(forks[scene.FORK_LOGIN]!, scene.LOGIN_BACKGROUND.prompt);
  send(forks[scene.FORK_CSV]!, scene.CSV_FIX.prompt);
  send(forks[scene.FORK_PAY_A]!, scene.PAY_A.prompt);
  send(forks[scene.FORK_PAY_B]!, scene.PAY_B.prompt);
  // qemu-bmc・ブログ：待たずに流したコマンドが終わると届き、AI が起きてもう一度返す（返事が2つ）
  send(ids.qemu, scene.QEMU_INTEGRATION.prompt);
  send(ids.blog, scene.BLOG_PROOFREAD.prompt);
  await waitTurnEnded(page, forks[scene.FORK_LOGIN]!, 1, 180_000);
  await waitTurnEnded(page, forks[scene.FORK_CSV]!, 1, 180_000);
  await waitTurnEnded(page, forks[scene.FORK_PAY_A]!, 1, 180_000);
  await waitTurnEnded(page, forks[scene.FORK_PAY_B]!, 1, 180_000);
  send(forks[scene.FORK_PAY_A]!, scene.PAY_A_CANCEL.prompt);
  await waitTurnEnded(page, forks[scene.FORK_PAY_A]!, 2, 180_000);
  await waitTurnEnded(page, ids.qemu, 2, 180_000);
  await waitTurnEnded(page, ids.blog, 2, 180_000);

  // 人の判断を待っているもの（ターンは走ったまま——サイドバーで回る）
  // Base：テスト（npm test）は人が許可して走り、push で人の判断を待つ
  await defaultMode(ids.base);
  send(ids.base, scene.KAKEIBO_RELEASE.prompt);
  const runTests = await waitJudgment(ids.base);
  await api(`/api/inbox/${runTests.id}/answer`, "POST", { answer: { behavior: "allow" } });
  await waitJudgment(ids.base, runTests.id);
  await defaultMode(ids.portal);
  send(ids.portal, scene.PORTAL_DEPLOY.prompt);
  await waitJudgment(ids.portal);

  // ログイン画面の改修：いま作業中（tool の返事を待っている）
  send(forks[scene.FORK_LOGIN]!, scene.LOGIN_WORKING.prompt);

  // 読んだことにする会話（案A。受信箱の「返ってきた会話」は CSV 取り込みの不具合とブログ）
  await markRead(forks[scene.FORK_PAY_A]!);

  // 受信箱に出るはずのもの：判断待ち2（家計簿の push・社内ポータルのデプロイ）、決めることがある2（案B・qemu-bmc）、
  // 返ってきた会話2（CSV 取り込みの不具合はまとめ無し・ブログはまとめあり）
  const reviewsNow = async () =>
    Object.fromEntries(
      ((await inbox()) as ReviewItem[])
        .filter((i) => i.kind === "review" && i.threadId !== undefined)
        .map((i) => [i.threadId!, { decisions: i.turn?.summary?.decisions?.length ?? 0, next: i.turn?.summary?.nextSuggestions?.length ?? 0 }]),
    );
  await expect
    .poll(async () => {
      const r = await reviewsNow();
      return [r[forks[scene.FORK_PAY_B]!], r[ids.qemu], r[ids.blog], r[forks[scene.FORK_CSV]!]];
    }, { timeout: 30_000, message: "受信箱のレビュー待ち（案B・qemu-bmc・ブログ・CSV）がそろわない" })
    .toEqual([
      { decisions: 1, next: 0 },
      { decisions: 1, next: 0 },
      { decisions: 0, next: 2 },
      { decisions: 0, next: 0 },
    ]);
  const items = await inbox();
  console.log(
    `[site-shots] 受信箱：判断待ち ${items.filter((i) => i.kind === "judgment" && i.liveness === "live").length}・` +
      `お知らせ ${items.filter((i) => i.kind === "notice").length}・レビュー待ち ${items.filter((i) => i.kind === "review").length}`,
  );
});

test("hero と approval", async ({ page }) => {
  test.skip(!wants("hero") && !wants("approval"));
  await prepare(page);
  await page.goto(`/p/${ids.kakeibo}`);
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });
  await expect(sidebar.getByTestId("thread-background")).toHaveText("バックグラウンドで 2 件", { timeout: 30_000 });
  await expect(sidebar.getByTestId("project-running")).toHaveCount(1, { timeout: 30_000 });
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: scene.FORK_CSV })).toHaveAttribute("data-unread", "");
  await expect(page.getByText("テストは 12 件すべて通りました", { exact: false }).first()).toBeVisible();
  await scrollToEnd(page);
  if (wants("hero")) await save(page, "hero");
  if (wants("approval")) {
    // AI の発言の頭（「テストを流します。」）から、許可した npm test のカードを経て、人の判断を待つカードまで
    // （下の操作の列と入力欄は入れない）
    const box = await page.locator('[data-role="assistant"]').last().boundingBox();
    const card = await page.locator('[data-role="judgment-card"]').last().boundingBox();
    if (!box || !card) throw new Error("approval の切り抜く範囲が決まらない");
    const top = Math.max(box.y - 16, 61); // 61 より上は画面の頭の帯
    await page.screenshot({
      path: join(OUT_DIR, "approval.png"),
      clip: { x: box.x - 24, y: top, width: box.width + 48, height: card.y + card.height + 16 - top },
      animations: "disabled",
      caret: "hide",
    });
  }
});

/**
 * 受信箱を開いて、出るはずのカードが出そろうまで待つ（判断待ち2・決めることがある2・返ってきた会話2）。
 * 開いている会話（Base）のレビュー待ちは出ないが、Base にあるのは判断待ちだけ
 */
async function openInbox(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.goto(`/p/${ids.kakeibo}?overlay=inbox`);
  const dialog = page.getByRole("dialog", { name: "受信箱" });
  await expect(dialog.getByTestId("inbox-section-judgment").getByTestId("inbox-judgment")).toHaveCount(2, { timeout: 60_000 });
  await expect(dialog.getByTestId("inbox-section-decide").getByTestId("inbox-review")).toHaveCount(2, { timeout: 30_000 });
  await expect(dialog.getByTestId("inbox-section-returned").getByTestId("inbox-review")).toHaveCount(2, { timeout: 30_000 });
  // カードの頭の Project・Thread の名前（画面の一覧が読めてから出る）
  await expect
    .poll(async () => (await dialog.getByTestId("inbox-card-project").allTextContents()).sort(), { timeout: 30_000 })
    .toEqual([scene.BLOG, scene.KAKEIBO, scene.KAKEIBO, scene.KAKEIBO, scene.PORTAL, scene.QEMU].sort());
  return dialog;
}

test("inbox", async ({ page }) => {
  test.skip(!wants("inbox") && !wants("inbox-card"));
  await prepare(page);
  const dialog = await openInbox(page);
  // 4つの段をすべて1枚に入れる——受信箱の中身の高さまで画面を縦に伸ばす（下の余白 pb-24 のぶんは詰める）
  const overflow = await dialog.evaluate((el) => {
    const scroller = el.querySelector<HTMLElement>(".overflow-auto")!;
    return scroller.scrollHeight - scroller.clientHeight;
  });
  await page.setViewportSize({ width: 1440, height: 900 + Math.max(0, overflow - 72) });
  await page.waitForTimeout(1_000);
  if (wants("inbox")) await save(page, "inbox");
  if (wants("inbox-card")) {
    // 決めることのあるまとめのカード（案B）。おすすめの選択肢を押して、返信の欄に入ったところ
    const card = dialog
      .getByTestId("inbox-section-decide")
      .getByTestId("inbox-review")
      .filter({ has: page.getByTestId("inbox-card-thread").getByText(scene.FORK_PAY_B, { exact: true }) });
    await card.getByTestId("inbox-turn-option").filter({ hasText: "PAY.JP で組む" }).click();
    await expect(card.getByTestId("inbox-reply-input")).toHaveValue(/^PAY\.JP で組んでください。/);
    await page.mouse.move(0, 0);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await save(card, "inbox-card");
  }
});

test("mobile-inbox", async ({ browser }) => {
  test.skip(!wants("mobile-inbox"));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "light", isMobile: true, hasTouch: true });
  await loginContext(context);
  const page = await context.newPage();
  await prepare(page);
  await openInbox(page);
  await page.waitForTimeout(1_000);
  await save(page, "mobile-inbox");
  await context.close();
});

test("fork", async ({ page }) => {
  test.skip(!wants("fork"));
  await prepare(page);
  await page.goto(`/p/${ids.kakeibo}?fork=${ids.forks[scene.FORK_PAY_A]}`);
  await expect(page.getByText("Stripe で組む場合をまとめました。")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await save(page, "fork");
});

test("module（Backlog）", async ({ page }) => {
  test.skip(!wants("module"));
  await prepare(page);
  await page.goto(`/p/${ids.kakeibo}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await waitModules(ids.kakeibo, ["backlog"]);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:backlog:"]');
  await expect(entry).toBeVisible({ timeout: 60_000 });
  await entry.click();
  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(inner.getByTestId("backlog-row").first()).toBeVisible({ timeout: 60_000 });
  await expect(inner.getByTestId("backlog-number").first()).toBeVisible({ timeout: 30_000 });
  // 「すべて」の見方（マイルストーンごと、ストーリーの下にタスク）
  await inner.getByTestId("backlog-view-all").click();
  await expect(inner.locator('[data-item-id="csv-import"]').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await save(page, "module");
});

test("mobile", async ({ browser }) => {
  test.skip(!wants("mobile"));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "light", isMobile: true, hasTouch: true });
  await loginContext(context);
  const page = await context.newPage();
  await prepare(page);
  await page.goto(`/p/${ids.kakeibo}`);
  const card = page.locator('[data-role="judgment-card"]').last();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await scrollToEnd(page);
  await save(page, "mobile");
  await page.getByRole("button", { name: "Project と Thread の一覧を開く" }).first().click();
  await expect(page.locator('[data-slot="drawer-content"][data-state="open"]')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await save(page, "mobile-drawer");
  await context.close();
});
