// **入口「サービス」**（決定・2026-10-20、ユーザー、案A。v4-modules.md §4.2「人の画面——サービス」、Backlog #493）。
// Command Palette の「Module の入口」から、AI を介さずに開く。本番と同じ経路：host → コンテナの中の Service → コンテナの中の
// systemd のユーザー単位。Service は目録から入れるので、自分の host で（ほかの spec の Project に Service を足さない）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 入口から開くと、AI が登録したサービスが一覧に出る——名前・状態「動いています」・ポート（待ち受けている）・動いている時間
//   2. 選ぶと中身（会話の隣は狭い形——一覧と中身を行き来する）：コマンド・ポート・起こし直した回数・最後の終了コード・作業場所・秘密・
//      ログ（時刻つき。開いたままで増える）
//   3. 「止める」で止めました（AI の listServices も stopped）、「起動」で動いています、「起こし直す」で起き直す——どれもログに
//      起きた・止められたの行が増えることで、本当に効いたと分かる
//   4. 「消す」は確かめの一言（公開もやめる）を出し、押すと一覧から消える（AI の listServices も空）
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, currentProjectId, openApp, openPaletteEntry } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

const PORT = 18766;
// 起きたら「起きました」を1回、そのあと1秒ごとに tick を書く（ログが開いたままで増えるのを見る）。待ち受けは python の http.server
const COMMAND = `echo 起きました; python3 -m http.server ${PORT} --bind 127.0.0.1 >/dev/null 2>&1 & while true; do echo tick-$(date +%s); sleep 1; done`;

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(
  host: OwnHost,
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-service-view", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${host.apiUrl}/agent-relay/${connName}`), {
      requestInit: {
        headers: { authorization: `Bearer ${host.token}`, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId },
      },
    }),
  );
  try {
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

test("入口「サービス」：一覧に状態・ポート・動いている時間、中身にログが出て増え、止める・起動・起こし直すが効き、消すは確かめてから", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await withOwnHost(async (host) => {
    const headers = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${host.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as unknown };
    };
    const installed = await call("/api/modules/catalog/service", { method: "POST", body: { name: "service" } });
    expect(installed.status, JSON.stringify(installed.body)).toBeLessThan(300);
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, "E2E サービスの画面", mkdtempSync(join(tmpdir(), "banto-e2e-service-view-")));
    const projectId = currentProjectId(page);
    const threadId = ((await call(`/api/projects/${projectId}/threads`)).body as { id: string }[])[0]!.id;
    const ctx = { projectId, threadId };
    const listed = async () =>
      (JSON.parse((await callTool(host, `service-${projectId}`, "listServices", {}, ctx)).text) as { services: { name: string; state: string }[] })
        .services;

    // Project のコンテナと Module（shell・service）が立つまで待つ
    await expect
      .poll(
        async () => {
          const modules = (await call(`/api/projects/${projectId}/modules`)).body as Array<{ name: string; connected?: boolean }>;
          return ["shell", "service"].map((n) => modules.find((m) => m.name === n)?.connected === true);
        },
        { timeout: 180_000, message: "shell・service が立ち上がらない" },
      )
      .toEqual([true, true]);

    // ---- AI がサービスを1つ登録して起こす ---------------------------------------------------------------------
    // 入れ子のコンテナでは logind に繋がらない——ユーザーの systemd を root で起こしておく（e2e の罠）
    const um = await callTool(host, `shell-${projectId}`, "runCommand", { command: "sudo -n systemctl start user@$(id -u).service" }, ctx);
    expect(um.isError, um.text).toBe(false);
    const started = await callTool(host, `service-${projectId}`, "startService", { name: "web", command: COMMAND, ports: [PORT] }, ctx);
    expect(started.isError, started.text).toBe(false);

    // ---- 1. 入口から開く（AI には頼まない）----------------------------------------------------------------------
    await page.getByRole("button", { name: "検索（Command Palette）" }).click();
    const entry = page.getByRole("option", { name: /^サービス/ });
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await expect(entry).toContainText("この Project で動かしているサービスの状態・ポート・ログを見て、起動・停止する");
    await entry.click();
    await expect(page.getByText(/^Canvas — service$/), "入口から Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
    const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
    const row = canvas.locator('[data-role="service"][data-name="web"]');
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(canvas.locator('[data-role="service"]')).toHaveCount(1);
    await expect(row.locator('[data-role="name"]')).toHaveText("web");
    await expect(row.locator('[data-role="state"]')).toHaveText("動いています");
    // 待ち受けは python が起きてから——一覧は 5 秒ごとに取り直す
    await expect(row.locator('[data-role="port"]')).toHaveText(`:${PORT}`);
    await expect(row.locator('[data-role="port"]')).toHaveAttribute("data-listening", "true", { timeout: 30_000 });
    await expect(row.locator('[data-role="uptime"]')).toHaveText(/^\d+(秒|分)$/);

    // ---- 2. 中身（狭い形：選ぶと一覧が隠れ、「一覧に戻る」で戻る）--------------------------------------------------
    await row.click();
    const detail = canvas.locator('[data-role="detail"]');
    await expect(detail, "狭い形で中身が開かない").toBeVisible();
    await expect(row, "狭い形なのに一覧が中身と並んでいる").toBeHidden();
    await expect(canvas.locator('[data-role="detail-name"]')).toHaveText("web");
    await expect(canvas.locator('[data-role="detail-command"]')).toHaveText(COMMAND);
    await expect(canvas.locator('[data-role="detail-state"]')).toHaveText("動いています");
    await expect(detail.locator('[data-role="detail-ports"]')).toHaveText(`${PORT} 待ち受けています`);
    await expect(detail.locator('[data-role="detail-uptime"]')).toHaveText(/^\d+(秒|分)$/);
    await expect(detail.locator('[data-role="detail-restarts"]')).toHaveText("0");
    await expect(detail.locator('[data-role="detail-exit"]')).toHaveText("—");
    await expect(detail.locator('[data-role="detail-cwd"]')).toHaveText(".");
    await expect(detail.locator('[data-role="detail-secrets"]')).toHaveText("なし");
    const logLines = detail.locator('[data-role="log"] .ln');
    const woke = logLines.filter({ hasText: "起きました" });
    const ticks = logLines.filter({ hasText: /tick-\d+/ });
    await expect(woke).toHaveCount(1, { timeout: 30_000 });
    // 時刻は手元の時刻（時:分:秒.ミリ秒）で頭に出る
    await expect(woke.locator(".ts")).toHaveText(/^\d\d:\d\d:\d\d\.\d{3}$/);
    // **開いたままでログが増える**（2 秒ごとに読み足す）
    const before = await ticks.count();
    await expect.poll(() => ticks.count(), { timeout: 30_000, message: "開いたままの画面でログが増えない" }).toBeGreaterThan(before + 2);
    await canvas.getByRole("button", { name: "一覧に戻る" }).click();
    await expect(row).toBeVisible();
    await row.click();

    // ---- 3. 止める・起動・起こし直す ------------------------------------------------------------------------------
    await canvas.locator('[data-role="stop"]').click();
    await expect(canvas.locator('[data-role="detail-state"]')).toHaveText("止めました", { timeout: 60_000 });
    expect((await listed()).map((s) => [s.name, s.state])).toEqual([["web", "stopped"]]);
    await expect(logLines.filter({ hasText: "（止められました）" }), "止めたのにログに出ない").toHaveCount(1, { timeout: 30_000 });
    await expect(detail.locator('[data-role="detail-uptime"]')).toHaveText("—");
    await expect(detail.locator('[data-role="detail-exit"]')).toHaveText(/^止められた（/);
    await expect(canvas.locator('[data-role="restart"]'), "止まっているのに「起こし直す」が出ている").toHaveCount(0);

    await canvas.locator('[data-role="start"]').click();
    await expect(canvas.locator('[data-role="detail-state"]')).toHaveText("動いています", { timeout: 60_000 });
    expect((await listed()).map((s) => [s.name, s.state])).toEqual([["web", "running"]]);
    await expect(woke, "起動したのにログに出ない").toHaveCount(2, { timeout: 30_000 });
    await expect(detail.locator('[data-role="detail-ports"]')).toHaveText(`${PORT} 待ち受けています`, { timeout: 30_000 });

    await canvas.locator('[data-role="restart"]').click();
    await expect(logLines.filter({ hasText: "（止められました）" }), "起こし直したのにログに止めた行が出ない").toHaveCount(2, { timeout: 60_000 });
    await expect(woke, "起こし直したのにログに起きた行が出ない").toHaveCount(3, { timeout: 30_000 });
    await expect(canvas.locator('[data-role="detail-state"]')).toHaveText("動いています");
    await expect(canvas.locator('[data-role="error"]')).toHaveCount(0);

    // ---- 4. 消す（確かめの一言つき）------------------------------------------------------------------------------
    await canvas.locator('[data-role="remove"]').click();
    await expect(canvas.locator('[data-role="remove-confirm-text"]')).toHaveText(
      "「web」を止めて登録を消します。ログも消えます。公開していれば、その公開もやめます。",
    );
    // やめれば何も起きない
    await canvas.locator('[data-role="remove-cancel"]').click();
    await expect(canvas.locator('[data-role="remove-confirm-box"]')).toHaveCount(0);
    expect((await listed()).map((s) => s.name)).toEqual(["web"]);
    await canvas.locator('[data-role="remove"]').click();
    await canvas.locator('[data-role="remove-confirm"]').click();
    await expect(canvas.locator('[data-role="empty"]'), "消したのに一覧に残っている").toContainText("まだサービスはありません", { timeout: 60_000 });
    await expect(canvas.locator('[data-role="flash"]')).toHaveText("「web」を消しました");
    expect(await listed()).toEqual([]);
  });
  expect(pageErrors).toEqual([]);
});
