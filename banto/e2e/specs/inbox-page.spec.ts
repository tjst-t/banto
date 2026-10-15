// **受信箱は会話と同じ前面の1枚。1件ずつのカードで、読んで・決めて・返信する**（決定・2026-10-15、ユーザー。
// v4-frontend.md §6.41・アーキ仕様 §2.4「受信箱は『あなたの番になったもの』だけ」「受信箱の中で読んで答える」、Backlog #300）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 判断待ち（Fork「一覧」の tool の承認）：一番上の段のカードに、どこの会話か・何を承認するか（引数）・答えのボタン。
//      受信箱で「許可する」と答えると「答えました」が出て、host でその呼び出しが続き、ターンが最後まで行く
//   2. 返ってきた会話（まとめあり・決めることあり、Fork「見せ方」）：「決めることがあります」の段に、頼んだこと・結果の1文・
//      状態・できたもの（url のあるものはリンク、別タブ）・分かったこと・確かめていないこと・問いと選択肢（url のある選択肢は
//      「見る」）。「AI の返事を読む」で本文（中の URL も別タブのリンク）
//   3. 返ってきた会話（まとめなし、1. の Fork）：「返ってきた会話」の段に、あなたの発言・「まとめなし」・AI の返事
//   4. バッジ：判断待ちと「決めることがある」だけ数える
//   5. 選択肢を押すと返信の欄に入り、Enter で送る——その Thread を開いていなくても送れて、カードは「送りました」を出して
//      外れ、host でそのターンが最後まで走る（画面は流れを読まない）。終わると、まとめの無いレビュー待ちとして戻ってくる
//   6. キー操作：j／k で移る、e で見た、o で会話を開く（受信箱が閉じ、その Fork が開く）。Escape で閉じる
//   7. お知らせ（「直してほしいこと」）からも移れる（追加・2026-10-15、ユーザー「全部のカードから関係する会話へ」）：会話の分かる
//      お知らせ（Fork を立てなかった——閉じた Fork でも）は「会話を開く」でその Fork へ（閉じた帯つき）、Project だけ分かる
//      お知らせ（Module を繋げなかった）は「Project を開く」でその Project へ。o キーも同じ先。移ってもお知らせは残る
import { test, expect, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { expectProjectOpen, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 1280, height: 900 } });

const PROJECT_NAME = `E2E Inbox Page ${Date.now()}`;
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const MOCK_A = "https://mock-a.example.net/p/banto?avatar=a";
const DOC = "https://docs.example.net/notes";

type HostThread = {
  id: string;
  messages: Array<{ role: string; text: string; origin?: unknown }>;
  lastTurn?: { outcome?: string };
};
type InboxItem = {
  id: string;
  kind: string;
  threadId?: string;
  projectId?: string;
  threadKind?: string;
  title?: string;
  liveness?: string;
  acknowledged?: boolean;
  turn?: Record<string, unknown>;
};

