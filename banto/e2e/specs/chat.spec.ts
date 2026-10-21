// **チャット——Project を作る前の相談**（Backlog #503 chat-frontend、v4-frontend.md §6.53、アーキ仕様 §2.2「チャット」）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る名前・件数・場所まで。host の記録も見る）：
//   1. 「チャット」の「＋」は新しいチャットの画面を開くだけ（何も作らない）。送ると作られ、その会話へ移る。行は
//      「題を考えています…」から題に替わり、会話の見出しも題になる。Project の一覧には出ない。根は置き場の下
//   2. 畳む・開く：畳むと行が消え、見出しに件数。読み込み直しても畳んだまま
//   3. 行の「…」の「閉じる」で一覧から消え「閉じたチャット N」に入る。小窓で名前で探し、開くと中身の説明と「再度開く」、
//      下の端に何日で自動で閉じるか。開き直すとその会話へ戻り、一覧に戻る
//   4. 「Project にする」：名前・フォルダとリポジトリの名前・フォルダを置き場へ移す・リポジトリ（Module の画面）を決めて押すと、
//      チャットの欄から Project の一覧へ移り、根が置き場の下へ移り、同じ会話が続く（前の発言が見え、次のターンが返る）
//   5. 設定の「チャット」の2項目を押すと保存され（host の値）、読み込み直しても選ばれたまま
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "../test-base.js";
import { AUTH_TOKEN, CHATS_DIR, CORE_BASE_URL } from "../config.js";
import { fakeTurn, openApp, openNav, openProjectSettings, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 1280, height: 900 } });

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const stamp = Date.now().toString(36);
const TITLE = `電力の見える化 ${stamp}`;
const FIRST = `家の電力をグラフで見たい [[fake-title:${TITLE}]]`;
const FIRST_REPLY = `受信機はありますか ${stamp}`;
const PROJECT_NAME = `電力ダッシュボード ${stamp}`;
const SLUG = `power-${stamp}`;

interface HostProject {
  id: string;
  name: string;
  root: string;
  status: "active" | "closed";
  kind?: "chat";
  prototyping?: boolean;
  groupId?: string;
}

async function hostProjects(page: Page): Promise<HostProject[]> {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as HostProject[];
}

async function hostProject(page: Page, id: string): Promise<HostProject> {
  const found = (await hostProjects(page)).find((p) => p.id === id);
  expect(found, `host に ${id} が無い`).toBeTruthy();
  return found!;
}

const chatRow = (page: Page, id: string) => page.locator(`[data-testid="sidebar-chat"][data-project-id="${id}"]`);

