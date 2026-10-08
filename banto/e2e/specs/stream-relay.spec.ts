// **画面と Module の間の流れ**（決定・2026-10-08、アーキ仕様 §5.8）。
//
// 試験用の Module（`fixtures/stream-echo-module`、Project のコンテナの中で動く）のこだまの流れを、入口から開いた画面で
// 使う。起こし直しを見るので自前の host（`own-host.ts`）で回す。見るもの（規則14——画面に出ている値まで）：
//   1. 開く：状態が open になり、Module の挨拶に host が組んだ刻印（名前・params・human・Project）が出る
//   2. 文字が往復する（日本語のまま）
//   3. 約 900KiB の2進を1通送ると、Module が受け取った大きさと SHA-256、返ってきた2進の大きさと SHA-256 が、送ったものと
//      一致する（両向きに崩れない）
//   4. 1MiB を越えた1通は 1009 で閉じ、画面は自分で繋ぎ直す（挨拶が次の1本になる）
//   5. 同じ画面をもう1つのタブで開く（同じ名前の流れが2本）：片方に送ったものはもう片方に出ない。片方を閉じても
//      もう片方は続く
//   6. banto を起こし直す：画面は 1012 で切られ、「繋ぎ直しています」を経て、起き直した Module に自分で繋ぎ直す
//   7. 札：機械の合言葉では出ない・名乗っていない名前には出ない・使い回し／期限切れ／Origin 違いは断られる
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(480_000);

const MODULE = "echo";
const PROJECT_NAME = "E2E Stream Relay";
const RESOURCE_URI = "ui://stream-echo/main";
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/stream-echo-module/server.js");

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

async function api<T>(host: OwnHost, path: string): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return (await res.json()) as T;
}

const echoFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

/** 入口から、こだまの画面を開く */
async function openEchoCanvas(page: Page): Promise<void> {
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /流れのこだま/ });
  await expect(entry, "試験用の Module の入口が出ない").toBeVisible({ timeout: 60_000 });
  await entry.click();
  await expect(page.getByText(new RegExp(`^Canvas — ${MODULE}$`))).toBeVisible({ timeout: 30_000 });
}

/** 文字を送って、その画面にこだまが出るまで待つ */
async function sendText(page: Page, text: string): Promise<void> {
  const frame = echoFrame(page);
  await frame.locator("#text").fill(text);
  await frame.locator("#send").click();
  await expect(frame.locator("#log li").filter({ hasText: new RegExp(`^echo:${text}$`) })).toHaveCount(1, { timeout: 15_000 });
}

