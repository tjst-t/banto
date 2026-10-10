// **Terminal**（v4-modules.md §4.6、2026-10-08）——人が入口「ターミナル」から Project のコンテナでシェルを打つ。
//
// 目録から入れ、入口から開いて打つ。起こし直しを見るので自前の host（`own-host.ts`）で回す。見るもの（規則14——
// 画面に出ている値まで）：
//   1. 開く：流れが open・セッション main が選ばれている・「AI も読めます」のお知らせ・パソコンではキーの帯が出ない
//   2. 打つ：計算した出力・作業ディレクトリは Project の根・ホームは専用のホーム（Terminal の置き場の home）・host の
//      合言葉（BANTO_*）はシェルに無い
//   3. 画面を閉じて開き直す：前の出力が写しで戻り、シェルの変数が残っている（同じセッション）。お知らせは一度だけ
//   4. 2つ目のタブで同じセッション：片方で打ったものがもう片方に出る
//   5. セッションを足す・名前を変える・切り替える・閉じる（一覧の中身まで）
//   6. AI の tool 一覧（AI が繋ぐ中継の口）に Terminal の道具が出ない
//   7. banto を起こし直す：画面は繋ぎ直し、同じセッション（変数が残っている）に戻る
//   8. 携帯（指で触る端末・狭い幅）：キーの帯が出て、帯の ← と Ctrl が効く
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(600_000);

const PROJECT_NAME = "E2E Terminal";

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

async function api<T>(host: OwnHost, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} が ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const termFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