/** 行の「…」を開いてその項目を押す */
async function chatRowMenu(page: Page, id: string, item: string) {
  const row = chatRow(page, id);
  await row.hover();
  await row.getByRole("button", { name: /の操作$/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** アプリを開き（繋ぐ先は `openApp` が渡す）、サイドバーのそのチャットの行から会話を開く */
async function openChat(page: Page, id: string) {
  await openApp(page);
  await chatRow(page, id).getByRole("link").click();
  await page.waitForURL(new RegExp(`/p/${id}$`));
}

let chatId = "";
let baseThreadId = "";

test("＋で新しいチャットの画面→送ると作られ、行が「題を考えています…」から題に替わる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await openNav(page);
  const before = await hostProjects(page);

  await page.getByRole("button", { name: "新しいチャット", exact: true }).click();
  await page.waitForURL(/\/chat\/new$/);
  await expect(page.getByRole("heading", { name: "何について話しますか？" })).toBeVisible();
  // 開いただけでは何も作らない
  expect((await hostProjects(page)).length).toBe(before.length);

  const input = page.getByLabel("最初のメッセージ");
  // 返事はゆっくり流す——その間（題が付く前）の行を見る
  await input.fill(FIRST + fakeTurn({ say: FIRST_REPLY, streamMs: 4_000 }));
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/projects",
  );
  await input.press("Enter");
  chatId = ((await (await created).json()) as HostProject).id;
  await page.waitForURL(new RegExp(`/p/${chatId}$`));

  // host：チャットの印・仮の名前・根は置き場の下（この試験の置き場、config.json の testOnlyChatsDir）
  const host = await hostProject(page, chatId);
  expect(host.kind).toBe("chat");
  expect(host.root.startsWith(`${CHATS_DIR}/`), host.root).toBe(true);
  expect(host.prototyping).toBe(false);

  // 行は「題を考えています…」（返事が流れている間）→ 題
  const name = chatRow(page, chatId).getByTestId("sidebar-chat-name");
  await expect(name).toHaveText("題を考えています…");
  await expect(name).toHaveText(TITLE, { timeout: 60_000 });
  await expect((await hostProject(page, chatId)).name).toBe(TITLE);
  // 話すだけなのでコンテナの印は無い
  await expect(chatRow(page, chatId).getByTestId("sidebar-chat-machine")).toHaveCount(0);
  // 会話：見出しは題だけ・最初の書き込みと返事
  await expect(page.getByText(TITLE, { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-role="assistant"]').getByText(FIRST_REPLY)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-role="user"]').getByText("家の電力をグラフで見たい", { exact: false })).toBeVisible();
  // Project の一覧には出ない（チャットの欄だけ）
  await expect(page.getByTestId("sidebar-project-list").getByText(TITLE)).toHaveCount(0);
  await expect(page.getByTestId("sidebar-chat-list").getByText(TITLE)).toHaveCount(1);
  // 会話の記録：Base Thread に人の書き込み1つと返事1つ
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${chatId}/threads`, { headers })).json()) as Array<{ id: string; kind: string }>;
  baseThreadId = threads.find((t) => t.kind === "base")!.id;
  await waitTurnEnded(page, baseThreadId, 1);
  expect(pageErrors).toEqual([]);
});

test("畳む・開く：畳むと行が消えて見出しに件数、読み込み直しても畳んだまま", async ({ page }) => {
  await openChat(page, chatId);
  const activeChats = (await hostProjects(page)).filter((p) => p.kind === "chat" && p.status === "active");
  const running = activeChats.filter((p) => p.prototyping).length;

  await page.getByRole("button", { name: "チャットの一覧を畳む" }).click();
  await expect(page.getByTestId("sidebar-chat-list")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-chats-count")).toHaveText(`${activeChats.length}${running > 0 ? `（試作中 ${running}）` : ""}`);

  await page.reload();
  await expect(page.getByRole("button", { name: "チャットの一覧を開く" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("sidebar-chat-list")).toHaveCount(0);

  await page.getByRole("button", { name: "チャットの一覧を開く" }).click();
  await expect(chatRow(page, chatId).getByTestId("sidebar-chat-name")).toHaveText(TITLE);
  await expect(page.getByTestId("sidebar-chats-count")).toHaveCount(0);
});

test("閉じる→「閉じたチャット」の小窓から探して開き直す", async ({ page }) => {
  await openChat(page, chatId);

  await chatRowMenu(page, chatId, "閉じる");
  await expect(chatRow(page, chatId)).toHaveCount(0);
  // いま開いていたチャットを閉じたら、そこに居続けない
  await expect(page).not.toHaveURL(new RegExp(`/p/${chatId}`));
  await expect.poll(async () => (await hostProject(page, chatId)).status).toBe("closed");
  const closedCount = (await hostProjects(page)).filter((p) => p.kind === "chat" && p.status === "closed").length;
  await expect(page.getByTestId("sidebar-closed-chats-count")).toHaveText(String(closedCount));
  // 閉じたチャットは Project の履歴には出ない
  await expect(page.getByTestId("sidebar-project-list").getByText(TITLE)).toHaveCount(0);

  await page.getByTestId("sidebar-closed-chats").click();
  const dialog = page.getByTestId("closed-chats-dialog");
  await expect(dialog.getByRole("heading", { name: "閉じたチャット" })).toBeVisible();
  const settings = (await (await page.request.get(`${CORE_BASE_URL}/api/settings/chat`, { headers })).json()) as { closeAfterDays: number | "off" };
  await expect(dialog.getByTestId("closed-chats-auto-close")).toHaveText(
    settings.closeAfterDays === "off"
      ? "触らなくなったチャットは自動では閉じません（設定の「チャット」で変えられます）"
      : `${settings.closeAfterDays}日触らなかったチャットは自動で閉じます（設定の「チャット」で変えられます）`,
  );
  await dialog.getByPlaceholder("名前で検索").fill(stamp);
  const row = dialog.getByRole("button", { name: new RegExp(TITLE) });
  await expect(row).toHaveCount(1);
  await row.click();
  // 中身の説明：やり取りの数（host の記録の発言の数）・最初と最後の発言
  const record = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${baseThreadId}`, { headers })).json()) as { messages: unknown[] };
  await expect(dialog.getByText(`${record.messages.length}件のやり取り`, { exact: true })).toBeVisible();
  await expect(dialog.locator("p", { hasText: /^最初：/ })).toContainText("家の電力をグラフで見たい");
  await expect(dialog.locator("p", { hasText: /^最後：/ })).toHaveText(`最後：${FIRST_REPLY}`);
  await expect(dialog.getByText("会話とフォルダは残っています。", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "再度開く" }).click();

  await page.waitForURL(new RegExp(`/p/${chatId}$`));
  await expect(dialog).toHaveCount(0);
  await expect(chatRow(page, chatId).getByTestId("sidebar-chat-name")).toHaveText(TITLE);
  await expect.poll(async () => (await hostProject(page, chatId)).status).toBe("active");
  await expect(page.locator('[data-role="assistant"]').getByText(FIRST_REPLY)).toBeVisible({ timeout: 30_000 });
});