/** node の WebSocket で札を使ってみる。最初に届いた1通か、閉じた番号・断られた番号を返す */
function tryTicket(url: string, ticket: string, origin: string): Promise<{ hello?: string; closed?: number; rejected?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    ws.on("open", () => ws.send(JSON.stringify({ ticket })));
    ws.on("message", (data) => {
      resolve({ hello: data.toString() });
      ws.close();
    });
    ws.on("close", (code) => resolve({ closed: code }));
    ws.on("unexpected-response", (_req, res) => {
      resolve({ rejected: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on("error", () => undefined);
  });
}

test("流れ：開いて文字と大きい2進が往復し、1MiB 越えは 1009、同じ名前の2本は混ざらず、起こし直すと繋ぎ直す。札は断るべきものを断る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await withOwnHost(async (host) => {
    await login(page, host);
    // Project ごとに立つ形（`${projectRoot}` を使う）——Project のコンテナの中で動き、置き場のソケットに host が繋ぐ
    const added = await fetch(`${host.apiUrl}/api/modules`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mcpServers: { [MODULE]: { command: "${nodeExec}", args: [SERVER, "${projectRoot}"] } } }),
    });
    expect(added.status, `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);

    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-stream-relay-")));
    await openEchoCanvas(page);
    const a = echoFrame(page);

    // ---- 1. 開く ----
    await expect(a.locator("#state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 60_000 });
    await expect(a.getByTestId("hello")).toHaveText(/^#1 [0-9a-f]{8} echo \{"greeting":"こんにちは"\} human=true project=yes$/, { timeout: 15_000 });
    const firstBoot = await a.getByTestId("hello").getAttribute("data-boot");

    // ---- 2. 文字 ----
    await sendText(page, "あいう");

    // ---- 3. 大きい2進（約 900KiB）が両向きに崩れない ----
    await a.locator("#big").click();
    await expect(a.locator("#big-sent")).toHaveText(/^921600:[0-9a-f]{64}$/, { timeout: 15_000 });
    const sent = (await a.locator("#big-sent").textContent())!;
    await expect(a.locator("#big-at-module"), "Module が受け取った2進が送ったものと違う").toHaveText(sent, { timeout: 30_000 });
    await expect(a.locator("#big-back"), "返ってきた2進が送ったものと違う").toHaveText(sent, { timeout: 30_000 });

    // ---- 4. 1MiB を越えた1通は 1009。画面は自分で繋ぎ直す ----
    await a.locator("#too-big").click();
    await expect(a.locator("#closes")).toHaveText("1009", { timeout: 15_000 });
    await expect(a.getByTestId("hello"), "1009 のあと繋ぎ直さない").toHaveAttribute("data-id", "2", { timeout: 15_000 });
    await expect(a.locator("#state")).toHaveAttribute("data-state", "open");
    await sendText(page, "繋ぎ直したあと");

    // ---- 5. 同じ名前の流れを2本（同じ画面をもう1つのタブで） ----
    const pageB = await page.context().newPage();
    pageB.on("pageerror", (err) => pageErrors.push(`B: ${err.message}`));
    await pageB.goto(page.url());
    const b = echoFrame(pageB);
    await expect(b.locator("#state"), "2つ目の画面の流れが開かない").toHaveAttribute("data-state", "open", { timeout: 60_000 });
    await expect(b.getByTestId("hello")).toHaveAttribute("data-id", "3", { timeout: 15_000 });
    await sendText(page, "Aから");
    await sendText(pageB, "Bから");
    await expect(a.locator("#log li"), "B に送ったものが A に混ざった").toHaveText(["echo:あいう", "echo:繋ぎ直したあと", "echo:Aから"]);
    await expect(b.locator("#log li"), "A に送ったものが B に混ざった").toHaveText(["echo:Bから"]);
    await pageB.close();
    await sendText(page, "Bを閉じたあと");
    await expect(a.locator("#state")).toHaveAttribute("data-state", "open");

    // ---- 6. banto を起こし直す：1012 で切られ、起き直した Module に自分で繋ぎ直す ----
    await host.stop("SIGTERM");
    await expect(a.locator("#closes"), "起こし直しのとき 1012 で閉じていない").toHaveText("1009,1012", { timeout: 15_000 });
    await expect(a.locator("#state")).toHaveAttribute("data-state", "reconnecting");
    await host.start();
    await expect(a.locator("#state"), "起き直したあと繋ぎ直さない").toHaveAttribute("data-state", "open", { timeout: 90_000 });
    await expect(a.getByTestId("hello")).toHaveAttribute("data-id", "1", { timeout: 15_000 });
    const secondBoot = await a.getByTestId("hello").getAttribute("data-boot");
    expect(secondBoot, "起き直した Module に繋がっていない（前の Module の挨拶のまま）").not.toBe(firstBoot);
    await sendText(page, "起こし直したあと");

    // ---- 7. 札：断るべきものを断る ----
    const projects = await api<Array<{ id: string; name: string }>>(host, "/api/projects");
    const projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
    const { sandboxUrl } = await api<{ sandboxUrl: string }>(host, "/api/ui-config");
    const sandboxOrigin = new URL(sandboxUrl).origin;
    const body = { server: MODULE, resourceUri: RESOURCE_URI, name: "echo", params: {}, frame: "e2e-api" };
    const asHuman = (data: unknown) =>
      page.context().request.post(`${host.url}/api/projects/${projectId}/ui-stream`, {
        headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
        data,
      });

    // 機械の合言葉では出ない
    const byMachine = await fetch(`${host.apiUrl}/api/projects/${projectId}/ui-stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(byMachine.status, "機械の合言葉で札が出た").toBe(403);
    // 名乗っていない名前には出ない
    expect((await asHuman({ ...body, name: "shell" })).status()).toBe(403);

    // 使い回し
    const grant = (await (await asHuman(body)).json()) as { url: string; ticket: string; expiresAt: string };
    expect(grant.url).toBe(`${host.url.replace(/^http/, "ws")}/api/streams`);
    const used = await tryTicket(grant.url, grant.ticket, sandboxOrigin);
    expect(used.hello, `正しい札で繋がらない：${JSON.stringify(used)}`).toContain('"type":"hello"');
    expect(await tryTicket(grant.url, grant.ticket, sandboxOrigin), "使った札がもう一度通った").toEqual({ closed: 1008 });
    // Origin 違い（banto の画面のオリジン・公開先から）
    const other = (await (await asHuman(body)).json()) as { ticket: string };
    expect(await tryTicket(grant.url, other.ticket, FRONTEND_BASE_URL), "サンドボックスでない Origin で通った").toEqual({ rejected: 403 });
    // 期限切れ（30 秒）
    const late = (await (await asHuman(body)).json()) as { ticket: string };
    await new Promise((r) => setTimeout(r, 31_000));
    expect(await tryTicket(grant.url, late.ticket, sandboxOrigin), "切れた札が通った").toEqual({ closed: 1008 });

    // 開閉だけを host の記録に残す（中身は残さない）
    expect(host.log()).toContain('"event":"stream.open"');
    expect(host.log()).toContain('"event":"stream.close"');
    expect(host.log(), "流した中身が host の記録に残っている").not.toContain("Bを閉じたあと");
  });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
