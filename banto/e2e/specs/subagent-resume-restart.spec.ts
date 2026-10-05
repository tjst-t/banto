// **サブエージェントに待たずに頼んだ仕事の途中で host が落ちても、起き直したら続いて、頼んだ Thread に結果が届く**
// （追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の「2. Module の仕事を続ける」）。
//
// 自前の host（`own-host.ts`）で、偽のエージェントの仕事（runInBackground）が tool の途中のところで host を SIGKILL で
// 落とし、起こし直す。見るもの（規則14）：
//   - 起き直した host が Subagent に続けるかを聞き、Subagent が続けると答える（札は返事待ちのまま、続けると答えた時刻が付く）
//   - 続けている間、サイドバーのバックグラウンドの一覧に「起こし直しのあと続けています」が出る
//   - Subagent が会話を続きから開き、「途中で切れました。実行中だった tool：…」を送り、その結果が**同じ札で**頼んだ
//     Thread に届く（「途中で終わりました」は届かない）。AI が起きて続きをやる
//   - 届いたら、バックグラウンドの印も走っている仕事の記録も消える
import { test, expect, type Page } from "../test-base.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Resume";
const PROMPT = "[slow 60] [then-slow 8] 長い仕事";

interface HostThread {
  id: string;
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string }>;
  lastTurn?: { cause: string; outcome?: string };
}

async function api<T>(host: OwnHost, path: string): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return (await res.json()) as T;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

test("待たずに頼んだサブエージェントの仕事の途中で host が落ちても、起き直したら続いて結果が頼んだ Thread に届く", async ({ page }) => {
  await withOwnHost(async (host) => {
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-subagent-resume-")));
    const project = (await api<Array<{ id: string; name: string }>>(host, "/api/projects")).find((p) => p.name === PROJECT_NAME)!;
    const threadId = (await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`))[0]!.id;
    const thread = () => api<HostThread>(host, `/api/threads/${threadId}`);
    const runningDir = join(host.dataDir, "modules", `subagent-${project.id}`, "running");
    const runningFiles = () => (existsSync(runningDir) ? readdirSync(runningDir).filter((f) => f.endsWith(".json")) : []);

    // ---- 待たずに頼む ----------------------------------------------------------------------------------
    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill(
      "サブエージェントに待たずに頼んで。" +
        fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: PROMPT, runInBackground: true } }] }),
    );
    await composer.press("Enter");
    // 鍵を使うエージェントは初回に Vault の在りかを聞く（Project ごとに1回）
    await expect(async () => {
      const allow = page.getByRole("button", { name: "許可する" });
      if ((await allow.count()) > 0) await allow.last().click();
      await expect(page.getByText(/待たずに頼みました/).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 180_000 });
    await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
    // 仕事が tool の途中まで進み、走っている記録に残った
    await expect
      .poll(
        () => runningFiles().map((f) => (JSON.parse(readFileSync(join(runningDir, f), "utf8")) as { toolsInFlight: Array<{ title: string }> }).toolsInFlight.map((t) => t.title)),
        { timeout: 60_000, message: "走っている仕事の記録に tool が残らない" },
      )
      .toEqual([["sleep 60"]]);
    expect((await thread()).awaitingReplies?.map((r) => r.moduleName)).toEqual(["subagent"]);

    // ---- host が落ちて、起き直す --------------------------------------------------------------------------
    await host.stop("SIGKILL");
    await host.start();

    // Subagent が続けると答えた（札は返事待ちのまま、続けると答えた時刻が付く）
    await expect
      .poll(async () => (await thread()).awaitingReplies?.map((r) => Boolean(r.keptAt)), { timeout: 120_000, message: "続けると答えない" })
      .toEqual([true]);
    // 続けている間、サイドバーに「起こし直しのあと続けています」
    const line = page.locator('[data-sidebar="sidebar"]').getByTestId("thread-background");
    await expect(line, "起き直したあとバックグラウンドの印が出ない").toHaveText("fake に頼んだ仕事", { timeout: 60_000 });
    await line.click();
    const item = page.getByTestId("background-list").getByTestId("background-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("fake に頼んだ仕事");
    await expect(item.getByTestId("background-item-kept")).toHaveText(/^起こし直しのあと続けています（(いま|\d+分前)から）$/);
    await page.keyboard.press("Escape");

    // ---- 同じ札で結果が届き、AI が起きる ------------------------------------------------------------------
    await expect
      .poll(async () => (await thread()).messages.filter((m) => m.origin?.from === "subagent").map((m) => m.origin!.title), {
        timeout: 120_000,
        message: "結果が届かない",
      })
      .toEqual(["Fake Agent（試験用） の仕事が終わりました"]);
    const done = await thread();
    const delivered = done.messages.find((m) => m.origin?.from === "subagent")!;
    expect(delivered.text).toContain(
      "受け取った：banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：sleep 60——結果は分かりません",
    );
    expect(delivered.text).toContain('"resumedAfterRestart":true');
    expect(done.messages.some((m) => /途中で終わりました/.test(m.origin?.title ?? "")), "「途中で終わりました」も届いた").toBe(false);
    await expect.poll(async () => (await thread()).lastTurn, { timeout: 60_000 }).toMatchObject({ cause: "delivery", outcome: "completed" });
    expect((await thread()).awaitingReplies ?? []).toEqual([]);
    expect(runningFiles(), "届けたのに走っている記録が残っている").toEqual([]);
    expect(host.log()).toMatch(/前の走行の返事待ち（subagent・Thread [^）]+）→ 続けると答えた/);

    // 画面：届いたものの札に、続けた結果が出る。バックグラウンドの印は消える
    const card = page.getByTestId("delivered-message").filter({ hasText: "subagent から届きました" });
    await expect(card, "届いたものが画面に出ない").toHaveCount(1, { timeout: 60_000 });
    await expect(card).toContainText("Fake Agent（試験用） の仕事が終わりました");
    await expect(line, "届いたのにバックグラウンドの印が残っている").toHaveCount(0, { timeout: 30_000 });
  });
});
