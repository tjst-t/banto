// **実行場所——別のサーバの登録と、Project を作るときに選ぶ画面**（Backlog `remote-runtime-registry`、
// `docs/specs/v4-security.md` §1「登録と選び方」）。相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`）。
//
// 見るもの（規則14——押せたで終わらせず、画面が出している値と、本当にそうなったかまで）：
//   1. 設定の「実行場所」：この機械のコンテナ（既定）と注意書きが、登録の前に読める
//   2. 登録の順：宛先・Vault の SSH 鍵 → 繋いで確かめる → host 鍵の指紋（SSH の外で読んだ正しい値と同じ）→ 覚える →
//      前提（linger と Docker が注意、ほかは ✓）→ 登録。known_hosts は banto の置き場にあり、人の ~/.ssh は触らない
//   3. host 鍵が変わったら繋がない：確かめ直すと、覚えていた鍵といま返ってきた鍵を並べて出し、sshd に入った記録が
//      増えない。新しい Project の画面でも理由つきで選べない。「新しい鍵を覚え直す」で戻る
//   4. 新しい Project の画面で実行場所を選び、向こうのフォルダの一覧（SSH）から根を選んで作れる。Project の記録に
//      実行場所が残り、設定に読むだけで出る。設定の一覧に「使っています」が出て、外せない
//   5. 同じ実行場所に2つ目の Project は作れない（画面で選べない・host も断る）
//   6. その Project の Module は起こさず、理由を受信箱に出す（別のサーバでの起動はまだ無い）
import { test, expect, type Locator, type Page } from "../test-base.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { openApp, openNav } from "../helpers.js";
import { withSshHost, type SshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台（sshd 入りのイメージ）を作る
test.setTimeout(900_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

/** `ssh-keygen -l` と同じ指紋（公開鍵の本体の SHA-256 を base64、末尾の = を落とす） */
function fingerprint(hostKeyLine: string): string {
  const key = hostKeyLine.trim().split(/\s+/)[1]!;
  return `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** sshd に入れた回数（相手の journal から。banto の自己申告を信じない） */
async function acceptedLogins(host: SshHost): Promise<number> {
  const r = await host.rootExec(`journalctl -u ssh --no-pager -o cat | grep -c 'Accepted publickey for ${host.user}' || true`);
  return Number(r.stdout.trim());
}

/** 前提の一覧の、項目ごとの結果 */
async function checkStatuses(list: Locator): Promise<Record<string, string>> {
  const items = list.getByTestId("runtime-check");
  const out: Record<string, string> = {};
  for (let i = 0; i < (await items.count()); i++) {
    const item = items.nth(i);
    out[(await item.getAttribute("data-check"))!] = (await item.getAttribute("data-status"))!;
  }
  return out;
}

const EXPECTED_CHECKS = {
  platform: "ok",
  "silent-login": "ok",
  tools: "ok",
  tmux: "ok",
  "user-systemd": "ok",
  // 入れ子のコンテナでは linger が断られる（試験の相手の形）。Docker は入れていない
  linger: "warn",
  "data-root": "ok",
  sshd: "ok",
  docker: "warn",
};

/** 一覧の1件を開く（開いていれば何もしない——押すと閉じる） */
async function openRow(row: Locator, name: string): Promise<void> {
  const header = row.getByRole("button", { name: new RegExp(name) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

async function openNewProject(page: Page): Promise<Locator> {
  await openNav(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新しい Project" });
  await expect(dialog.getByTestId("new-project-runtime"), "新しい Project の画面に「どこで動かすか」が無い").toBeVisible({ timeout: 15_000 });
  return dialog;
}

test("別のサーバを登録し、host 鍵を確かめて覚え、鍵が変わったら繋がない。向こうのフォルダを根に Project を1つだけ作れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const alias = `e2e-rr-${Date.now()}`;
  const name = `lab-${randomBytes(3).toString("hex")}`;
  const userKnownHosts = join(homedir(), ".ssh", "known_hosts");
  const userKnownHostsBefore = existsSync(userKnownHosts) ? readFileSync(userKnownHosts, "utf8") : null;

  await withSshHost(
    async (host) => {
      await host.ssh("mkdir -p ~/work/alpha ~/work/beta");
      const target = `${host.user}@${host.address}`;
      const firstFp = fingerprint(host.hostKey);

      // ---- 1. 設定の「実行場所」 -------------------------------------------------------------------
      await openApp(page);
      await page.goto("/settings?section=runtimes");
      const panel = page.getByTestId("runtimes-panel");
      await expect(panel.getByTestId("runtime-host-container")).toContainText("この機械のコンテナ", { timeout: 30_000 });
      const cautions = panel.getByTestId("runtime-cautions");
      await expect(cautions).toContainText("サーバ丸ごとが、その Project の箱になります");
      await expect(cautions).toContainText("LAN から直に届きます");
      await expect(cautions).toContainText("その人にも banto への中継の口が見えます");
      await expect(cautions).toContainText("1つのサーバで動かせる Project は1つです");
      await expect(panel.getByTestId(`runtime-${name}`)).toHaveCount(0);

      // ---- 2. 登録の順 ---------------------------------------------------------------------------
      await panel.getByTestId("runtime-add").click();
      const form = panel.getByTestId("runtime-add-form");
      await form.getByLabel("名前").fill(name);
      await form.getByLabel("ホスト").fill(host.address);
      await form.getByLabel("ユーザー").fill(host.user);
      await form.getByTestId("runtime-identity-select").click();
      await page.getByRole("option", { name: new RegExp(`\\$${alias}`) }).click();
      await expect(form.getByTestId("runtime-identity-select")).toContainText(alias);
      await form.getByTestId("runtime-connect").click();
      // 指紋：SSH の外（incus exec）で読んだ正しい鍵と同じもの
      await expect(form.getByTestId("runtime-fingerprint")).toHaveText(`ED25519 ${firstFp}`, { timeout: 60_000 });
      await expect(form.getByTestId("runtime-host-key-step")).toContainText("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
      await form.getByTestId("runtime-trust").click();
      const addChecks = form.getByTestId("runtime-add-checks");
      await expect(addChecks).toBeVisible({ timeout: 90_000 });
      expect(await checkStatuses(addChecks)).toEqual(EXPECTED_CHECKS);
      await expect(addChecks.locator('[data-check="linger"]')).toContainText(`sudo loginctl enable-linger ${host.user}`);
      await expect(addChecks.locator('[data-check="user-systemd"]')).toContainText(`/run/user/${host.uid}/bus`);
      await expect(form.getByTestId("runtime-add-blocked")).toHaveCount(0);
      await form.getByTestId("runtime-register").click();

      const row = panel.getByTestId(`runtime-${name}`);
      await expect(row.getByTestId("runtime-state")).toHaveText("使えます（注意 2 件）", { timeout: 90_000 });
      await expect(row.getByTestId("runtime-target")).toHaveText(target);
      await expect(panel.getByTestId("runtime-add-form")).toHaveCount(0);
      // 開くと中身：鍵の alias・覚えた指紋・前提
      await openRow(row, name);
      await expect(row.getByTestId("runtime-identity")).toHaveText(`$${alias}（Vault）`);
      await expect(row.getByTestId("runtime-host-key")).toContainText(`ED25519 ${firstFp}`);
      expect(await checkStatuses(row.getByTestId("runtime-checks"))).toEqual(EXPECTED_CHECKS);
      // known_hosts は banto の置き場。人の ~/.ssh は触らない
      const knownHosts = readFileSync(join(DATA_DIR, "remote-runtimes", name, "known_hosts"), "utf8");
      expect(knownHosts.trim()).toBe(`banto-runtime ${host.hostKey}`);
      expect(existsSync(userKnownHosts) ? readFileSync(userKnownHosts, "utf8") : null, "人の ~/.ssh/known_hosts が変わった").toBe(userKnownHostsBefore);
      // host の記録も同じ（画面の自己申告だけを見ない）
      const listed = (await (await page.request.get(`${CORE_BASE_URL}/api/runtimes`, { headers })).json()) as {
        runtimes: Array<{ name: string; runtime: string; hostKey: { fingerprint: string }; unavailableReason?: string }>;
      };
      const mine = listed.runtimes.find((r) => r.name === name)!;
      expect(mine.runtime).toBe(`remote:${name}`);
      expect(mine.hostKey.fingerprint).toBe(firstFp);
      expect(mine.unavailableReason).toBeUndefined();

      // ---- 3. host 鍵が変わったら繋がない --------------------------------------------------------
      await host.rootExec("rm -f /etc/ssh/ssh_host_* && ssh-keygen -A && systemctl restart ssh");
      const newKey = (await host.rootExec("cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub")).stdout.trim();
      const newFp = fingerprint(newKey);
      expect(newFp).not.toBe(firstFp);
      const loginsBefore = await acceptedLogins(host);
      await row.getByTestId("runtime-recheck").click();
      const mismatch = row.getByTestId("host-key-mismatch");
      await expect(mismatch).toBeVisible({ timeout: 60_000 });
      await expect(mismatch.getByTestId("host-key-old")).toHaveText(firstFp);
      await expect(mismatch.getByTestId("host-key-new")).toHaveText(newFp);
      await expect(row.getByTestId("runtime-state")).toHaveText("host 鍵が前と違うので繋ぎません");
      await expect(row.getByTestId("runtime-error")).toContainText("host 鍵が前と違うので繋ぎませんでした");
      await expect(row.getByTestId("runtime-recheck")).toBeDisabled();
      expect(await acceptedLogins(host), "鍵が違うのに sshd に入った").toBe(loginsBefore);
      // 向こうのフォルダも引かない（繋ぐ前に断る）
      const dirs = await page.request.get(`${CORE_BASE_URL}/api/runtimes/${name}/directories`, { headers });
      expect(dirs.status()).toBe(409);
      expect(await acceptedLogins(host)).toBe(loginsBefore);

      // 新しい Project の画面でも、理由つきで選べない
      let dialog = await openNewProject(page);
      await dialog.getByTestId("new-project-runtime-select").click();
      let option = page.locator(`[data-testid="new-project-runtime-option"][data-runtime="${name}"]`);
      await expect(option).toHaveAttribute("aria-disabled", "true");
      await expect(option.getByTestId("new-project-runtime-reason")).toHaveText("host 鍵が前と違うので繋ぎません");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "新しい Project" })).toHaveCount(0);

      // 覚え直す——新しい鍵で繋いで確かめ直す
      await page.goto("/settings?section=runtimes");
      const row2 = page.getByTestId(`runtime-${name}`);
      await expect(row2.getByTestId("host-key-mismatch")).toBeVisible({ timeout: 30_000 });
      await row2.getByTestId("host-key-accept").click();
      await expect(row2.getByTestId("runtime-state")).toHaveText("使えます（注意 2 件）", { timeout: 60_000 });
      await expect(row2.getByTestId("host-key-mismatch")).toHaveCount(0);
      await openRow(row2, name);
      await expect(row2.getByTestId("runtime-host-key")).toContainText(`ED25519 ${newFp}`);
      expect(await acceptedLogins(host), "覚え直したのに繋いでいない").toBeGreaterThan(loginsBefore);

      // ---- 4. 新しい Project の画面で選び、向こうのフォルダを根に作る ---------------------------------
      const projectName = `E2E 別のサーバ ${name}`;
      dialog = await openNewProject(page);
      await expect(dialog.getByTestId("new-project-runtime-note")).toContainText("この Project 専用のコンテナで動かします");
      await dialog.getByTestId("new-project-runtime-select").click();
      option = page.locator(`[data-testid="new-project-runtime-option"][data-runtime="${name}"]`);
      await expect(option).not.toHaveAttribute("aria-disabled", "true");
      await option.click();
      await expect(dialog.getByTestId("new-project-runtime-note")).toHaveText(
        `${name} のサーバ丸ごとが、この Project の箱になります。AI はそこで ${host.user} ができることを全部できます。作ったあとで変えられません。`,
      );
      // Module が名乗る始め方（clone 等）は出さない
      await expect(dialog.getByTestId("start-method")).toHaveCount(0);
      await expect(dialog.getByText(`Root パス（${name} の上）`)).toBeVisible();
      await dialog.getByRole("button", { name: "選ぶ" }).click();
      const picker = page.getByTestId("path-picker");
      await expect(picker.getByRole("heading", { name: `${name} のフォルダを選ぶ` })).toBeVisible({ timeout: 30_000 });
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}`, { timeout: 60_000 });
      await picker.getByTestId("path-picker-entry").filter({ hasText: /^work$/ }).click();
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}/work`, { timeout: 60_000 });
      await expect(picker.getByTestId("path-picker-entry")).toHaveText(["alpha", "beta"]);
      await picker.getByTestId("path-picker-entry").filter({ hasText: "alpha" }).click();
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}/work/alpha`, { timeout: 60_000 });
      await picker.getByRole("button", { name: "ここにする" }).click();
      await expect(dialog.getByLabel(/Root パス/)).toHaveValue(`/home/${host.user}/work/alpha`);
      await dialog.getByLabel("Project 名").fill(projectName);
      await dialog.getByTestId("new-project-submit").click();
      await expect(page).toHaveURL(/\/p\/[^/?]+/, { timeout: 60_000 });
      const projectId = new URL(page.url()).pathname.split("/")[2]!;

      // host の記録：実行場所と、向こうで正規化した根
      const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{
        id: string;
        name: string;
        root: string;
        runtime?: string;
      }>;
      const created = projects.find((p) => p.id === projectId)!;
      expect(created.name).toBe(projectName);
      expect(created.runtime).toBe(`remote:${name}`);
      expect(created.root).toBe(`/home/${host.user}/work/alpha`);

      // 設定に読むだけで出る（根は変えられない・この機械のコンテナの節は出ない）
      await page.goto(`/settings?project=${projectId}&section=project-general`);
      const runtimeBox = page.getByTestId("project-runtime");
      await expect(runtimeBox).toHaveAttribute("data-runtime", `remote:${name}`, { timeout: 30_000 });
      await expect(runtimeBox.getByTestId("project-runtime-where")).toHaveText(`${name} ${target} で動いています`);
      await expect(runtimeBox).toContainText("実行場所はあとから変えられません");
      await expect(page.getByTestId("project-root-readonly")).toHaveText(`/home/${host.user}/work/alpha`);
      await expect(page.getByTestId("project-container-section")).toHaveCount(0);

      // 設定の一覧：使っている Project が出て、外せない
      await page.goto("/settings?section=runtimes");
      const row3 = page.getByTestId(`runtime-${name}`);
      await expect(row3.getByTestId("runtime-state")).toHaveText(`Project「${projectName}」が使っています`, { timeout: 30_000 });
      await openRow(row3, name);
      await expect(row3.getByTestId("runtime-remove-blocked")).toContainText(`Project「${projectName}」が使っているあいだは外せません`);
      await expect(row3.getByTestId("runtime-remove")).toHaveCount(0);
      expect((await page.request.delete(`${CORE_BASE_URL}/api/runtimes/${name}`, { headers })).status()).toBe(409);

      // ---- 5. 同じ実行場所に2つ目は作れない ----------------------------------------------------------
      dialog = await openNewProject(page);
      await dialog.getByTestId("new-project-runtime-select").click();
      option = page.locator(`[data-testid="new-project-runtime-option"][data-runtime="${name}"]`);
      await expect(option).toHaveAttribute("aria-disabled", "true");
      await expect(option.getByTestId("new-project-runtime-reason")).toHaveText(
        `Project「${projectName}」が使っています（1つの実行場所に Project は1つ）`,
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const second = await page.request.post(`${CORE_BASE_URL}/api/projects`, {
        headers,
        data: { name: "二つ目", root: `/home/${host.user}/work/beta`, runtime: `remote:${name}` },
      });
      expect(second.status()).toBe(409);
      expect(((await second.json()) as { error: string }).error).toContain("使っています");

      // ---- 6. Module は起こさず、理由を受信箱に出す -----------------------------------------------------
      const prepared = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/modules/prepare`, { headers });
      expect(((await prepared.json()) as { connected: string[] }).connected).toEqual([]);
      await expect
        .poll(
          async () =>
            ((await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ title?: string; projectId?: string }>)
              .filter((n) => n.projectId === projectId)
              .map((n) => n.title),
          { timeout: 30_000 },
        )
        .toEqual([`${projectName} の Module はまだ起こせません`]);

      expect(pageErrors, "画面で例外が出た").toEqual([]);
    },
    { vaultAlias: alias },
  );
});
