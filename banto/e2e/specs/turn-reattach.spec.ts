// **戻ってきたら、最新の状況がそのまま出る**（改訂・2026-09-26、ユーザー要望）。
//
// AI の応答に時間がかかっている間に、タブを閉じて開き直す・リロードする・別アプリへ移って戻る
// ——どの戻り方でも、**会話の本文に、いま走っているターンがそのまま流れている**こと。
// 自分がこの画面で送ったときと同じ描き方で、特別な帯や「繋ぎ直しました」は出さない。
//
// 以前（2026-09-10〜）は、走行中のターンを入力欄の上の帯に要約して出していた。人から見ると
// 「いつもと違うものが出て、中身も途中の要約だけ」だった（ユーザー指摘・2026-09-26）。
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { CORE_BASE_URL, CORE_PORT, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
/** 30 秒かけて [1]〜[60] を1つずつ流すターン（戻る隙を作る——本物のモデルが1トークンずつ返す幅を模す） */
const LINES = Array.from({ length: 60 }, (_, i) => `[${i + 1}]`);
const SLOW_TURN = fakeTurn({ say: LINES.join("\n"), streamMs: 30_000 });

/**
 * **画面と host の間に挟む中継**（TCP をそのまま通す）。携帯で別アプリへ移ったときに起きることを、ここで起こす：
 * `cut()` は張ってある接続をすべて切る、`freeze()` は切らずに止める（何も届かなくなる）。どちらも、そのあとに
 * 張る接続は普通に通す——戻ってきた画面が取り直せるように
 */
async function startProxy(): Promise<{ url: string; cut(): void; freeze(): void; close(): Promise<void> }> {
  const live = new Set<{ client: Socket; upstream: Socket }>();
  /** 止めた接続——試験の終わりに片づける */
  const frozen = new Set<{ client: Socket; upstream: Socket }>();
  const server = createServer((client) => {
    const upstream = connect(CORE_PORT, "127.0.0.1");
    const pair = { client, upstream };
    live.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = (): void => {
      live.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    // ブラウザから見る名前は localhost（ログインの Cookie は名前ごと——127.0.0.1 では付かない）
    url: `http://localhost:${port}`,
    cut() {
      for (const { client, upstream } of live) {
        client.destroy();
        upstream.destroy();
      }
      live.clear();
    },
    freeze() {
      for (const { client, upstream } of live) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
        frozen.add({ client, upstream });
      }
      live.clear();
    },
    async close() {
      for (const { client, upstream } of [...live, ...frozen]) {
        client.destroy();
        upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** host がそのターンを走らせているか——`GET …/stream` は走っていなければ `idle`、走っていれば `attached` を最初に返す */
async function turnIsRunning(threadId: string): Promise<boolean> {
  const ctrl = new AbortController();
  const res = await fetch(`${CORE_BASE_URL}/api/threads/${threadId}/stream`, { headers: HEADERS, signal: ctrl.signal });
  try {
    const { value } = await res.body!.getReader().read();
    return new TextDecoder().decode(value).includes('"type":"attached"');
  } finally {
    ctrl.abort();
  }
}

async function baseThreadId(page: Page, projectName: string): Promise<string> {
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === projectName);
  return (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json())[0].id;
}

async function recordedAssistants(page: Page, threadId: string): Promise<number> {
  const t = await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json();
  return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
}

/** 会話の本文に出ている AI の発言（1ターンぶんの流れている吹き出しも含む） */
const assistantMessages = (page: Page) => page.locator('[data-role="assistant"]');

/**
 * **流れている途中が本文に出ている**こと：AI の吹き出しに、最初の行が入っていて、最後の行はまだ無い
 * （終わってから記録で描き直したのではなく、走っている最中に見えている）
 */
async function expectStreamingInline(page: Page, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const last = assistantMessages(page).last();
        if ((await assistantMessages(page).count()) === 0) return "none";
        const text = await last.innerText();
        if (!text.includes("[1]")) return "empty";
        return text.includes("[60]") ? "finished" : "streaming";
      },
      { timeout: 30_000, message },
    )
    .toBe("streaming");
}

/** 終わったら：本文の AI の発言はそのターンの1つだけで、最後の行まで入っている。エラーも帯も無い */
async function expectFinishedOnce(page: Page, threadId: string, assistantsBefore: number, showTimeout = 30_000): Promise<void> {
  await expect.poll(() => recordedAssistants(page, threadId), { timeout: 90_000, message: "ターンが終わるまで" }).toBe(assistantsBefore + 1);
  await expect(assistantMessages(page), "AI の発言が二重に出ている／消えた").toHaveCount(assistantsBefore + 1, { timeout: showTimeout });
  await expect(assistantMessages(page).last(), "最後まで出ていない").toContainText("[60]", { timeout: showTimeout });
  await expect(page.getByText(/^エラー/), "繋ぎ直しの途中の失敗が、人にエラーとして見えている").toHaveCount(0);
  await expect(page.getByText(/繋ぎ直しました|このターンは走っています/), "特別な帯が出ている").toHaveCount(0);
  // 走っている間は止めるボタン、終わったら送るボタン（自分で送ったときと同じ）
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
}

test("走行中にリロードしても、いま走っているターンがそのまま本文に流れる", async ({ page }) => {
  const name = "E2E Reattach Reload";
  await openApp(page);
  await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-reattach-")));
  const threadId = await baseThreadId(page, name);

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("1 から 60 までの数字を並べて出して。" + SLOW_TURN);
  await composer.press("Enter");
  // **host がそのターンを走らせ始めるまで待つ**（規則6——送る前に開き直すと試験にならない）
  await expect.poll(() => turnIsRunning(threadId), { timeout: 30_000, message: "送ったターンが host で始まらない" }).toBe(true);

  await page.reload();
  // 送った発言が本文にあり、その下で AI の発言が流れている
  await expect(page.locator('[data-role="user"]').filter({ hasText: "1 から 60 までの数字" })).toBeVisible({ timeout: 30_000 });
  await expectStreamingInline(page, "開き直したら、走っているターンが本文に出ない");
  await expect(page.getByRole("button", { name: "Stop generating" }), "走っているのに走っているように見えない").toBeVisible();

  await expectFinishedOnce(page, threadId, 0);
});

test("走行中に接続が切れて戻っても、エラーにならず最新の状況が出る（別アプリへ移って戻る）", async ({ page }) => {
  const proxy = await startProxy();
  try {
    const name = "E2E Reattach Cut";
    await openApp(page, proxy.url);
    await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-reattach-cut-")));
    const threadId = await baseThreadId(page, name);

    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill("1 から 60 までの数字を並べて出して。" + SLOW_TURN);
    await composer.press("Enter");
    await expectStreamingInline(page, "送ったターンが流れ始めない");

    // **携帯で別アプリへ移ると、ブラウザの接続は切られる**——張ってある接続をすべて切る
    // （ブラウザの「オフライン」切り替えでは、張ってある接続は切れない——実測・2026-09-26）
    proxy.cut();

    // 戻ったら、続きが流れ、最後まで出る
    await expectFinishedOnce(page, threadId, 0);
  } finally {
    await proxy.close();
  }
});

test("走行中に接続が黙って止まっても、見切って最新の状況が出る（回線が変わった）", async ({ page }) => {
  test.setTimeout(240_000);
  const proxy = await startProxy();
  try {
    const name = "E2E Reattach Stall";
    await openApp(page, proxy.url);
    await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-reattach-stall-")));
    const threadId = await baseThreadId(page, name);

    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill("1 から 60 までの数字を並べて出して。" + SLOW_TURN);
    await composer.press("Enter");
    await expectStreamingInline(page, "送ったターンが流れ始めない");

    // **張ってある接続を、切らずに止める**——エラーにならず、何も届かなくなる（回線が変わったときの形）
    proxy.freeze();

    // 45秒なにも届かなければ切れたとみなし、記録から最新を出す（host は15秒ごとに空行を送っている）
    await expectFinishedOnce(page, threadId, 0, 120_000);
  } finally {
    await proxy.close();
  }
});

test("この画面の外で始まったターンも、本文にそのまま流れる", async ({ page }) => {
  const name = "E2E Reattach Elsewhere";
  await openApp(page);
  await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-reattach-else-")));
  const threadId = await baseThreadId(page, name);
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible();

  // 別の画面（ここでは口を直に叩く）から送る——応答は読まずに放っておく（その画面を閉じたのと同じ）
  const elsewhere = new AbortController();
  let sendFailure: string | undefined;
  void fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "別の画面から送った発言。" + SLOW_TURN }),
    signal: elsewhere.signal,
  })
    .then((res) => {
      if (!res.ok) sendFailure = `送信が断られた（${res.status}）`;
    })
    .catch((err: unknown) => {
      // 試験の終わりに止めた分は失敗ではない
      if (!elsewhere.signal.aborted) sendFailure = String(err);
    });
  try {
    await expect
      .poll(async () => sendFailure ?? (await turnIsRunning(threadId)), { timeout: 30_000, message: "他所から送ったターンが host で始まらない" })
      .toBe(true);
    await expect(page.locator('[data-role="user"]').filter({ hasText: "別の画面から送った発言" }), "他所で送った発言が出ない").toBeVisible({ timeout: 30_000 });
    await expectStreamingInline(page, "他所で始まったターンが本文に流れない");
    await expectFinishedOnce(page, threadId, 0);
  } finally {
    elsewhere.abort();
  }
});

