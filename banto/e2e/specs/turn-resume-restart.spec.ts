// **ターンの途中で host が落ちても、起き直したら人が何もせずに続く**（追加・2026-10-05、アーキ仕様 §2.5
// 「起こし直しをまたいで続ける」）。
//
// 自前の host（`own-host.ts`）で AI のターンを流している途中に host を SIGKILL で落とし、起こし直す。見るもの（規則14）：
//   - 切れたターンの吹き出しの最後に「（起こし直しで切れました）」
//   - banto からの届いたもの（「banto を起こし直したため、直前のターンが途中で切れました」）が、人の吹き出しではなく
//     届いたものの札で出る
//   - 続きのターンが最後まで流れる（人の発言は増えない）
//   - host の記録：続きのターンは attempt 1 で最後まで行き、切れたターンはもう「切れた」に見えない
//   - 受信箱にお知らせは出ない（会話は続いている）
// 続けて3回切れたら（上限）自動では続けず、受信箱の「続ける」・その会話で人が送る、のどちらかで続く（attempt 0 から）。
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(300_000);

/** 20 秒かけて [1]〜[20] を流すターン（途中で落とす隙を作る） */
const LINES = Array.from({ length: 20 }, (_, i) => `[${i + 1}]`);
const SLOW_TURN = fakeTurn({ say: LINES.join("\n"), streamMs: 20_000 });
const PROJECT_NAME = "E2E Resume Restart";

/** 続けて切れた回数の上限（core の `RESUME_CUT_LIMIT`。切れた→続ける→切れた→もう一度だけ続ける→切れた、でやめる） */
const CUT_LIMIT = 3;
const GAVE_UP_TITLE = "この会話は起こし直しのたびに切れるので、自動で続けるのをやめました";

interface HostThread {
  messages: Array<{ seq: number; role: string; text: string; origin?: { from: string; title: string } }>;
  deliveries?: Array<{ from: string; continues?: { attempt: number } }>;
  lastTurn?: { attempt: number; cause: string; outcome?: string; continuesTurnId?: string };
}

async function api<T>(host: OwnHost, path: string): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return (await res.json()) as T;
}