/** 入口から、ターミナルの画面を開く */
async function openTerminal(page: Page): Promise<FrameLocator> {
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:terminal:"]');
  await expect(entry, "Terminal の入口が出ない").toContainText("ターミナル", { timeout: 120_000 });
  await entry.click();
  await expect(page.getByText(/^Canvas — terminal$/)).toBeVisible({ timeout: 30_000 });
  const t = termFrame(page);
  await expect(t.getByTestId("terminal-state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 180_000 });
  return t;
}

/** 端末に1行打って Enter */
async function typeLine(page: Page, t: FrameLocator, line: string): Promise<void> {
  await t.getByTestId("terminal").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** 端末に出ている文字（xterm.js の行を全部つないだもの）に `pattern` が出るまで待つ */
async function expectScreen(t: FrameLocator, pattern: RegExp, message?: string): Promise<void> {
  await expect(t.locator(".xterm-rows"), message).toContainText(pattern, { timeout: 30_000 });
}

/** AI（Runner）に見えている道具の一覧を、AI が繋ぐのと同じ中継の口で取る */
async function toolsVisibleToAgent(host: OwnHost, connName: string): Promise<string[]> {
  const client = new Client({ name: "e2e-terminal-visibility", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${host.apiUrl}/agent-relay/${connName}`), {
      requestInit: { headers: { authorization: `Bearer ${host.token}` } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

test("ターミナル：入口から開いて打ち、閉じて開き直す・2つのタブ・起こし直しで同じセッションに戻る。AI に道具は見えず、携帯ではキーの帯が出る", async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-terminal-"));

  await withOwnHost(async (host) => {
    await login(page, host);
    await api(host, "/api/modules/catalog/terminal", { method: "POST", body: JSON.stringify({ name: "terminal" }) });

    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, projectRoot);
    const projects = await api<Array<{ id: string; name: string }>>(host, "/api/projects");
    const projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;

    // ---- 1. 開く ----
    let t = await openTerminal(page);
    await expect(t.locator('.tab[data-session="main"]'), "セッション main が選ばれていない").toHaveAttribute("aria-selected", "true");
    await expect(t.locator(".tab")).toHaveCount(1);
    await expect(t.getByTestId("terminal-ai-notice")).toBeVisible();
    await expect(t.getByTestId("terminal-ai-notice")).toContainText("この Project の AI も、このセッションを読めます");
    await expect(t.getByTestId("terminal-keys"), "パソコンでキーの帯が出ている").toBeHidden();

    // ---- 2. 打つ：出力・作業ディレクトリ・専用のホーム・合言葉が無いこと ----
    await typeLine(page, t, 'echo "ok-$((6*7))"; echo "cwd=$(pwd)"; echo "home=$HOME"; echo "token=${BANTO_HOST_MCP_TOKEN:-none}"; export MARK=keep-1');
    await expectScreen(t, /ok-42/, "打った計算の出力が出ない");
    await expectScreen(t, new RegExp(`cwd=${projectRoot}`), "作業ディレクトリが Project の根でない");
    await expectScreen(t, new RegExp(`home=${host.dataDir}/modules/terminal-${projectId}/home`), "ホームが Terminal の専用のホームでない");
    await expectScreen(t, /token=none/, "host の合言葉がシェルに渡っている");
    // 日本語のまま往復する
    await typeLine(page, t, 'echo "あい""うえお"');
    await expectScreen(t, /あいうえお/);

    // ---- 3. 画面を閉じて開き直す：写しが戻り、同じセッション（変数が残る）。お知らせは閉じたら出ない ----
    await t.getByRole("button", { name: "お知らせを閉じる" }).click();
    await expect(t.getByTestId("terminal-ai-notice")).toBeHidden();
    await page.getByRole("button", { name: "Canvas を閉じる" }).click();
    await expect(page.getByText(/^Canvas — terminal$/)).toBeHidden();
    t = await openTerminal(page);
    await expectScreen(t, /ok-42/, "開き直したとき前の出力が写しで戻らない");
    await expect(t.getByTestId("terminal-ai-notice"), "閉じたお知らせがまた出た").toBeHidden();
    await typeLine(page, t, 'echo "mark=$MARK-reopened"');
    await expectScreen(t, /mark=keep-1-reopened/, "開き直したら別のシェルになっている");

    // ---- 4. 2つ目のタブで同じセッション ----
    const pageB = await page.context().newPage();
    pageB.on("pageerror", (err) => pageErrors.push(`B: ${err.message}`));
    await pageB.goto(page.url());
    const b = termFrame(pageB);
    await expect(b.getByTestId("terminal-state")).toHaveAttribute("data-state", "open", { timeout: 60_000 });
    await expectScreen(b, /mark=keep-1-reopened/, "2つ目のタブに同じセッションの中身が出ない");
    await typeLine(pageB, b, 'echo "from-b-$((2+3))"');
    await expectScreen(t, /from-b-5/, "2つ目のタブで打ったものが1つ目に出ない");
    await typeLine(page, t, 'echo "from-a-$((3+4))"');
    await expectScreen(b, /from-a-7/, "1つ目のタブで打ったものが2つ目に出ない");
    await pageB.close();

    // ---- 5. セッションを足す・名前を変える・切り替える・閉じる ----
    await t.getByRole("button", { name: "＋ 足す" }).click();
    await expect(t.locator('.tab[data-session="s2"]')).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(t.getByTestId("terminal-state")).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(t.locator(".xterm-rows"), "新しいセッションに main の出力が出ている").not.toContainText("from-a-7", { timeout: 15_000 });
    await t.getByRole("button", { name: "s2 の名前を変える" }).click();
    await t.getByTestId("rename-input").fill("作業");
    await t.getByTestId("rename-input").press("Enter");
    await expect(t.locator(".tab")).toHaveCount(2);
    await expect(t.locator('.tab[data-session="作業"]')).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(t.locator('.tab[data-session="s2"]')).toHaveCount(0);
    await typeLine(page, t, 'echo "in-$((10+1))"');
    await expectScreen(t, /in-11/);
    // main に切り替える：main の中身が戻る
    await t.locator('.tab[data-session="main"] .tab-name').click();
    await expect(t.locator('.tab[data-session="main"]')).toHaveAttribute("aria-selected", "true");
    await expectScreen(t, /from-a-7/, "main に切り替えても main の中身が出ない");
    // 閉じる（押してから、もう一度押す）
    await t.getByRole("button", { name: "作業 を閉じる" }).click();
    await t.getByRole("button", { name: "作業 を本当に閉じる" }).click();
    await expect(t.locator(".tab")).toHaveCount(1, { timeout: 15_000 });
    await expect(t.locator('.tab[data-session="main"]')).toHaveAttribute("aria-selected", "true");
    await expect(t.getByTestId("terminal-lost"), "閉じたセッションが「消えたもの」に出ている").toBeHidden();

    // ---- 6. AI の tool 一覧に Terminal の道具が出ない ----
    const agentTools = await toolsVisibleToAgent(host, `terminal-${projectId}`);
    expect(agentTools, "AI に Terminal の道具が見えている").toEqual([]);

    // ---- 7. banto を起こし直す：繋ぎ直して、同じセッションに戻る ----
    await host.stop("SIGTERM");
    await expect(t.getByTestId("terminal-state")).toHaveAttribute("data-state", "reconnecting", { timeout: 15_000 });
    await host.start();
    await expect(t.getByTestId("terminal-state"), "起こし直したあと繋ぎ直さない").toHaveAttribute("data-state", "open", { timeout: 180_000 });
    await expectScreen(t, /from-a-7/, "起こし直したあと前の出力が戻らない");
    await typeLine(page, t, 'echo "mark=$MARK-restarted"');
    await expectScreen(t, /mark=keep-1-restarted/, "起こし直したら別のシェルになっている");

    // ---- 8. 携帯：キーの帯が出て、帯の ← と Ctrl が効く ----
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await mobile.newPage();
      m.on("pageerror", (err) => pageErrors.push(`mobile: ${err.message}`));
      await login(m, host);
      await openApp(m, host.url);
      await m.goto(page.url());
      const mt = termFrame(m);
      await expect(mt.getByTestId("terminal-state")).toHaveAttribute("data-state", "open", { timeout: 60_000 });
      const keys = mt.getByTestId("terminal-keys");
      await expect(keys, "携帯でキーの帯が出ない").toBeVisible();
      await expect(keys.locator(".key")).toHaveText(["Esc", "Ctrl", "Tab", "←", "↑", "↓", "→", "|", "~", "/", "-", "コピー"]);
      // ← を2回で、カーソルを戻して打ち込む：`echo k$((7*1))` の「1」の後ろに「1」を足すと 7*11
      await mt.getByTestId("terminal").click();
      await m.keyboard.type("echo k$((7*1))");
      await keys.getByRole("button", { name: "←" }).click();
      await keys.getByRole("button", { name: "←" }).click();
      await m.keyboard.type("1");
      await m.keyboard.press("Enter");
      await expectScreen(mt, /k77/, "帯の ← が効かない");
      // Ctrl は次の1文字にだけ効く：長く待つコマンドを Ctrl+C で止める
      await m.keyboard.type('sleep 300; echo "not-""interrupted"');
      await m.keyboard.press("Enter");
      await keys.getByRole("button", { name: "Ctrl（次の1文字）" }).click();
      await expect(keys.getByRole("button", { name: "Ctrl（次の1文字）" })).toHaveAttribute("aria-pressed", "true");
      await m.keyboard.type("c");
      await expect(keys.getByRole("button", { name: "Ctrl（次の1文字）" })).toHaveAttribute("aria-pressed", "false");
      await m.keyboard.type('echo "after-ctrl-c-$((5*5))"');
      await m.keyboard.press("Enter");
      await expectScreen(mt, /after-ctrl-c-25/, "帯の Ctrl+C で止まらない");
      await expect(mt.locator(".xterm-rows")).not.toContainText("not-interrupted");
      // 同じセッションなので、パソコンの画面にも出る
      await expectScreen(t, /after-ctrl-c-25/);
    } finally {
      await mobile.close();
    }

    // 開閉だけを host の記録に残す（打った中身は残さない）
    expect(host.log()).toContain('"event":"stream.open"');
    expect(host.log(), "打った中身が host の記録に残っている").not.toContain("keep-1");
  });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