test("判断待ちに答えたあとに開き直しても、その判断は答えたものとして出る", async ({ page }) => {
  const name = "E2E Reattach Answered";
  await openApp(page);
  await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-reattach-ans-")));
  const threadId = await baseThreadId(page, name);

  // 承認を求めるモードにして、tool を1つ呼び、そのあと長く喋るターン
  const set = await page.request.post(`${CORE_BASE_URL}/api/threads/${threadId}/permission-mode`, {
    headers: { ...HEADERS, "content-type": "application/json" },
    data: { mode: "default" },
  });
  expect(set.status()).toBe(204);
  await page.reload();

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "一覧を見てから数えて。" +
      fakeTurn({
        tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }],
        then: LINES.join("\n"),
        thenStreamMs: 30_000,
      }),
  );
  await composer.press("Enter");
  const card = page.locator('[data-role="judgment-card"]').last();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "許可する" }).click();
  await expect(card).toContainText("回答：許可する", { timeout: 30_000 });

  // 答えたあと、まだ走っているうちに開き直す
  await expect.poll(() => turnIsRunning(threadId), { timeout: 30_000 }).toBe(true);
  await page.reload();
  // 答え済みの判断は、ほかの tool 呼び出しと一緒に畳まれて出る（答えを待っているものだけが開いて出る）
  // ——**答える口が開いたまま出ていない**ことを先に見て、それから畳みを開いて中身を見る
  await expectStreamingInline(page, "開き直したら、走っているターンが本文に出ない");
  await expect(page.getByRole("button", { name: "許可する" }), "答えた判断に、また答える口が出ている").toHaveCount(0);
  await page.getByRole("button", { name: /tool calls?$/ }).last().click();
  const again = page.locator('[data-role="judgment-card"]').last();
  await expect(again, "開き直したら判断のカードが消えた").toBeVisible({ timeout: 30_000 });
  await expect(again, "答えた判断が、また答えを待っているように見える").toContainText("回答：許可する");
  await expect(again.getByRole("button", { name: "許可する" }), "答えた判断に、また答える口が出ている").toHaveCount(0);
  await expectFinishedOnce(page, threadId, 0);
});