async function baseThread(host: OwnHost): Promise<HostThread & { id: string }> {
  const projects = await api<Array<{ id: string; name: string }>>(host, "/api/projects");
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const [thread] = await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`);
  return { id: thread!.id, ...(await api<HostThread>(host, `/api/threads/${thread!.id}`)) };
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

test("ターンの途中で host が落ちて起き直すと、「（起こし直しで切れました）」と続きが出て、最後まで走る", async ({ page }) => {
  await withOwnHost(async (host) => {
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-resume-restart-")));

    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill("1 から 20 まで数えて。" + SLOW_TURN);
    await composer.press("Enter");
    // **書き終えた発言が記録に入ってから**落とす（入る前に落としても、切れた吹き出しが無い）
    await expect
      .poll(async () => (await baseThread(host)).messages.find((m) => m.role === "assistant")?.text ?? "", {
        timeout: 60_000,
        message: "ターンが流れ始めない",
      })
      .toContain("[3]");
    const before = await baseThread(host);
    expect(before.lastTurn?.outcome, "落とす前にターンが終わった（試験の前提が崩れた）").toBeUndefined();

    // **落ちる**（SIGKILL——片づけの暇は無い）。そして起こし直す
    await host.stop("SIGKILL");
    await host.start();

    // 画面：切れた吹き出しの最後に印、banto の札、続きが最後まで
    const assistants = page.locator('[data-role="assistant"]');
    await expect(assistants.first(), "切れた吹き出しに印が出ない").toContainText("（起こし直しで切れました）", { timeout: 60_000 });
    const card = page.getByTestId("delivered-message");
    await expect(card, "banto からの届いたものが出ない").toHaveCount(1, { timeout: 60_000 });
    await expect(card).toHaveAttribute("data-from", "banto");
    await expect(card.getByTestId("delivered-title")).toHaveText("banto を起こし直したため、直前のターンが途中で切れました");
    await expect(assistants, "続きのターンが出ない／吹き出しが二重").toHaveCount(2, { timeout: 60_000 });
    await expect(assistants.last(), "続きが最後まで流れない").toContainText("[20]", { timeout: 60_000 });
    await expect(page.locator('[data-role="user"]'), "続きが人の発言として出た").toHaveCount(1);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });

    // host の記録
    await expect.poll(async () => (await baseThread(host)).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
    const after = await baseThread(host);
    expect(after.lastTurn?.attempt, "続きのターンが attempt 1 で走っていない").toBe(1);
    expect(after.messages.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role))).toEqual([
      "user",
      "assistant",
      "delivered:banto",
      "assistant",
    ]);
    expect(after.messages[1]!.text).toMatch(/\[3\][\s\S]*（起こし直しで切れました）$/);
    expect(after.messages[2]!.text, "続きの文に切れたことが書かれていない").toContain("banto を起こし直したため");
    expect(after.messages[3]!.text).toContain("[20]");
    // 受信箱：続きの「届きました」も「自動で続けるのをやめました」も出ない（会話は続いている）
    const inbox = await api<Array<{ kind: string; title?: string; dedupeKey?: string }>>(host, "/api/inbox");
    expect(
      inbox.filter((i) => i.kind === "notice" && /^(delivery|turn-resume):/.test(i.dedupeKey ?? "")),
      "続けたのにお知らせが出た",
    ).toEqual([]);
    expect(inbox.filter((i) => i.kind === "notice").map((i) => i.title), "Module が繋がらない（試験の前提が崩れた）").toEqual([]);

    // もう一度起こし直しても、同じターンを続け直さない
    await host.stop("SIGTERM");
    await host.start();
    await page.waitForTimeout(3_000);
    expect((await baseThread(host)).messages.length, "起こし直すたびに続け直している").toBe(4);
  });
});

/**
 * 続けて `CUT_LIMIT` 回切れるところまで進める：最初のターンを流し、AI の発言が [3] まで流れるたびに host を落として
 * 起こし直す（続きもまた [3] まで流れたところで落とす）。終わると、自動で続けるのをやめた状態
 */
async function cutUntilGivenUp(page: Page, host: OwnHost, name: string): Promise<() => Promise<HostThread>> {
  const thread = async (): Promise<HostThread> => {
    const projects = await api<Array<{ id: string; name: string }>>(host, "/api/projects");
    const project = projects.find((p) => p.name === name)!;
    const [t] = await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`);
    return api<HostThread>(host, `/api/threads/${t!.id}`);
  };
  await login(page, host);
  await openApp(page, host.url);
  await createProject(page, name, mkdtempSync(join(tmpdir(), "banto-e2e-resume-give-up-")));
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("1 から 20 まで数えて。" + SLOW_TURN);
  await composer.press("Enter");
  for (let replies = 1; replies <= CUT_LIMIT; replies++) {
    // 最後の AI の発言が [3] まで流れ、まだ終わっていない——そこで落とす
    await expect
      .poll(
        async () => {
          const t = await thread();
          const said = t.messages.filter((m) => m.role === "assistant");
          return said.length === replies && said.at(-1)!.text.includes("[3]") && t.lastTurn?.outcome === undefined;
        },
        { timeout: 60_000, message: `${replies} 件目の AI の発言が流れ始めない` },
      )
      .toBe(true);
    if (replies > 1) expect((await thread()).lastTurn?.attempt, `${replies - 1} 回目の続き`).toBe(replies - 1);
    await host.stop("SIGKILL");
    await host.start();
  }
  // 3回目の切れ：自動では続けない。続きは積んで留めている
  await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 30_000 }).toBe("failed");
  await page.waitForTimeout(3_000);
  const stopped = await thread();
  expect(stopped.messages.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role)), "自動で続け直した").toEqual([
    "user",
    "assistant",
    "delivered:banto",
    "assistant",
    "delivered:banto",
    "assistant",
  ]);
  expect(stopped.messages[5]!.text).toMatch(/（起こし直しで切れました）$/);
  expect(stopped.deliveries?.map((d) => [d.from, d.continues?.attempt]), "続きを積んで留めていない").toEqual([["banto", CUT_LIMIT]]);
  return thread;
}

