// **中継の承認カードの扱い**（追加・2026-10-05、docs/notes/2026-10-05-relay-card-followups.md、Backlog #213・#214）。
//
// Backlog の書き込みは、書く前に取ってくる・書いたら送るを Repositories に頼む（中継）。初回はどちらも人に聞く。
// この spec は自分の Project（承認の記録が無い）を作り、2つを見る：
//   1. カードが出ている間も「止める」が出て、押すとターンが止まり、カードは答え済み（畳まれた）になる（#213）
//   2. 受信箱で中継の承認に許可・拒否でき、答えがその呼び出しに届く（呼び出しが続いて書き込みが済む）。
//      会話のカードも答え済みに変わる（#214）
// 規則14——押せたで終わらせず、カードの文言・受信箱の中身・ブランチに積まれた中身・origin まで見る。
//
// 目録から入れた Module は banto 全体の宣言なので、**終わったら外す**（`backlog.spec.ts` と同じ）。
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 1280, height: 860 } });

const PROJECT_NAME = "E2E Relay Cards";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
/** スクリーンショットの置き場（ユーザー指定）。無ければ撮るだけ（試験の出力に残る） */
const SHOTS_DIR = process.env.BANTO_E2E_SHOTS_DIR;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// コードのコミットが1つあるリポジトリと、その origin（bare）。一覧のブランチはまだ無い
const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-relay-cards-"));
const originDir = join(projectRoot, ".git", "e2e-origin.git");
git(projectRoot, ["init", "-q"]);
git(projectRoot, ["commit", "-q", "--allow-empty", "-m", "code"]);
git(projectRoot, ["init", "-q", "--bare", originDir]);
git(projectRoot, ["remote", "add", "origin", originDir]);

function headOf(where: "local" | "origin"): string | undefined {
  try {
    return git(where === "local" ? projectRoot : originDir, ["rev-parse", "--verify", "-q", "refs/heads/backlog"]);
  } catch {
    return undefined;
  }
}

function titlesOnBranch(): string[] {
  return (JSON.parse(git(projectRoot, ["show", "refs/heads/backlog:tasks.json"])) as { items: Array<{ title: string }> }).items.map(
    (i) => i.title,
  );
}

async function shot(page: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  if (SHOTS_DIR) {
    mkdirSync(SHOTS_DIR, { recursive: true });
    copyFileSync(path, join(SHOTS_DIR, `${name}.png`));
  }
}

async function openRelayJudgments(page: Page): Promise<string[]> {
  const open = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{
    kind: string;
    source?: string;
    message: string;
  }>;
  return open.filter((i) => i.kind === "judgment" && i.source === "relay").map((i) => i.message);
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/backlog`, {
    headers: { ...headers, "content-type": "application/json" },
    data: { name: "backlog" },
  });
  if (!res.ok() && !(await res.text()).includes("その名前はもう使われています")) {
    throw new Error(`Backlog を目録から入れられませんでした: ${res.status()}`);
  }
});

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/backlog`, { headers });
});

const fetchCards = (page: Page) =>
  page.locator('[data-role="judgment-card"]').filter({ hasText: "backlog が repositories の fetch_branch" });
const pushCards = (page: Page) =>
  page.locator('[data-role="judgment-card"]').filter({ hasText: "backlog が repositories の push_branch" });
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop generating" });

