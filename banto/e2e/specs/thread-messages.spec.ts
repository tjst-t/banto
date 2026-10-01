// **Thread 間・Project 間のメッセージ**（決定・2026-10-01、ユーザー。アーキ仕様 §4.2「Thread 間・Project 間の送り方」）。
//
// 見ること（画面と host の記録で）：
// - AI が `send_message` で**ほかの Project を Project だけ指して**送ると、送り元の会話に承認カードが出る。
//   選択肢に「許可し、以後この Project からは聞かない」がある
// - それを選ぶと、宛先の Project に**会話を引き継がない新しい Fork**（名前はメッセージの題）が立って届き、
//   宛先の Project の「受け取ってよい Project」に送り元が載る（設定の画面にも出る）
// - 届いたものには送り元（Project・Thread）が付く。宛先の AI が送り元へ返すと、**承認なしで**送り元の Thread に届き、
//   画面に「「…」の「…」の AI から届きました」と出る
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp } from "../helpers.js";

test.use({ viewport: { width: 390, height: 844 } });

const SENDER = "E2E Msg Sender";
const RECEIVER = "E2E Msg Receiver";

type ThreadDetail = {
  id: string;
  kind: string;
  title?: string;
  messages: Array<{ role: string; text: string; origin?: { from: string; sender?: { projectId: string; threadId: string } } }>;
};

test("ほかの Project へ送る→承認（以後聞かない）→新しい Fork に届く→返事は承認なしで送り元に戻る", async ({ page }) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // 宛先の Project（API で作る——id を AI の台本に書くため）
  const receiver = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: RECEIVER, root: mkdtempSync(join(tmpdir(), "banto-e2e-msg-recv-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${receiver.id}/threads`, { headers });

  await openApp(page);
  await createProject(page, SENDER, mkdtempSync(join(tmpdir(), "banto-e2e-msg-send-")));

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "あちらの Project に頼んでください。" +
      fakeTurn({
        say: "頼みます。",
        tools: [
          {
            server: "banto-thread",
            name: "send_message",
            args: { projectId: receiver.id, title: "DB を足して", text: "users テーブルを足してください" },
          },
        ],
        then: "頼みました。",
      }),
  );
  await composer.press("Enter");

  // 送り元の会話に承認カード（Project をまたぐので、承認モードに関わらず聞く）
  const card = page.locator('[data-role="judgment-card"]').filter({ hasText: "Project をまたぐメッセージの確認" });
  await expect(card, "Project をまたぐ送信で承認カードが出ない").toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "許可し、以後この Project からは聞かない" }).click();
  await card.getByRole("button", { name: "この内容で送る" }).click();
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "頼みました。" })).toBeVisible({ timeout: 60_000 });

  // 宛先：会話を引き継がない新しい Fork が、題の名前で立って届いている。送り元が載っている
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{
    id: string;
    name: string;
    acceptMessagesFrom?: string[];
  }>;
  const sender = projects.find((p) => p.name === SENDER)!;
  expect(projects.find((p) => p.id === receiver.id)?.acceptMessagesFrom, "「以後聞かない」が宛先の一覧に載らない").toEqual([
    sender.id,
  ]);
  const senderBase = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${sender.id}/threads`, { headers })).json()) as Array<{
      id: string;
      kind: string;
    }>
  ).find((t) => t.kind === "base")!;
  const recvThreads = (await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${receiver.id}/threads`, { headers })
  ).json()) as Array<{ id: string; kind: string; title?: string }>;
  const fork = recvThreads.find((t) => t.kind === "fork" && t.title === "DB を足して");
  expect(fork, "宛先の Project に新しい Fork が立っていない").toBeTruthy();
  await expect
    .poll(
      async () => {
        const t = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${fork!.id}`, { headers })).json()) as ThreadDetail;
        const first = t.messages[0];
        return first?.origin?.sender?.threadId === senderBase.id && t.messages.at(-1)?.role === "assistant";
      },
      { timeout: 60_000, message: "新しい Fork が送り元つきで届き、走り終わるまで" },
    )
    .toBe(true);
  const forkDetail = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${fork!.id}`, { headers })).json()) as ThreadDetail;
  expect(forkDetail.messages[0]!.text, "新しい Fork に Base の会話が写っている").toContain("users テーブル");

  // 宛先の Fork の AI が送り元へ返す（人がその Fork で頼む形で）——承認なしで、送り元の Base Thread に届く
  await page.goto(`/p/${receiver.id}?fork=${fork!.id}`);
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await expect(forkComposer).toBeVisible({ timeout: 30_000 });
  await forkComposer.fill(
    "返事をしてください。" +
      fakeTurn({
        tools: [
          {
            server: "banto-thread",
            name: "send_message",
            args: { projectId: sender.id, threadId: senderBase.id, title: "足しました", text: "users を足しました" },
          },
        ],
        then: "返しました。",
      }),
  );
  await forkComposer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "返しました。" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-role="judgment-card"]'), "返事で承認を求めた").toHaveCount(0);

  // 送り元の会話に、送り元つきで届いたものとして出る
  await page.goto(`/p/${sender.id}`);
  const delivered = page.locator('[data-testid="delivered-message"]').filter({ hasText: "足しました" });
  await expect(delivered, "返事が送り元の会話に出ない").toBeVisible({ timeout: 60_000 });
  await expect(delivered.locator('[data-testid="delivered-from"]')).toHaveText(
    `「${RECEIVER}」の「DB を足して」の AI から届きました`,
  );

  // 宛先の Project の設定に、受け取ってよい Project として出る
  await page.goto(`/p/${receiver.id}?settings=1&project=${receiver.id}&section=project-general`);
  const senders = page.locator('[data-testid="project-message-sender"]');
  await expect(senders, "設定に受け取ってよい Project が出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(senders).toContainText(SENDER);

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