test(`続けて ${CUT_LIMIT} 回切れたら自動では続けず、受信箱の「続ける」を押すと attempt 0 で最後まで走る`, async ({ page }) => {
  const name = "E2E Resume Give Up";
  await withOwnHost(async (host) => {
    const thread = await cutUntilGivenUp(page, host, name);

    // 受信箱に1件、「続ける」が押せる
    await page.getByRole("button", { name: "受信箱" }).click();
    const notice = page.locator('[data-testid="inbox-notice"]').filter({ hasText: GAVE_UP_TITLE });
    await expect(notice, "受信箱にお知らせが出ない").toHaveCount(1, { timeout: 30_000 });
    await expect(notice).toContainText(`${name} の Base Thread——起こし直しで続けて ${CUT_LIMIT} 回切れました`);
    // 続けて2回押しても、頼むのは1回（返事が来るまでボタンは効かない）。描き直す前の2回目も止まるかを見るため、同じ
    // 手番で2回押す
    const resumeRequests: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/inbox\/[^/]+\/resume$/.test(r.url())) resumeRequests.push(r.url());
    });
    await notice.getByTestId("inbox-notice-resume").evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(notice, "押したのにお知らせが残っている").toHaveCount(0, { timeout: 30_000 });
    expect(resumeRequests, "「続ける」を二重に頼んだ").toHaveLength(1);
    await expect(page.getByTestId("inbox-notice-resume-error")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 続きが最後まで走る
    await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 90_000 }).toBe("completed");
    const done = await thread();
    expect(done.lastTurn?.attempt, "人が押した続きなのに切れた回数を数え続けた").toBe(0);
    expect(done.lastTurn?.cause).toBe("delivery");
    expect(done.messages.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role))).toEqual([
      "user",
      "assistant",
      "delivered:banto",
      "assistant",
      "delivered:banto",
      "assistant",
      "delivered:banto",
      "assistant",
    ]);
    expect(done.messages[7]!.text).toContain("[20]");
    // 画面にも出ている
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("[20]", { timeout: 30_000 });
    await expect(page.getByTestId("delivered-message")).toHaveCount(3);
    await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  });
});

test(`続けて ${CUT_LIMIT} 回切れたあと、その会話で人が送ると、そのターンが切れた会話を引き継ぐ（お知らせは片づく）`, async ({ page }) => {
  const name = "E2E Resume Human Takes Over";
  await withOwnHost(async (host) => {
    const thread = await cutUntilGivenUp(page, host, name);
    // お知らせは出ている（押さない）
    const notices = async () =>
      (await api<Array<{ kind: string; title?: string }>>(host, "/api/inbox")).filter((i) => i.kind === "notice" && i.title === GAVE_UP_TITLE);
    expect(await notices()).toHaveLength(1);

    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill("続けて。" + fakeTurn({ say: "人の発言を受けて続けました" }));
    await composer.press("Enter");

    await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 90_000 }).toBe("completed");
    const done = await thread();
    expect(done.lastTurn?.attempt, "人が送ったのに切れた回数を数え続けた").toBe(0);
    expect(done.lastTurn?.cause).toBe("human");
    expect(done.deliveries ?? [], "続きが待ち行列に残っている").toEqual([]);
    expect(done.messages.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role))).toEqual([
      "user",
      "assistant",
      "delivered:banto",
      "assistant",
      "delivered:banto",
      "assistant",
      "delivered:banto",
      "user",
      "assistant",
    ]);
    expect(done.messages[6]!.text, "引き継いだ続きの文").toContain("banto を起こし直したため");
    expect(done.messages[8]!.text).toContain("人の発言を受けて続けました");
    expect(await notices(), "引き継いだのにお知らせが残っている").toEqual([]);

    // 画面：返事が出る。人が送ったターンが一緒に積んだ届いたもの（ここでは3つめの続き）は、送った画面の流れには
    // 出ない（ターンの流れに「積んだ」という出来事が無い——留めていた届いたものを人のターンが積むときと同じ、前から
    // の形）。記録から組み直すと、人の吹き出しの前に3つめの札として出る
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("人の発言を受けて続けました", { timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId("delivered-message"), "引き継いだ続きの札が出ない").toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator('[data-role="user"]')).toHaveCount(2);
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(4);
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("人の発言を受けて続けました");
    // 並び：3つめの札は2つめの人の吹き出しより前
    const order = await page
      .locator('[data-testid="delivered-message"], [data-role="user"]')
      .evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") === "delivered-message" ? "card" : "user")));
    expect(order).toEqual(["user", "card", "card", "card", "user"]);
    await page.getByRole("button", { name: "受信箱" }).click();
    await expect(page.locator('[data-testid="inbox-notice"]').filter({ hasText: GAVE_UP_TITLE }), "受信箱にお知らせが残っている").toHaveCount(0);
  });
});
