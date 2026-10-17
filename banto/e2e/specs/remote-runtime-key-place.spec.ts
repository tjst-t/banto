// **実行場所の SSH 鍵が置き場（banto-runtime）の外にあるとき**（Backlog #375、`docs/specs/v4-security.md` §1「向こうとの道」・
// `docs/specs/v4-frontend.md` §6.44）。
//
// 2026-10-17 の実機：#361 を反映したら、前から登録してあった banto-dev-vm・kaggle-vm の鍵が前のグループにあったため繋がらず、
// その2台の Module が全部消えた。人に見えたのは host のログだけだった。見るもの（規則14——出ていることだけでなく中身まで）：
//   1. 追加の画面：banto-runtime に鍵が無いと、作る入口が開いた状態で出る。「作る」で Vault の中に鍵ができ、公開鍵が出て、
//      そのまま選ばれる。名前の前に「$」が付かない。出た公開鍵を向こうに足すと、その鍵で登録できる（公開鍵が本物）
//   2. 登録済みの実行場所の鍵をほかのグループへ動かして banto を起こし直すと、受信箱に実行場所ごとに1枚だけ出る（題・どこに
//      あるか・影響している Project・止まっている Module・注意・「移す」）。Project を開いて Module が繋がらなくても、Module ごと・
//      「繋がらない」のお知らせは出ない
//   3. 「移す」で鍵が banto-runtime へ移り、カードが閉じ、Module を起こし直す口を呼ばなくても Module が繋がる（試し直しの間を待たない）
//   4. 鍵がどこにも無いときは「移す」を出さず、理由と入口（Vault の管理画面・実行場所の設定）だけ。鍵を置き直して確かめ直すと閉じる
//
// 起こし直すので、E2E の共有の core ではなく自前の host（`own-host.ts`）を使う。Vault も自前なので banto-runtime は空から始まる
import { test, expect, type Page } from "../test-base.js";
import { readFileSync } from "node:fs";
import { FRONTEND_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { RUNTIME_KEYS_GROUP, withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコードを送る
test.setTimeout(900_000);

/** 鍵を動かしておく「前のグループ」 */
const OLD_GROUP = "e2e-old-keys";

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Vault の窓口を人の画面の操作として呼ぶ（Vault の管理画面と同じ道）。失敗は投げる */
async function vault(host: OwnHost, tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>(host, "/api/ui-tool-call", {
    method: "POST",
    body: { server: "vault-directory", tool, arguments: args },
  });
  const text = r.body?.content?.[0]?.text ?? "";
  if (r.status !== 200 || r.body?.isError) throw new Error(`vault-directory の ${tool} が失敗しました（${r.status}）：${text || JSON.stringify(r.body)}`);
  return text;
}

/** その名前の ssh-identity がある置き場（Vault の人の管理面の一覧から） */
async function groupsOf(host: OwnHost, alias: string): Promise<string[]> {
  const body = JSON.parse(await vault(host, "listAliases", {})) as { aliases?: Array<{ name?: string; group?: string; kind?: string }> };
  return (body.aliases ?? []).filter((a) => a.name === alias && a.kind === "ssh-identity").map((a) => String(a.group));
}

/** sshd に入った回数（相手の journal から。banto の自己申告を信じない） */
async function acceptedLogins(sshHost: SshHost): Promise<number> {
  const r = await sshHost.rootExec(`journalctl -u ssh --no-pager -o cat | grep -c 'Accepted publickey for ${sshHost.user}' || true`);
  return Number(r.stdout.trim());
}

type Notice = { id: string; kind: string; dedupeKey?: string; title?: string; detail?: string; projectId?: string; runtimeKey?: { runtime: string; alias: string; from?: { implementation: string; group: string }; projectIds: string[] } };

async function openNotices(host: OwnHost): Promise<Notice[]> {
  return (await api<Notice[]>(host, "/api/inbox")).body.filter((i) => i.kind === "notice");
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

async function openInbox(page: Page) {
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  await expect(inbox).toBeVisible();
  return inbox;
}

test("実行場所の鍵：追加の画面で banto-runtime に作れる。置き場の外にあれば受信箱に1枚出て、「移す」で移り、すぐ繋がって閉じる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const alias = `e2e-kp-${Date.now()}`;
  const name = "keyplace";
  const projectName = "E2E 鍵の置き場";

  await withSshHost(async (sshHost) => {
    await withOwnHost(async (host) => {
      await sshHost.ssh("mkdir -p ~/work/proj");
      await login(page, host);

      // ---- 1. 追加の画面：鍵が無いので作る入口が開いている。作ると公開鍵が出て、選ばれる -----------------------------------
      const before = await api<{ identities: string[]; group: string }>(host, "/api/runtimes/identities");
      expect(before.body.identities, "自前の host の Vault の banto-runtime は空のはず").toEqual([]);
      await page.goto(`/settings?section=runtimes&bantoHost=${host.url}`);
      const panel = page.getByTestId("runtimes-panel");
      await panel.getByTestId("runtime-add").click();
      const form = panel.getByTestId("runtime-add-form");
      await expect(form.getByText(`Vault のグループ「${RUNTIME_KEYS_GROUP}」に SSH 鍵がありません。下で作るか`)).toBeVisible({ timeout: 30_000 });
      const creator = form.getByTestId("runtime-identity-new");
      await expect(creator, "鍵が無いのに、作る入口が開いていない").toBeVisible();
      await expect(creator).toContainText(`Vault のグループ「${RUNTIME_KEYS_GROUP}」に新しい SSH 鍵を作ります`);
      await creator.getByTestId("runtime-identity-new-name").fill(alias);
      await creator.getByTestId("runtime-identity-new-create").click();
      const done = creator.getByTestId("runtime-identity-new-done");
      await expect(done, "作れたと出ない").toBeVisible({ timeout: 60_000 });
      await expect(done).toContainText(`Vault のグループ「${RUNTIME_KEYS_GROUP}」に SSH 鍵「${alias}」を作り、選びました`);
      await expect(done).toContainText("~/.ssh/authorized_keys");
      const publicKey = ((await creator.getByTestId("runtime-identity-new-public-key").textContent()) ?? "").trim();
      expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+/);
      await expect(creator.getByTestId("runtime-identity-new-error")).toHaveCount(0);
      // 選ばれていて、名前の前に「$」が付かない
      await expect(form.getByTestId("runtime-identity-select")).toHaveText(`${alias}（Vault）`);
      // 一覧（host）にも出る・Vault の banto-runtime にある
      expect((await api<{ identities: string[] }>(host, "/api/runtimes/identities")).body.identities).toEqual([alias]);
      expect(await groupsOf(host, alias)).toEqual([RUNTIME_KEYS_GROUP]);
      // 鍵があるときは「別の鍵を作る」（開き直した登録の画面）
      await form.getByRole("button", { name: "やめる" }).click();
      await panel.getByTestId("runtime-add").click();
      await expect(panel.getByTestId("runtime-add-form").getByTestId("runtime-identity-new-open")).toHaveText("別の鍵を作る", { timeout: 30_000 });
      await expect(panel.getByTestId("runtime-add-form").getByTestId("runtime-identity-new")).toHaveCount(0);

      // 出た公開鍵を向こうに足すと、その鍵で登録できる（作った鍵が本物）
      const added = await sshHost.ssh(`printf '%s\\n' '${publicKey}' >> ~/.ssh/authorized_keys`);
      expect(added.code, added.stderr).toBe(0);
      const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>(host, "/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api(host, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, `作った鍵で登録できない：${JSON.stringify(registered.body)}`).toBe(201);
      const created = await api<{ id: string }>(host, "/api/projects", {
        method: "POST",
        body: { name: projectName, root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;

      // ---- 2. 鍵を前のグループへ動かして起こし直す → 受信箱に1枚 ---------------------------------------------------
      await vault(host, "migrateAlias", { name: alias, implementation: "vault-local", group: RUNTIME_KEYS_GROUP, toGroup: OLD_GROUP });
      expect(await groupsOf(host, alias)).toEqual([OLD_GROUP]);
      await host.stop("SIGTERM");
      await host.start();
      await expect
        .poll(async () => (await openNotices(host)).filter((n) => n.runtimeKey?.runtime === name).length, {
          message: "起こし直しても、実行場所の鍵のカードが出ない",
          timeout: 120_000,
        })
        .toBe(1);
      const card = (await openNotices(host)).find((n) => n.runtimeKey?.runtime === name)!;
      expect(card.title).toBe(`別のサーバ ${name} に繋げません：SSH 鍵が置き場の外にあります`);
      expect(card.runtimeKey).toEqual({ runtime: name, alias, from: { implementation: "vault-local", group: OLD_GROUP }, projectIds: [projectId] });
      expect(card.detail).toContain(`SSH 鍵「${alias}」は Vault vault-local の「${OLD_GROUP}」にあり`);
      expect(card.detail).toMatch(new RegExp(`影響している Project：「${projectName}」・止まっている Module \\d+ 個`));

      // Project を開く（Module を起こしに行く）——繋がらないが、Module ごと・「繋がらない」のお知らせは出ない
      await openApp(page, host.url);
      await page.goto(`/p/${projectId}?bantoHost=${host.url}`);
      const prepared = await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" });
      expect(prepared.body.connected ?? [], "鍵が置き場の外にあるのに Module が繋がった").not.toContain("shell");
      const modules = await api<Array<{ name: string; connected: boolean; error?: string }>>(host, `/api/projects/${projectId}/modules`);
      const shell = modules.body.find((m) => m.name === "shell");
      expect(shell?.connected).toBe(false);
      expect(shell?.error ?? "", "Module の理由に置き場の話が出ていない").toContain(`"${RUNTIME_KEYS_GROUP}"`);
      const notices = await openNotices(host);
      expect(notices.filter((n) => n.runtimeKey?.runtime === name), "カードが実行場所ごとに1枚になっていない").toHaveLength(1);
      expect(notices.filter((n) => n.dedupeKey?.startsWith("module-connect:")), "Module ごとのお知らせが重なって出た").toEqual([]);
      expect(notices.filter((n) => n.dedupeKey === `remote-unreachable:${name}`), "「繋がらない」お知らせが重なって出た").toEqual([]);

      // 画面：受信箱のカードの中身
      const inbox = await openInbox(page);
      const cardEl = inbox.getByTestId("inbox-notice").filter({ has: page.getByTestId("inbox-runtime-key") });
      await expect(cardEl).toHaveCount(1, { timeout: 30_000 });
      await expect(cardEl.getByTestId("inbox-notice-title")).toHaveText(card.title!);
      await expect(cardEl).toContainText(`vault-local の「${OLD_GROUP}」`);
      await expect(cardEl).toContainText(`「${projectName}」`);
      await expect(cardEl.getByTestId("inbox-runtime-key-caution")).toContainText("移すと、この鍵は Project の AI から使えなくなります");
      await expect(cardEl.getByTestId("inbox-runtime-key-caution")).toContainText("Backlog の push の鍵");
      const move = cardEl.getByTestId("inbox-runtime-key-move");
      await expect(move).toHaveText(`「${alias}」を実行場所の鍵の置き場へ移す`);
      await expect(cardEl.getByTestId("inbox-runtime-key-settings")).toHaveAttribute("href", "/settings?section=runtimes");

      // ---- 3. 「移す」→ 移り、閉じ、すぐ繋がる --------------------------------------------------------------------
      const loginsBefore = await acceptedLogins(sshHost);
      const moveResponse = page.waitForResponse((r) => r.url().endsWith(`/api/runtimes/${name}/move-key`) && r.request().method() === "POST", {
        timeout: 120_000,
      });
      await move.click();
      const moved = await moveResponse;
      const movedBody = (await moved.json()) as { moved?: boolean; reconnectError?: string; error?: string };
      expect(moved.status(), JSON.stringify(movedBody)).toBe(200);
      expect(movedBody, "移したが繋ぎ直せなかった").toEqual(expect.objectContaining({ moved: true }));
      expect(movedBody.reconnectError).toBeUndefined();
      // 成功したときだけ起きること：カードが消え、鍵が banto-runtime にある
      await expect(cardEl, "「移す」を押してもカードが閉じない").toHaveCount(0, { timeout: 120_000 });
      expect(await groupsOf(host, alias)).toEqual([RUNTIME_KEYS_GROUP]);
      expect((await openNotices(host)).filter((n) => n.runtimeKey), "閉じたカードがまた出ている").toEqual([]);
      expect(await acceptedLogins(sshHost), "移したあと、その鍵で繋ぎ直していない").toBeGreaterThan(loginsBefore);
      // Module を起こす口を呼ばなくても、繋げなかった Module を起こし直している（試し直しの間を待たない）
      await expect
        .poll(async () => (await api<Array<{ name: string; connected: boolean }>>(host, `/api/projects/${projectId}/modules`)).body.find((m) => m.name === "shell")?.connected, {
          message: "移したあと、繋げなかった Module を起こし直していない",
          timeout: 600_000,
        })
        .toBe(true);
      expect(host.log()).toMatch(/\[host\] 別のサーバ「keyplace」の SSH 鍵「e2e-kp-\d+」が実行場所の鍵の置き場にありません/);

      // ---- 4. 鍵がどこにも無い：「移す」を出さず、理由と入口だけ。置き直して確かめ直すと閉じる ---------------------------
      await vault(host, "deleteAlias", { implementation: "vault-local", name: alias, group: RUNTIME_KEYS_GROUP });
      expect(await groupsOf(host, alias)).toEqual([]);
      const refused = await api<{ error?: string }>(host, `/api/runtimes/${name}/recheck`, { method: "POST" });
      expect(refused.status, JSON.stringify(refused.body)).toBe(502);
      expect(refused.body.error).toContain(`"${alias}" は Vault の実行場所の SSH 鍵の置き場（グループ "${RUNTIME_KEYS_GROUP}"）にありません`);
      await expect
        .poll(async () => (await openNotices(host)).filter((n) => n.runtimeKey?.runtime === name).map((n) => n.title), { timeout: 60_000 })
        .toEqual([`別のサーバ ${name} に繋げません：SSH 鍵が見つかりません`]);
      const missing = (await openNotices(host)).find((n) => n.runtimeKey?.runtime === name)!;
      expect(missing.runtimeKey?.from).toBeUndefined();
      expect(missing.detail).toContain(`SSH 鍵「${alias}」はどの Vault にもありません`);
      // 受信箱は開いたまま（変わったら取り直す——host から画面への出来事）
      const missingEl = inbox.getByTestId("inbox-notice").filter({ has: page.getByTestId("inbox-runtime-key") });
      await expect(missingEl).toHaveCount(1, { timeout: 30_000 });
      await expect(missingEl.getByTestId("inbox-notice-title")).toHaveText(`別のサーバ ${name} に繋げません：SSH 鍵が見つかりません`);
      await expect(missingEl.getByTestId("inbox-runtime-key-move"), "鍵がどこにも無いのに「移す」が出た").toHaveCount(0);
      await expect(missingEl.getByTestId("inbox-runtime-key-caution")).toHaveCount(0);
      await expect(missingEl.getByTestId("inbox-runtime-key-vault")).toHaveAttribute(
        "href",
        `/p/${projectId}?${new URLSearchParams({ canvas: "vault-directory:ui://banto-vault-directory/manage" }).toString()}`,
      );
      await expect(missingEl.getByTestId("inbox-runtime-key-settings")).toHaveAttribute("href", "/settings?section=runtimes");
      // 人が Vault に鍵を置き直して確かめ直すと、カードは自動で閉じる
      await vault(host, "createAlias", {
        implementation: "vault-local",
        name: alias,
        kind: "ssh-identity",
        group: RUNTIME_KEYS_GROUP,
        value: readFileSync(sshHost.identityFile, "utf8"),
      });
      const rechecked = await api(host, `/api/runtimes/${name}/recheck`, { method: "POST" });
      expect(rechecked.status, JSON.stringify(rechecked.body)).toBe(200);
      await expect
        .poll(async () => (await openNotices(host)).filter((n) => n.runtimeKey).length, { message: "鍵を置き直しても閉じない", timeout: 60_000 })
        .toBe(0);
      await expect(missingEl).toHaveCount(0, { timeout: 30_000 });

      expect(pageErrors, "画面で例外が出た").toEqual([]);
      await api(host, `/api/projects/${projectId}/close`, { method: "POST" });
    });
  });
});