async function api<T>(page: Page, path: string, init?: { method?: string; data?: unknown }): Promise<T> {
  const res = await page.request.fetch(`${CORE_BASE_URL}${path}`, { method: init?.method ?? "GET", headers, data: init?.data });
  expect(res.ok(), `${path} が ${res.status()}：${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const thread = (page: Page, id: string) => api<HostThread>(page, `/api/threads/${id}`);
const inboxItems = (page: Page) => api<InboxItem[]>(page, "/api/inbox");

test("全面の受信箱で、判断待ちに答え・まとめと返事を読み・選択肢から返信を送れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // ---- 用意：Project・Base・Fork 2本。まとめはオン -----------------------------------------------------------
  const project = await api<{ id: string }>(page, "/api/projects", {
    method: "POST",
    data: { name: PROJECT_NAME, root: mkdtempSync(join(tmpdir(), "banto-e2e-inbox-page-")) },
  });
  const base = await api<{ id: string }>(page, `/api/projects/${project.id}/threads`, { method: "POST" });
  await api(page, `/api/projects/${project.id}/turn-summary`, { method: "PUT", data: { enabled: true } });
  const decide = await api<{ id: string }>(page, `/api/threads/${base.id}/fork`, { method: "POST", data: { title: "見せ方の案" } });
  const listing = await api<{ id: string }>(page, `/api/threads/${base.id}/fork`, { method: "POST", data: { title: "一覧" } });
  // Project ごとの Module は On demand——画面が Project を開いたときと同じく、先に用意を頼んでから待つ
  await api(page, `/api/projects/${project.id}/modules/prepare`, { method: "POST" });
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");

  // Fork「見せ方の案」：本文を書いてから report_turn（決めることあり・url つき）。流れは最後まで読む（ターンが終わる）
  const summary = {
    request: "アシスタントの発言の見せ方の案を作る",
    outcome: {
      status: "done",
      headline: "見せ方を2案作りました。どちらで進めるか決めてください。",
      points: ["案A：文字なしアイコン"],
      notVerified: ["携帯の幅では見ていない"],
      artifacts: [
        { label: "案A のモック", detail: "mock-a", url: MOCK_A },
        { label: "コミット", detail: "a1b2c3d4" },
      ],
    },
    decisions: [
      {
        question: "アシスタントの発言はどちらの見せ方にしますか？",
        context: "案B は暗いテーマで線が見えにくくなります。",
        options: [
          { label: "案A", reply: "案A で進めて。", recommended: true, url: MOCK_A },
          { label: "案B", reply: "案B で進めて。" },
        ],
      },
    ],
  };
  const decideTurn = await page.request.post(`${CORE_BASE_URL}/api/threads/${decide.id}/messages`, {
    headers,
    data: {
      prompt:
        "見せ方の案を作って" +
        fakeTurn({ say: `2案作りました。詳しくは ${DOC} を見てください。`, tools: [{ server: "banto-thread", name: "report_turn", args: summary }] }),
    },
    timeout: 120_000,
  });
  expect(decideTurn.ok()).toBe(true);
  await expect.poll(async () => (await thread(page, decide.id)).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");

  // Fork「一覧」：承認を聞く（default）。答えるまで流れは止まっているので、待たずに投げておく
  const listingTurn = page.request.post(`${CORE_BASE_URL}/api/threads/${listing.id}/messages`, {
    headers,
    data: {
      prompt: "直下を一覧して" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }], then: "一覧しました。" }),
      permissionMode: "default",
    },
    timeout: 180_000,
  });
  await expect
    .poll(async () => (await inboxItems(page)).filter((i) => i.kind === "judgment" && i.threadId === listing.id && i.liveness === "live").length, {
      timeout: 60_000,
      message: "判断待ちが出ない",
    })
    .toBe(1);

  // host が添えるターンの中身（GET /api/inbox の turn）
  const decideReview = (await inboxItems(page)).find((i) => i.kind === "review" && i.threadId === decide.id);
  expect(decideReview?.turn, "レビュー待ちにターンの中身が無い").toMatchObject({
    request: summary.request,
    reply: `2案作りました。詳しくは ${DOC} を見てください。`,
    outcome: "completed",
    summary: { decisions: [{ options: [{ url: MOCK_A }, {}] }] },
  });

  // ---- 画面：受信箱を開く（どの Fork も開かない——開いている会話のレビュー待ちは出ない） -------------------------
  await openApp(page);
  // バッジ：判断待ち1・決めることがある1（返ってきただけの会話・お知らせは数えない）。受信箱は試験の替わり目に片づいている
  await expect(page.getByRole("button", { name: /^受信箱/ }).first()).toHaveAccessibleName("受信箱（2件）", { timeout: 30_000 });
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  await expect(inbox).toBeVisible();
  await expect(page).toHaveURL(/overlay=inbox/);

  // 1. 判断待ち
  const judgmentSection = inbox.getByTestId("inbox-section-judgment");
  await expect(judgmentSection).toContainText("あなたの判断を待っています");
  const judgment = judgmentSection.getByTestId("inbox-judgment");
  await expect(judgment).toHaveCount(1, { timeout: 15_000 });
  await expect(judgment.getByTestId("inbox-card-project")).toHaveText(PROJECT_NAME);
  await expect(judgment.getByTestId("inbox-card-thread")).toHaveText("一覧");
  await expect(judgment.getByTestId("inbox-judgment-message")).toHaveText("tool呼び出しの承認: mcp__filesystem__listDirectory");
  await expect(judgment.locator("dt")).toHaveText(["path"]);
  await expect(judgment.locator("dd")).toHaveText(["."]);
  await expect(judgment.getByRole("button", { name: "許可する" })).toBeVisible();
  await expect(judgment.getByRole("button", { name: "拒否する" })).toBeVisible();

  // 2. 決めることがある返ってきた会話
  const decideSection = inbox.getByTestId("inbox-section-decide");
  await expect(decideSection).toContainText("決めることがあります");
  const decideCard = decideSection.getByTestId("inbox-review");
  await expect(decideCard).toHaveCount(1);
  await expect(decideCard.getByTestId("inbox-card-thread")).toHaveText("見せ方の案");
  await expect(decideCard.getByTestId("inbox-turn-request")).toHaveText(summary.request);
  await expect(decideCard.getByTestId("inbox-turn-headline")).toHaveText(summary.outcome.headline);
  await expect(decideCard.getByTestId("inbox-turn-status")).toHaveText("終わった");
  await expect(decideCard.getByTestId("inbox-turn-artifact")).toHaveText("コミット a1b2c3d4");
  const artifactLink = decideCard.getByTestId("inbox-turn-artifact-link");
  await expect(artifactLink).toHaveText("案A のモック");
  await expect(artifactLink).toHaveAttribute("href", MOCK_A);
  await expect(artifactLink).toHaveAttribute("target", "_blank");
  await expect(decideCard.getByTestId("inbox-turn-point")).toHaveText(["案A：文字なしアイコン"]);
  await expect(decideCard.getByTestId("inbox-turn-not-verified")).toHaveText(["確かめていない：携帯の幅では見ていない"]);
  const decision = decideCard.getByTestId("inbox-turn-decision");
  await expect(decision).toContainText("アシスタントの発言はどちらの見せ方にしますか？");
  await expect(decision).toContainText("案B は暗いテーマで線が見えにくくなります。");
  await expect(decision.getByTestId("inbox-turn-option")).toHaveText(["案Aおすすめ", "案B"]);
  const optionLink = decision.getByTestId("inbox-turn-option-link");
  await expect(optionLink).toHaveCount(1);
  await expect(optionLink).toHaveAttribute("href", MOCK_A);
  await expect(optionLink).toHaveAttribute("aria-label", "案A を開いて見る");
  // 本文はまとめの下に畳んである。開くと会話と同じ Markdown で、中の URL は別タブのリンク
  await expect(decideCard.getByTestId("inbox-turn-reply")).toHaveCount(0);
  await decideCard.getByTestId("inbox-turn-reply-toggle").click();
  const reply = decideCard.getByTestId("inbox-turn-reply");
  await expect(reply).toContainText("2案作りました。");
  await expect(reply.locator(`a[href="${DOC}"]`)).toHaveAttribute("target", "_blank");

  // 4. 判断待ちに受信箱で答える——host で呼び出しが続き、ターンが最後まで行く
  await judgment.getByRole("button", { name: "許可する" }).click();
  await expect(inbox.getByTestId("inbox-answered")).toContainText("「許可する」と答えました。AI が続きをやります");
  expect((await listingTurn).ok()).toBe(true);
  await expect.poll(async () => (await thread(page, listing.id)).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
  expect((await thread(page, listing.id)).messages.at(-1)?.text).toContain("一覧しました。");

  // 3. 答えたターンが終わると、まとめの無い「返ってきた会話」として出る
  const returnedSection = inbox.getByTestId("inbox-section-returned");
  const listingCard = returnedSection.getByTestId("inbox-review").filter({ has: page.getByTestId("inbox-card-thread").getByText("一覧", { exact: true }) });
  await expect(listingCard).toHaveCount(1, { timeout: 30_000 });
  await expect(listingCard.getByTestId("inbox-turn-request")).toContainText("直下を一覧して");
  await expect(listingCard).toContainText("まとめなし");
  await expect(listingCard.getByTestId("inbox-turn-reply")).toContainText("一覧しました。");
  await expect(inbox.getByTestId("inbox-section-judgment")).toHaveCount(0);

  // 5. 選択肢を押すと返信の欄に入り、Enter で送る（その Fork は開いていない）
  const messagesBefore = (await thread(page, decide.id)).messages.length;
  await decision.getByTestId("inbox-turn-option").filter({ hasText: "案A" }).click();
  const input = decideCard.getByTestId("inbox-reply-input");
  await expect(input).toHaveValue("案A で進めて。");
  await expect(decision.getByTestId("inbox-turn-option").filter({ hasText: "案A" })).toHaveAttribute("aria-pressed", "true");
  await input.press("Enter");
  await expect(inbox.getByTestId("inbox-sent")).toContainText("送りました。AI が動いています");
  // host でそのターンが最後まで走る——画面は流れを読んでいない
  await expect
    .poll(
      async () => {
        const t = await thread(page, decide.id);
        return t.messages.length > messagesBefore && t.lastTurn?.outcome === "completed" ? t.messages.slice(messagesBefore).map((m) => m.role) : null;
      },
      { timeout: 60_000, message: "受信箱から送ったターンが最後まで走らない" },
    )
    .toEqual(["user", "assistant"]);
  expect((await thread(page, decide.id)).messages[messagesBefore]?.text).toBe("案A で進めて。");
  // 送ったレビュー待ちは「見た」になり、終わった新しいターンが（まとめなしで）返ってくる
  await expect(decideSection).toHaveCount(0, { timeout: 30_000 });
  const backAgain = returnedSection.getByTestId("inbox-review").filter({ has: page.getByTestId("inbox-card-thread").getByText("見せ方の案", { exact: true }) });
  await expect(backAgain).toHaveCount(1, { timeout: 30_000 });
  await expect(backAgain.getByTestId("inbox-turn-request")).toHaveText("案A で進めて。");
  await expect(backAgain).toContainText("まとめなし");

  // 6. キー操作：j／k で移り、e で見た
  const cards = inbox.locator('[data-testid="inbox-review"]');
  await expect(cards).toHaveCount(2);
  await page.keyboard.press("k");
  await expect(cards.first()).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("j");
  await expect(cards.nth(1)).toHaveAttribute("data-focused", "true");
  const seenId = await cards.nth(1).getAttribute("data-id");
  await page.keyboard.press("e");
  await expect(inbox.locator(`[data-id="${seenId}"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await inboxItems(page)).some((i) => i.id === seenId), { timeout: 15_000 }).toBe(false);

  // o で会話を開く——受信箱が閉じ、その Fork が開く。残ったレビュー待ちは開いた会話が「見た」にする
  const last = inbox.locator('[data-testid="inbox-review"]');
  await expect(last).toHaveCount(1);
  const lastThread = (await last.getByTestId("inbox-card-thread").textContent()) ?? "";
  const lastId = lastThread === "一覧" ? listing.id : decide.id;
  await page.keyboard.press("o");
  await expect(inbox).toBeHidden({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`[?&]fork=${lastId}`));
  await expect.poll(async () => (await inboxItems(page)).filter((i) => i.kind === "review" && i.threadId === lastId).length, { timeout: 15_000 }).toBe(0);
  await expect(page.getByRole("button", { name: /^受信箱/ }).first()).toHaveAccessibleName("受信箱");

  // Escape で閉じる。空なら「あなたの番のものはありません」
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  await expect(inbox.getByTestId("inbox-empty")).toBeVisible({ timeout: 15_000 });
  await expect(inbox.getByTestId("inbox-remaining")).toHaveText("0 件");
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  await expect(page).not.toHaveURL(/overlay=inbox/);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("お知らせのカードからも移れる——会話の分かるものはその会話（閉じた Fork も）、Project だけ分かるものはその Project", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const stamp = Date.now();

  // 会話の分かるお知らせ：Fork の中で start_forks を呼んで失敗したターン→「Fork を立てませんでした」（その Fork が出どころ）。
  // 出たあとでその Fork を閉じる——閉じた Fork へも同じ道で行ける
  const projectA = await api<{ id: string }>(page, "/api/projects", {
    method: "POST",
    data: { name: `E2E Inbox Jump A ${stamp}`, root: mkdtempSync(join(tmpdir(), "banto-e2e-inbox-jump-a-")) },
  });
  const baseA = await api<{ id: string }>(page, `/api/projects/${projectA.id}/threads`, { method: "POST" });
  const fork = await api<{ id: string }>(page, `/api/threads/${baseA.id}/fork`, { method: "POST", data: { title: "分けて進める" } });
  await page.request.post(`${CORE_BASE_URL}/api/threads/${fork.id}/messages`, {
    headers,
    data: {
      prompt:
        "2つに分けて" +
        fakeTurn({
          tools: [{ server: "banto-thread", name: "start_forks", args: { forks: [{ title: "片方", instruction: "やる" }] } }],
          fail: "API が途中で落ちた",
        }),
    },
    timeout: 120_000,
  });
  await expect
    .poll(async () => (await inboxItems(page)).find((i) => i.kind === "notice" && i.projectId === projectA.id && i.title === "Fork を立てませんでした")?.threadId, {
      timeout: 60_000,
      message: "Fork を立てなかったお知らせが出ない",
    })
    .toBe(fork.id);
  await api(page, `/api/threads/${fork.id}/close`, { method: "POST" });
  const forkNotice = (await inboxItems(page)).find((i) => i.kind === "notice" && i.threadId === fork.id)!;
  expect(forkNotice, "host が行き先を添えていない").toMatchObject({ projectId: projectA.id, threadKind: "fork" });

  // Project だけ分かるお知らせ：その Project の filesystem だけ起動できない（置き場をファイルで塞ぐ）→「filesystem を繋げませんでした」
  const nameB = `E2E Inbox Jump B ${stamp}`;
  const projectB = await api<{ id: string }>(page, "/api/projects", {
    method: "POST",
    data: { name: nameB, root: mkdtempSync(join(tmpdir(), "banto-e2e-inbox-jump-b-")) },
  });
  await api(page, `/api/projects/${projectB.id}/threads`, { method: "POST" });
  mkdirSync(join(DATA_DIR, "modules"), { recursive: true });
  writeFileSync(join(DATA_DIR, "modules", `filesystem-${projectB.id}`), "ディレクトリではない\n");
  await page.request.post(`${CORE_BASE_URL}/api/projects/${projectB.id}/modules/prepare`, { headers });
  await expect
    .poll(async () => (await inboxItems(page)).filter((i) => i.kind === "notice" && i.projectId === projectB.id).map((i) => i.title), {
      timeout: 60_000,
      message: "Module を繋げなかったお知らせが出ない",
    })
    .toContain("filesystem を繋げませんでした");
  const moduleNotice = (await inboxItems(page)).find((i) => i.kind === "notice" && i.projectId === projectB.id)!;
  expect(moduleNotice.threadId, "Project だけのお知らせに会話が付いた").toBeUndefined();

  // ---- 画面：会話の分かるお知らせ→「会話を開く」で閉じた Fork へ --------------------------------------------------
  await openApp(page);
  const inboxButton = page.getByRole("button", { name: /^受信箱/ }).first();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  await inboxButton.click();
  const fixSection = inbox.getByTestId("inbox-section-fix");
  const forkCard = fixSection.locator(`[data-id="${forkNotice.id}"]`);
  await expect(forkCard.getByTestId("inbox-notice-title")).toHaveText("Fork を立てませんでした", { timeout: 15_000 });
  await expect(forkCard.getByTestId("inbox-card-project")).toHaveText(`E2E Inbox Jump A ${stamp}`);
  await expect(forkCard.getByTestId("inbox-card-thread")).toHaveText("分けて進める");
  const toThread = forkCard.getByTestId("inbox-open-thread");
  await expect(toThread).toHaveAttribute("aria-label", "会話を開く");
  await expect(toThread).toHaveAttribute("href", `/p/${projectA.id}?fork=${fork.id}`);
  await toThread.click();
  await expect(inbox).toBeHidden({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/p/${projectA.id}\\?fork=${fork.id}`));
  const forkLayer = page.locator('[data-layer="fork"]');
  await expect(forkLayer.getByTestId("fork-closed-banner")).toContainText("この Fork は閉じました", { timeout: 15_000 });
  // 移っても「見た」にしない——直すまで残す
  expect((await inboxItems(page)).some((i) => i.id === forkNotice.id), "移っただけでお知らせが消えた").toBe(true);

  // ---- 画面：Project だけのお知らせ→ o キーで「Project を開く」と同じ先へ ---------------------------------------------
  await inboxButton.click();
  await expect(inbox).toBeVisible();
  const moduleCard = fixSection.locator(`[data-id="${moduleNotice.id}"]`);
  await expect(moduleCard.getByTestId("inbox-notice-title")).toHaveText("filesystem を繋げませんでした", { timeout: 15_000 });
  await expect(moduleCard.getByTestId("inbox-card-project")).toHaveText(nameB);
  await expect(moduleCard.getByTestId("inbox-card-thread")).toHaveCount(0);
  await expect(moduleCard.getByTestId("inbox-open-thread")).toHaveCount(0);
  const toProject = moduleCard.getByTestId("inbox-open-project");
  await expect(toProject).toHaveAttribute("aria-label", "Project を開く");
  await expect(toProject).toHaveAttribute("href", `/p/${projectB.id}`);
  await moduleCard.click();
  await expect(moduleCard).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("o");
  await expect(inbox).toBeHidden({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/p/${projectB.id}`));
  expect(new URL(page.url()).searchParams.get("fork"), "Project だけのお知らせで Fork を開いた").toBeNull();
  await expectProjectOpen(page, nameB);
  expect((await inboxItems(page)).some((i) => i.id === moduleNotice.id), "移っただけでお知らせが消えた").toBe(true);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
