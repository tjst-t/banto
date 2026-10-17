// **別のサーバに繋がらない Project は、サイドバーの頭文字の左上に「!」**（Backlog #383、ユーザー要望 2026-10-17）。
//
// 判定は受信箱の「<実行場所> に繋げません」（Backlog #339、`modules/remote-outage.ts`）と同じ1つ——SSH が繋がらないまま 3 分を
// 越えたら出て、繋がったら消える。自前の host（`own-host.ts`）と SSH の相手（`ssh-host.ts`）で、相手の sshd を止めて
// いまの接続も落とし（経路が途切れたのと同じ）、見るもの（規則14——出ていることだけでなく中身まで）：
//   1. 止めてすぐには出ない。3 分を越えると、その Project の行（いま開いている Project の行）の頭文字の左上に「!」が出る。
//      aria-label とツールチップは「<実行場所> に繋げません（理由）」。受信箱の同じ実行場所のお知らせも出ている（同じ判定）
//   2. 畳んだレールにも、携帯の Drawer にも出る
//   3. 押すと、その Project の設定の実行場所（全般の節）が開く
//   4. sshd を戻して繋がると消え、受信箱のお知らせも閉じる
import { test, expect, type Locator, type Page } from "../test-base.js";
import { readFileSync } from "node:fs";
import { FRONTEND_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、コードを送る。止めてから 3 分を越えるまで待つ
test.setTimeout(1_500_000);

/** host の判定（`REMOTE_OUTAGE_NOTICE_AFTER_MS`）。e2e は workspace のパッケージに依存していないので写して持つ */
const OUTAGE_AFTER_MS = 3 * 60_000;

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** sshd を止め、いまの接続も落とす（`remote-module-disconnect.spec.ts` と同じ） */
async function cutSsh(sshHost: SshHost): Promise<void> {
  // 型は先頭に留める（`^sshd`）——留めないと、この `sh -c` 自身の引数に同じ文字があって自分まで落とす
  const stopped = await sshHost.rootExec(
    `systemctl stop ssh.socket ssh.service 2>/dev/null; systemctl stop ssh.service; pkill -KILL -f '^sshd(-session)?: ${sshHost.user}' || true`,
  );
  expect(stopped.code, stopped.stderr).toBe(0);
}

async function restoreSsh(sshHost: SshHost): Promise<void> {
  const started = await sshHost.rootExec("systemctl start ssh.service");
  expect(started.code, started.stderr).toBe(0);
}

type Notice = { kind: string; dedupeKey?: string; title?: string };
async function outageNotices(host: OwnHost, name: string): Promise<Notice[]> {
  return (await api<Notice[]>(host, "/api/inbox")).body.filter((i) => i.kind === "notice" && i.dedupeKey === `remote-unreachable:${name}`);
}

/** 印が頭文字の左上にあり、頭文字と重なる（右下の裏の仕事の数とはぶつからない側） */
async function expectTopLeftOf(mark: Locator, initial: Locator, what: string): Promise<void> {
  const m = (await mark.boundingBox())!;
  const i = (await initial.boundingBox())!;
  expect(m.x, `${what}：印が頭文字の左にはみ出していない`).toBeLessThan(i.x);
  expect(m.y, `${what}：印が頭文字の上にはみ出していない`).toBeLessThan(i.y);
  expect(m.x + m.width, `${what}：印が頭文字の左上の角に掛かっていない`).toBeGreaterThan(i.x);
  expect(m.y + m.height, `${what}：印が頭文字の左上の角に掛かっていない`).toBeGreaterThan(i.y);
  expect(m.x + m.width, `${what}：印が頭文字の右半分まで来ている`).toBeLessThan(i.x + i.width / 2);
}

test("別のサーバの SSH が 3 分を越えて繋がらないと、その Project の頭文字の左上に「!」と理由が出て、繋がると消える", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const alias = `e2e-um-${Date.now()}`;
  const name = "unreachmark";
  const projectName = "E2E 繋がらない印";
  await withSshHost(async (sshHost) => {
    await withOwnHost(async (host) => {
      await sshHost.ssh("mkdir -p ~/work/proj");
      const stored = await api<{ isError?: boolean }>(host, "/api/ui-tool-call", {
        method: "POST",
        body: {
          server: "vault-directory",
          tool: "createAlias",
          arguments: { implementation: "vault-local", name: alias, kind: "ssh-identity", value: readFileSync(sshHost.identityFile, "utf8") },
        },
      });
      expect(stored.status, JSON.stringify(stored.body)).toBe(200);
      expect(stored.body.isError, JSON.stringify(stored.body)).toBeFalsy();
      const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>(host, "/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api(host, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const created = await api<{ id: string }>(host, "/api/projects", {
        method: "POST",
        body: { name: projectName, root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      const shellConnected = async () =>
        (await api<Array<{ name: string; connected: boolean }>>(host, `/api/projects/${projectId}/modules`)).body.find((m) => m.name === "shell")?.connected;
      const prepared = await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" });
      expect(prepared.body.connected ?? []).toEqual(expect.arrayContaining(["shell"]));

      await login(page, host);
      await openApp(page, host.url);
      await page.goto(`/p/${projectId}?bantoHost=${host.url}`);
      const sidebar = page.locator('[data-slot="sidebar-container"]');
      const row = sidebar.locator("li").filter({ has: page.getByTestId("sidebar-project-name").filter({ hasText: projectName }) }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      const marks = page.getByTestId("sidebar-project-unreachable");
      await expect(marks, "繋がっているのに印が出ている").toHaveCount(0);

      // ---- 1. 止めてすぐには出ない。3 分を越えたら、いま開いている Project の行に出る -----------------------------
      await cutSsh(sshHost);
      const cutAt = Date.now();
      // 試し直しで Module が繋がらないことを host が見るまで（ここから 3 分を数える）
      await expect.poll(shellConnected, { message: "sshd を止めても Module が繋がったまま", timeout: 120_000 }).toBe(false);
      await page.waitForTimeout(60_000);
      await expect(marks, "3 分になる前に印が出た").toHaveCount(0);
      expect(await outageNotices(host, name)).toEqual([]);

      const mark = row.getByTestId("sidebar-project-unreachable");
      await expect(mark, "3 分を越えても印が出ない").toBeVisible({ timeout: OUTAGE_AFTER_MS + 300_000 });
      expect(Date.now() - cutAt, "3 分になる前に印が出た").toBeGreaterThanOrEqual(OUTAGE_AFTER_MS);
      await expect(marks, "ほかの行にも印が出ている").toHaveCount(1);
      await expect(mark).toHaveText("!");
      await expect(mark).toHaveAttribute("data-runtime", name);
      const label = (await mark.getAttribute("aria-label")) ?? "";
      expect(label).toMatch(new RegExp(`^${name} に繋げません（.+）$`));
      // 理由は ssh の失敗そのもの（止めた sshd——繋げない・接続が閉じた）
      expect(label, "理由が SSH の失敗になっていない").toMatch(/ssh|SSH|接続/);
      await expect(mark).toHaveClass(/bg-turn/);
      await expectTopLeftOf(mark, row.locator("a[data-roving-item] > span").first(), "広いサイドバー");
      // ツールチップにも同じ文
      await mark.hover();
      await expect(page.getByRole("tooltip")).toHaveText(label);
      // 受信箱の同じ実行場所のお知らせ（同じ判定）
      expect((await outageNotices(host, name)).map((n) => n.title)).toEqual([`${name} に繋げません`]);
      // 読み込み直しても出ている（繋いだときの hello で渡る）
      await page.reload();
      await expect(row.getByTestId("sidebar-project-unreachable"), "読み込み直したら印が消えた").toHaveAttribute("aria-label", label, { timeout: 60_000 });

      // ---- 2. 畳んだレール・携帯の Drawer --------------------------------------------------------------------
      await page.mouse.move(600, 400);
      await sidebar.getByRole("button", { name: "サイドバーを折りたたむ" }).click();
      const railMark = sidebar.getByTestId("sidebar-project-unreachable");
      await expect(railMark, "畳んだレールに印が出ない").toHaveCount(1);
      await expect(railMark).toHaveAttribute("aria-label", label);
      const railRow = sidebar.locator("li").filter({ has: railMark });
      await expectTopLeftOf(railMark, railRow.locator("a").first().locator("span").first(), "畳んだレール");
      await sidebar.getByRole("button", { name: "サイドバーを開く（⌘B / Ctrl-B）" }).click();

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Project と Thread の一覧を開く" }).click();
      const drawerMark = page.getByRole("dialog").getByTestId("sidebar-project-unreachable");
      await expect(drawerMark, "携帯の Drawer に印が出ない").toHaveCount(1);
      await expect(drawerMark).toHaveAttribute("aria-label", label);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1280, height: 800 });

      // ---- 3. 押すと、その Project の設定の実行場所 ---------------------------------------------------------
      await row.getByTestId("sidebar-project-unreachable").click();
      await expect(page).toHaveURL(/section=project-general/);
      expect(new URL(page.url()).searchParams.get("project")).toBe(projectId);
      const runtimeBox = page.getByTestId("project-runtime");
      await expect(runtimeBox, "設定に実行場所が出ていない").toBeVisible({ timeout: 30_000 });
      await expect(runtimeBox).toHaveAttribute("data-runtime", `remote:${name}`);
      await page.keyboard.press("Escape");

      // ---- 4. 戻すと消える ----------------------------------------------------------------------------------
      await restoreSsh(sshHost);
      await expect.poll(shellConnected, { message: "sshd を戻しても Module が繋がらない", timeout: 300_000 }).toBe(true);
      await expect(marks, "繋がっても印が消えない").toHaveCount(0, { timeout: 60_000 });
      await expect.poll(async () => (await outageNotices(host, name)).length, { message: "繋がってもお知らせが閉じない", timeout: 60_000 }).toBe(0);
      // 読み込み直しても（hello で）出ない
      await page.reload();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(marks).toHaveCount(0);

      expect(pageErrors, "画面で例外が出た").toEqual([]);
      await api(host, `/api/projects/${projectId}/close`, { method: "POST" });
    });
  });
});