test("中継の承認カードが出ている間も「止める」が出て、押すとターンが止まり、カードは答え済みになる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "backlog");

  const composer = page.getByPlaceholder(/に送る/).first();
  await composer.fill(
    "一つ足します。" +
      fakeTurn({ tools: [{ server: "backlog", name: "createItem", args: { kind: "task", title: "止めたターンの項目" } }], then: "足しました。" }),
  );
  await composer.press("Enter");

  // 書く前に取ってくる——その中継の承認を聞かれる。答える口がある
  const card = fetchCards(page).first();
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText("branch: backlog");
  await expect(card.getByRole("button", { name: "許可する" })).toBeVisible();
  expect(await openRelayJudgments(page)).toHaveLength(1);
  // **カードが答えを待っている間も、止めるボタンが出ている**（以前は出なかった）。送るボタンの代わりに出る
  await expect(stopButton(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await shot(page, "1-stop-button-while-relay-card");

  // 止める——ターンが止まり、聞いた呼び出しが終わったのでカードは畳まれる（受信箱にも残らない）
  await stopButton(page).click();
  await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect.poll(() => openRelayJudgments(page), { timeout: 30_000 }).toEqual([]);
  // 止めたターンは記録から組み直される（§6.31：「ここで止めました」）。中継のカードは記録に載らないので、止めた
  // ターンの tool のカードと一緒に消える——答えられるように見えるカードは残らない
  await expect(page.getByText("（ここで止めました）")).toBeVisible({ timeout: 30_000 });
  await expect(fetchCards(page)).toHaveCount(0);
  await expect(page.locator('[data-role="judgment-card"]').getByRole("button", { name: "許可する" })).toHaveCount(0);
  await shot(page, "2-stopped-card-settled");
  expect(pageErrors).toEqual([]);
});

test("受信箱で中継の承認に答えると、その呼び出しが続いて書き込みが済み、会話のカードも答え済みになる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  await page.goto(`/p/${project.id}`);
  const composer = page.getByPlaceholder(/に送る/).first();
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // 前のターンのカード（開き直すと描かれない）を数えておき、このターンのカードを位置で指す
  const before = await fetchCards(page).count();
  await composer.fill(
    "もう一つ足します。" +
      fakeTurn({ tools: [{ server: "backlog", name: "createItem", args: { kind: "task", title: "受信箱で許可した項目" } }], then: "受信箱から許可されて足しました。" }),
  );
  await composer.press("Enter");
  // 前のターンで畳まれたカードは答え済みのまま。このターンで新しく聞かれる
  await expect(fetchCards(page)).toHaveCount(before + 1, { timeout: 120_000 });
  const conversationCard = fetchCards(page).nth(before);
  await expect(conversationCard.getByRole("button", { name: "許可する" })).toBeVisible();

  // 受信箱を開く——中継の承認の行に、会話のカードと同じ答え方（許可する・拒否する）が出ている
  // （バッジの数は見ない——core は spec をまたいで1つなので、ほかの spec が残したものも数える）
  await page.getByRole("button", { name: "受信箱" }).click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  const fetchRow = inbox.getByTestId("inbox-judgment").filter({ hasText: "backlog が repositories の fetch_branch" });
  await expect(fetchRow).toBeVisible({ timeout: 15_000 });
  await expect(fetchRow).toContainText(PROJECT_NAME);
  await expect(fetchRow).toContainText("Base Thread");
  await expect(fetchRow.getByRole("button", { name: "許可する" })).toBeVisible();
  await expect(fetchRow.getByRole("button", { name: "拒否する" })).toBeVisible();
  await shot(page, "3-inbox-relay-judgment-answerable");

  // 受信箱で許可する——その呼び出しが続き、次（書いたら送る）を聞かれる。それも受信箱で許可する
  await fetchRow.getByRole("button", { name: "許可する" }).click();
  await expect(fetchRow).toHaveCount(0, { timeout: 30_000 });
  const pushRow = inbox.getByTestId("inbox-judgment").filter({ hasText: "backlog が repositories の push_branch" });
  await expect(pushRow).toBeVisible({ timeout: 60_000 });
  await pushRow.getByRole("button", { name: "許可する" }).click();
  await expect(pushRow).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => openRelayJudgments(page), { timeout: 30_000 }).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden({ timeout: 15_000 });

  // 答えが呼び出しに届いた——書き込みが済み、送られ、AI のターンが最後まで進んだ
  await expect(page.getByText("受信箱から許可されて足しました。", { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(titlesOnBranch()).toEqual(expect.arrayContaining(["受信箱で許可した項目"]));
  await expect.poll(() => headOf("origin"), { timeout: 30_000 }).toBe(headOf("local"));
  // 会話のカードも、受信箱で答えたとおり答え済み
  await expect(conversationCard).toContainText("回答：許可する");
  await expect(pushCards(page).first()).toContainText("回答：許可する");
  await expect(page.locator('[data-role="judgment-card"]').getByRole("button", { name: "許可する" })).toHaveCount(0);
  await shot(page, "4-conversation-cards-answered-from-inbox");
  expect(pageErrors).toEqual([]);
});
