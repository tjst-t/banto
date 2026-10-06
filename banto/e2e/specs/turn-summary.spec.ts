// **ターンの終わりのまとめ**（決定・2026-10-06、ユーザー。アーキ仕様 §2.2・v4-frontend.md §6.35）。
//
// 見ること（画面と host の記録で）：
//   1. 既定はオフ——AI が呼び忘れても差し戻さず、まとめは出ない
//   2. Project の設定「一般」のスイッチでオンにできる（真実は host）
//   3. オンなら、AI の report_turn が会話のそのターンの一番下に「このターンのまとめ」として出る。後ろに文が続いても下。
//      承認モードが default でも report_turn には承認を聞かない。元の人の発言（「それでお願い」）を添える
//   4. 返答の候補を押すと入力欄に入る（判断が2つなら2行、もう一度押すと外れる）
//   5. 読み込み直しても記録から同じまとめが出る
//   6. AI が呼び忘れたら Stop hook で差し戻され、まとめが出る。後ろに返事をしたまとめの候補は押せない
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Turn Summary Project";

const FIRST = {
  request: "Vault に「版」の仕組みを入れ、Project ごとに Infisical の環境を選べるようにする",
  outcome: {
    status: "done",
    headline: "実装して main に push しました。稼働中の banto にはまだ反映していません。",
    points: ["置き場ダイアログに「環境」の選択が出ます"],
    notVerified: ["本物の Infisical での確かめ"],
    artifacts: [{ label: "コミット", detail: "1a3dfb5e" }],
  },
  decisions: [
    {
      question: "稼働中の banto に反映してよいですか？",
      options: [
        { label: "反映して", reply: "稼働中の banto に反映して。", recommended: true },
        { label: "あとで自分でやる", reply: "反映は自分でやる。" },
      ],
    },
    {
      question: "本物の Infisical での確かめをいまやりますか？",
      options: [
        { label: "いまやる", reply: "本物の Infisical で確かめて。" },
        { label: "使うときでいい", reply: "確かめは使うときでいい。", recommended: true },
      ],
    },
  ],
};

const SECOND = {
  request: "稼働中の banto に反映する",
  outcome: { status: "done", headline: "反映しました。", points: [] },
  decisions: [],
  nextSuggestions: [
    { label: "この Fork を閉じる", reply: "この Fork はこれで終わり。" },
    { label: "続ける", reply: "続けて。" },
  ],
};

test("オンの Project では report_turn がターンの一番下にまとめとして出て、候補は入力欄に入る。呼び忘れは差し戻され、オフなら出ない", async ({
  page,
}) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-turn-summary-")));
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId: string = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as Array<{ id: string }>
  )[0]!.id;
  const composer = page.getByPlaceholder(/に送る/);
  const summaries = page.getByTestId("turn-summary");

  // --- 1. 既定はオフ：呼び忘れても差し戻さない ---
  await composer.fill("挨拶して。" + fakeTurn({ say: "オフの返事です。", stopReport: SECOND }));
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "オフの返事です。" })).toBeVisible({ timeout: 60_000 });
  await waitTurnEnded(page, threadId, 1);
  await expect(summaries).toHaveCount(0);

  // --- 2. 設定でオンにする ---
  await page.goto(`/p/${project.id}?settings=1&project=${project.id}&section=project-general`);
  const toggle = page.getByTestId("project-turn-summary");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/turn-summary`, { headers })).json()) as { enabled: boolean }).enabled)
    .toBe(true);
  await page.goto(`/p/${project.id}`);

  // 承認モードを default にする——report_turn には聞かないことを見る
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible({ timeout: 15_000 });

  // --- 3. report_turn がターンの一番下に出る ---
  await composer.fill(
    "それでお願い" +
      fakeTurn({
        say: "報告の本文です。",
        tools: [{ server: "banto-thread", name: "report_turn", args: FIRST }],
        then: "最後に添えた文です。",
      }),
  );
  await composer.press("Enter");
  await expect(summaries).toHaveCount(1, { timeout: 60_000 });
  const first = summaries.first();
  await expect(first.getByTestId("turn-summary-request")).toHaveText(FIRST.request);
  await expect(first).toContainText(FIRST.outcome.headline);
  await expect(first).toContainText("確かめていないこと");
  // 偽の Runner への指示も人の発言の一部なので、頭だけを見る
  await expect(first).toContainText("あなたの発言「それでお願い");
  await expect(first).toContainText("」を、前の話から読み替えています");
  await expect(page.locator('[data-role="judgment-card"]'), "report_turn に承認を聞いた").toHaveCount(0);
  await waitTurnEnded(page, threadId, 2);
  // 後ろに文が続いても、まとめは発言の一番下
  const tail = page.getByText("最後に添えた文です。").first();
  await expect(tail).toBeVisible();
  const tailBox = (await tail.boundingBox())!;
  const cardBox = (await first.boundingBox())!;
  expect(cardBox.y, "まとめが発言の一番下に無い").toBeGreaterThan(tailBox.y);
  // tool の折りたたみに report_turn を出さない（この発言の tool は report_turn だけ——折りたたみ自体が出ない）
  const reply = page.locator('[data-role="assistant"]').filter({ hasText: "最後に添えた文です。" });
  await expect(reply.locator('[data-slot="tool-group-root"]')).toHaveCount(0);

  // --- 4. 候補を押すと入力欄に入る ---
  await first.getByRole("button", { name: /反映して/ }).click();
  await expect(composer).toHaveValue("稼働中の banto に反映して。");
  await first.getByRole("button", { name: /使うときでいい/ }).click();
  await expect(composer).toHaveValue("稼働中の banto に反映して。\n確かめは使うときでいい。");
  await first.getByRole("button", { name: /反映して/ }).click();
  await expect(composer).toHaveValue("確かめは使うときでいい。");

  // --- 5. 読み込み直しても記録から出る ---
  await page.reload();
  await expect(summaries).toHaveCount(1, { timeout: 60_000 });
  await expect(summaries.first().getByTestId("turn-summary-request")).toHaveText(FIRST.request);
  await expect(summaries.first().getByRole("button", { name: /反映して/ })).toBeEnabled();

  // --- 6. 呼び忘れは差し戻され、まとめが出る ---
  await composer.fill("稼働中の banto に反映して。" + fakeTurn({ say: "反映しました。", stopReport: SECOND }));
  await composer.press("Enter");
  await expect(summaries).toHaveCount(2, { timeout: 60_000 });
  const second = summaries.nth(1);
  await expect(second.getByTestId("turn-summary-request")).toHaveText(SECOND.request);
  await expect(second).toContainText("次に頼めること");
  await expect(second).toContainText("決めてもらうことはありません");
  await waitTurnEnded(page, threadId, 3);
  // 後ろに返事をしたまとめの候補は押せない
  await expect(summaries.first().getByRole("button", { name: /反映して/ })).toBeDisabled();
  await expect(summaries.first()).toContainText("このまとめのあとに返事をしています");

  // 記録に残っている（host の Thread の発言に turnSummary）
  const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: Array<{ role: string; turnSummary?: { summary: { request: string } } }>;
  };
  expect(thread.messages.filter((m) => m.turnSummary).map((m) => m.turnSummary!.summary.request)).toEqual([FIRST.request, SECOND.request]);

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