test("Project にする：Project の一覧へ移り、根が置き場へ移り、同じ会話が続く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openChat(page, chatId);
  const oldRoot = (await hostProject(page, chatId)).root;
  const movedRoot = join(dirname(CHATS_DIR), SLUG);
  const adopters = (await (await page.request.get(`${CORE_BASE_URL}/api/ui-folder-adopters`, { headers })).json()) as Array<{ server: string }>;

  // 会話の画面の右上の「…」からも開ける（行の「…」と同じ小窓）
  await page.getByRole("button", { name: "Thread の操作" }).click();
  await expect(page.getByRole("menuitem", { name: "このチャットを閉じる" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Project にする…" }).click();
  const dialog = page.getByTestId("promote-dialog");
  await expect(dialog.getByRole("heading", { name: "Project にする" })).toBeVisible();
  // 名前の案は題、フォルダとリポジトリの名前の案はそれを英小文字にしたもの
  const nameInput = dialog.getByLabel("名前", { exact: true });
  const slugInput = dialog.getByLabel("フォルダとリポジトリの名前", { exact: true });
  await expect(nameInput).toHaveValue(TITLE);
  await expect(slugInput).toHaveValue(stamp);
  await nameInput.fill(PROJECT_NAME);
  await slugInput.fill(SLUG);
  // フォルダ：既定は置き場へ移す。どこからどこへか
  await expect(dialog.locator('[data-testid="promote-folder-choice"][data-value="move"]')).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("promote-folder-note")).toHaveText(`${oldRoot} から ${movedRoot} へ移します。`);

  const submit = dialog.getByTestId("promote-submit");
  if (adopters.length > 0) {
    // リポジトリの欄は Module が名乗った画面。「手元だけ」を選ぶと押せるようになる
    await expect(dialog.getByTestId("module-surface-by")).toHaveText(`「${adopters[0]!.server}」の画面`);
    const canvas = dialog.getByTestId("module-surface").locator('[data-testid="module-canvas-frame"]').contentFrame().frameLocator("iframe");
    await expect(canvas.getByTestId("adopt-panel")).toBeVisible({ timeout: 30_000 });
    await canvas.locator('[data-testid="adopt-choice"][data-value="local"]').click();
    await expect(canvas.locator('[data-testid="adopt-choice"][data-value="local"]')).toHaveAttribute("aria-checked", "true");
  } else {
    await expect(dialog.getByTestId("module-surface")).toHaveCount(0);
  }
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();

  await expect(dialog).toHaveCount(0, { timeout: 120_000 });
  // 「Project にしましたが、リポジトリにできませんでした」と取り違えない
  await expect(page.getByText(`「${PROJECT_NAME}」を Project にしました`, { exact: true })).toBeVisible();
  await expect(page.getByText("リポジトリにできませんでした", { exact: false })).toHaveCount(0);
  await page.waitForURL(new RegExp(`/p/${chatId}$`));
  // host：チャットの印が外れ、名前と根が替わった。フォルダは移った
  const promoted = await hostProject(page, chatId);
  expect(promoted.kind).toBeUndefined();
  expect(promoted.name).toBe(PROJECT_NAME);
  expect(promoted.root).toBe(movedRoot);
  expect(existsSync(movedRoot)).toBe(true);
  expect(existsSync(oldRoot)).toBe(false);
  if (adopters.length > 0) {
    expect(existsSync(join(movedRoot, ".git")), "「手元だけ」なのに git init されていない").toBe(true);
    // 台帳に入った（移したあとのフォルダで）。**この試験の行は外す**——台帳は core に1つで、ほかの試験（repositories.spec の
    // 「台帳は空から始まる」）が同じ core で走る。外してもフォルダは消えない
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server: adopters[0]!.server, tool: name, arguments: args } });
      expect(res.ok(), `${name}: ${res.status()}`).toBe(true);
      return ((await res.json()) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    };
    const rows = (JSON.parse(await tool("list_repositories", {})) as { rows: Array<{ path: string }> }).rows;
    expect(rows.map((r) => r.path)).toContain(movedRoot);
    await tool("remove_repository", { path: movedRoot });
    const after = (JSON.parse(await tool("list_repositories", {})) as { rows: Array<{ path: string }> }).rows;
    expect(after.map((r) => r.path)).not.toContain(movedRoot);
  }

  // 画面：チャットの欄から Project の一覧へ
  await expect(chatRow(page, chatId)).toHaveCount(0);
  await expect(page.getByTestId("sidebar-project-list").getByText(PROJECT_NAME, { exact: true })).toBeVisible();
  await expect(page.getByTestId("sidebar-chat-list").getByText(PROJECT_NAME)).toHaveCount(0);
  // 同じ会話：前の発言が見え、続けて話すと返る
  await expect(page.locator('[data-role="assistant"]').getByText(FIRST_REPLY)).toBeVisible({ timeout: 30_000 });
  // 普通の Project になったので、会話の「…」にチャットの項目は無い
  await page.getByRole("button", { name: "Thread の操作" }).click();
  await expect(page.getByRole("menuitem", { name: "Clear" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Project にする…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const composer = page.getByPlaceholder(`${PROJECT_NAME} の Base Thread に送る`);
  await composer.fill(`続けて「続きの返事 ${stamp}」と返して`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').getByText(`続きの返事 ${stamp}`)).toBeVisible({ timeout: 60_000 });
  const record = await waitTurnEnded(page, baseThreadId, 2);
  expect(record.messages.filter((m) => m.role === "user").map((m) => m.text)[0]).toContain("家の電力をグラフで見たい");
  expect(pageErrors).toEqual([]);
});

test("設定の「チャット」：眠らせるまで・閉じるまでを押すと保存され、読み込み直しても選ばれたまま", async ({ page }) => {
  const read = async () => (await (await page.request.get(`${CORE_BASE_URL}/api/settings/chat`, { headers })).json()) as { sleepAfterMinutes: number; closeAfterDays: number | "off" };
  const original = await read();
  try {
    await openApp(page);
    await openProjectSettings(page, "チャット");
    const sleep = (v: string) => page.locator(`[data-testid="chat-sleep-choice"][data-value="${v}"]`);
    const close = (v: string) => page.locator(`[data-testid="chat-close-choice"][data-value="${v}"]`);
    await expect(sleep(String(original.sleepAfterMinutes))).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
    await expect(close(String(original.closeAfterDays))).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-testid="chat-sleep-choice"]')).toHaveText(["5分", "15分", "1時間"]);
    await expect(page.locator('[data-testid="chat-close-choice"]')).toHaveText(["7日", "14日", "30日", "閉じない"]);

    const nextSleep = original.sleepAfterMinutes === 60 ? "5" : "60";
    const nextClose = original.closeAfterDays === "off" ? "30" : "off";
    await sleep(nextSleep).click();
    await expect(sleep(nextSleep)).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await read()).sleepAfterMinutes).toBe(Number(nextSleep));
    await close(nextClose).click();
    await expect(close(nextClose)).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => String((await read()).closeAfterDays)).toBe(nextClose);
    await expect(page.getByTestId("chat-settings-error")).toHaveCount(0);

    await page.reload();
    await expect(sleep(nextSleep)).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await expect(close(nextClose)).toHaveAttribute("aria-checked", "true");
    await expect(sleep(String(original.sleepAfterMinutes))).toHaveAttribute("aria-checked", "false");
  } finally {
    // ほかの試験の前提（既定の値）に戻す
    await page.request.put(`${CORE_BASE_URL}/api/settings/chat`, { headers, data: original });
  }
});
