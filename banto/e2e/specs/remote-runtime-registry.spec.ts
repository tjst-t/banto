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
//   6. その Project の Module は向こうで起こし（この機械のコンテナは作らない）、linger が無い注意を受信箱に1件出す
//   7. 実行場所の鍵は core だけが使える（Backlog #361）：登録の画面に出る鍵は実行場所の鍵の置き場のものだけで、Project から
//      使える（共通の置き場の）鍵は出ず、宛先に直に渡しても断る。その Project の AI は、Shell の sshIdentity でも Vault の
//      窓口でも実行場所の鍵を使えない
import { test, expect, type Locator, type Page } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { openApp, openNav, clickNewProject, setNewProjectAi, LEGACY_PROJECT_AI } from "../helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RUNTIME_KEYS_GROUP, withSshHost, type SshHost } from "../ssh-host.js";

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
  // 試験の相手には rsync を入れてある（前に居た場所へ戻すときに差分で写す）
  rsync: "ok",
  "user-systemd": "ok",
  // 入れ子のコンテナでは linger が断られる（試験の相手の形）。Docker は入れていない
  linger: "warn",
  "data-root": "ok",
  sshd: "ok",
  docker: "warn",
  // AVX2 の有無は覚えるだけで断らない（OpenCode の本体をどちら向けにするか、追加・2026-10-17）
  "cpu-avx2": "ok",
};

/** 一覧の1件を開く（開いていれば何もしない——押すと閉じる） */
async function openRow(row: Locator, name: string): Promise<void> {
  const header = row.getByRole("button", { name: new RegExp(name) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

/**
 * AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ。人の承認を待つ呼び出しは、その Project の
 * 判断待ちを許可しながら待つ——許可しても実行場所の鍵が使えないことを見るため（承認の画面は relay-cards.spec.ts で見ている）
 */
async function callAsAgent(
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-runtime-registry", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: { headers: { ...headers, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId } },
    }),
  );
  let done = false;
  const call = (
    client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 }) as Promise<{
      content: Array<{ text?: string }>;
      isError?: boolean;
    }>
  ).finally(() => (done = true));
  try {
    const answered = new Set<string>();
    while (!done) {
      const inbox = (await (await fetch(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{
        id: string;
        kind: string;
        liveness?: string;
        projectId?: string;
        threadId?: string;
      }>;
      for (const item of inbox) {
        if (item.kind !== "judgment" || item.liveness !== "live" || answered.has(item.id)) continue;
        if (item.projectId !== ctx.projectId && item.threadId !== ctx.threadId) continue;
        answered.add(item.id);
        const res = await fetch(`${CORE_BASE_URL}/api/inbox/${item.id}/answer`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ answer: { behavior: "allow" } }),
        });
        expect(res.status, await res.text()).toBeLessThan(300);
      }
      await Promise.race([call.catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
    }
    // Module が投げた失敗は、MCP の失敗（-32603）として返ることもある——AI から見ればどちらも「失敗した」なので、同じに扱う
    try {
      const r = await call;
      return { text: r.content.map((c) => c.text ?? "").join(""), isError: r.isError === true };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  } finally {
    await client.close();
  }
}

async function openNewProject(page: Page): Promise<Locator> {
  await openNav(page);
  await clickNewProject(page);
  const dialog = page.getByRole("dialog", { name: "新しい Project" });
  await expect(dialog.getByTestId("new-project-runtime"), "新しい Project の画面に「どこで動かすか」が無い").toBeVisible({ timeout: 15_000 });
  return dialog;
}

test("別のサーバを登録し、host 鍵を確かめて覚え、鍵が変わったら繋がない。向こうのフォルダを根に Project を1つだけ作れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const alias = `e2e-rr-${Date.now()}`;
  // 同じ鍵を Project から使える置き場（共通）にも預ける——こちらは実行場所に使えない
  const sharedAlias = `${alias}-shared`;
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
      // 既定は containers——この相手（Incus の無い SSH の相手）はサーバ丸ごとで登録する
      await form.getByTestId("runtime-mode-machine").click();
      await form.getByLabel("名前").fill(name);
      await form.getByLabel("ホスト").fill(host.address);
      await form.getByLabel("ユーザー").fill(host.user);
      // 鍵の置き場を画面が言う（どこに置けばよいか）
      await expect(form.getByText(`Vault のグループ「${RUNTIME_KEYS_GROUP}」の鍵を使います`)).toBeVisible({ timeout: 30_000 });
      await form.getByTestId("runtime-identity-select").click();
      // 選べるのは実行場所の鍵の置き場の鍵だけ（共通の置き場の鍵は、どの Project の AI も使えるので出ない）
      await expect(page.getByRole("option", { name: new RegExp(`^${alias}\\s*（`) })).toBeVisible();
      await expect(page.getByRole("option", { name: new RegExp(`^${sharedAlias}`) })).toHaveCount(0);
      await page.getByRole("option", { name: new RegExp(`^${alias}\\s*（`) }).click();
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
      await expect(row.getByTestId("runtime-identity")).toHaveText(`${alias}（Vault）`);
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

      // ---- 7a. Project から使える鍵は、宛先に直に渡しても断る（画面の一覧に出ないだけにしない） ------------------
      const identities = (await (await page.request.get(`${CORE_BASE_URL}/api/runtimes/identities`, { headers })).json()) as {
        identities: string[];
        group: string;
      };
      expect(identities.group).toBe(RUNTIME_KEYS_GROUP);
      expect(identities.identities).toContain(alias);
      expect(identities.identities).not.toContain(sharedAlias);
      // 登録したら banto が裏で繋いでコードを送っておく（#278）。その接続が数えに入らないよう、ログインの数が落ち着くまで待つ
      // ——同じ鍵を両方の置き場に預けているので、鍵では見分けられない
      let loginsBeforeShared = await acceptedLogins(host);
      for (let stable = 0; stable < 3; ) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await acceptedLogins(host);
        stable = now === loginsBeforeShared ? stable + 1 : 0;
        loginsBeforeShared = now;
      }
      const sharedCheck = await page.request.post(`${CORE_BASE_URL}/api/runtimes/check`, {
        headers,
        data: {
          runtime: { name: `${name}-x`, host: host.address, user: host.user, port: 22, identity: sharedAlias },
          hostKey: { type: host.hostKey.split(" ")[0], key: host.hostKey.split(" ")[1] },
        },
      });
      expect(sharedCheck.status()).toBe(502);
      expect(((await sharedCheck.json()) as { error: string }).error).toContain(
        `"${sharedAlias}" は Vault の実行場所の SSH 鍵の置き場（グループ "${RUNTIME_KEYS_GROUP}"）にありません`,
      );
      expect(await acceptedLogins(host), "Project から使える鍵で sshd に入った").toBe(loginsBeforeShared);

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
      // 一覧が閉じ切ってから（閉じる動きの間は、2つ目の Escape を閉じかけの一覧が受ける）
      await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
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
      // Module が名乗る始め方は出さず、core が「clone」「新しいリポジトリ」を出す（§6.49）。既定は手元のフォルダ
      await expect(dialog.getByTestId("start-method-tab")).toHaveText(["手元のフォルダ", "clone", "新しいリポジトリ"]);
      await expect(dialog.locator('[data-testid="start-method-tab"][aria-selected="true"]')).toHaveText("手元のフォルダ");
      await expect(dialog.getByText(`Root パス（${name} の上）`)).toBeVisible();
      await dialog.getByRole("button", { name: "選ぶ" }).click();
      const picker = page.getByTestId("path-picker");
      await expect(picker.getByRole("heading", { name: `${name} のフォルダを選ぶ` })).toBeVisible({ timeout: 30_000 });
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}`, { timeout: 60_000 });
      await picker.getByTestId("path-picker-entry").filter({ hasText: /^work$/ }).click();
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}/work`, { timeout: 60_000 });
      await expect(picker.getByTestId("path-picker-entry")).toHaveText(["alpha", "beta"]);
      // 向こうにも新しいフォルダをその場で作れる（追加・2026-10-20）
      await picker.getByTestId("path-picker-new-folder").click();
      await picker.getByTestId("path-picker-new-folder-name").fill("gamma");
      await picker.getByTestId("path-picker-new-folder-create").click();
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}/work/gamma`, { timeout: 60_000 });
      expect((await host.rootExec(`test -d /home/${host.user}/work/gamma && echo made`)).stdout.trim()).toBe("made");
      await picker.getByRole("button", { name: "上へ" }).click();
      await expect(picker.getByTestId("path-picker-entry")).toHaveText(["alpha", "beta", "gamma"], { timeout: 60_000 });
      await picker.getByTestId("path-picker-entry").filter({ hasText: "alpha" }).click();
      await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}/work/alpha`, { timeout: 60_000 });
      await picker.getByRole("button", { name: "ここにする" }).click();
      await expect(dialog.getByLabel(/Root パス/)).toHaveValue(`/home/${host.user}/work/alpha`);
      await dialog.getByLabel("Project 名").fill(projectName);
      await setNewProjectAi(dialog, LEGACY_PROJECT_AI);
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

      // 設定に出る（ここでは書き換えない——変えるのは「別の実行場所へ移す…」から。根は変えられない・この機械のコンテナの節は出ない）
      await page.goto(`/settings?project=${projectId}&section=project-general`);
      const runtimeBox = page.getByTestId("project-runtime");
      await expect(runtimeBox).toHaveAttribute("data-runtime", `remote:${name}`, { timeout: 30_000 });
      await expect(runtimeBox.getByTestId("project-runtime-where")).toHaveText(`${name} ${target} で動いています`);
      await expect(runtimeBox).toContainText(`下の根は ${name} の上のフォルダです。`);
      await expect(runtimeBox.getByTestId("project-runtime-move")).toBeVisible();
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
      // 一覧が閉じ切ってから（閉じる動きの間は、2つ目の Escape を閉じかけの一覧が受ける）
      await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
      const second = await page.request.post(`${CORE_BASE_URL}/api/projects`, {
        headers,
        data: { name: "二つ目", root: `/home/${host.user}/work/beta`, runtime: `remote:${name}` },
      });
      expect(second.status()).toBe(409);
      expect(((await second.json()) as { error: string }).error).toContain("使っています");

      // ---- 6. この Project の Module は向こうで起こす（この機械のコンテナは作らない） ------------------------------
      // 向こうでの動きそのもの（Shell・FileSystem・Service・中継…）は remote-runtime-ssh.spec.ts で見る。ここは「この機械の
      // コンテナに向こうのパスを根にした別物を立てない」ことと、linger が無い注意が受信箱に出ることだけ
      await expect
        .poll(
          async () => {
            // 初回はコードを送り終えるまで返らない（数十秒）——要求の既定の 30 秒で切らない
            const prepared = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/modules/prepare`, { headers, timeout: 300_000 });
            return ((await prepared.json()) as { connected?: string[] }).connected ?? [];
          },
          { timeout: 300_000, message: "向こうで Shell が繋がるまで（初回はコードを送る）" },
        )
        .toEqual(expect.arrayContaining(["shell", "filesystem"]));
      expect(spawnSync("incus", ["info", `banto-${projectId}`], { encoding: "utf8", input: "" }).status, "この Project のコンテナが作られた").not.toBe(0);
      // SSH の外（incus exec）から見る——試験の側の known_hosts は 3. で鍵を変える前のもの
      const place = await host.rootExec(`ls /home/${host.user}/.local/share/banto-remote`);
      expect(place.stdout.trim(), `向こうに banto の置き場ができていない（${place.stderr.trim()}）`).not.toBe("");
      await expect
        .poll(
          async () =>
            ((await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ title?: string; projectId?: string }>)
              .filter((n) => n.projectId === projectId)
              .map((n) => n.title),
          { timeout: 30_000 },
        )
        .toEqual([`別のサーバ「${name}」：SSH を閉じても動き続ける設定（linger）`]);

      // ---- 7b. その Project の AI は、実行場所の鍵を使えない ---------------------------------------------------------
      const threadId = ((await (await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as {
        id: string;
      }).id;
      const ctx = { projectId, threadId };
      const loginsBeforeAgent = await acceptedLogins(host);
      // Shell の sshIdentity：ssh-agent を開かせて、実行場所に SSH で入ろうとする
      const viaShell = await callAsAgent(
        `shell-${projectId}`,
        "runCommand",
        {
          command: `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${host.user}@127.0.0.1 true && echo 入れた`,
          sshIdentity: alias,
        },
        ctx,
      );
      expect(viaShell.isError, viaShell.text).toBe(true);
      // 読めていない Vault があると「見つかりませんでしたが…」になる（どちらも「この Project からは無い」）
      expect(viaShell.text).toMatch(new RegExp(`alias "${alias}" (はどの Vault にもありません|は見つかりませんでした)`));
      expect(viaShell.text).not.toContain("入れた");
      // Vault の窓口：AI が呼べる道具（getPublicKey）でも引けない。在りかを引く lookupAlias は AI に見えない（Module 用）——
      // Module からの道は上の Shell で見ている
      for (const tool of ["getPublicKey"]) {
        const viaVault = await callAsAgent("vault-directory", tool, { name: alias }, ctx);
        expect(viaVault.isError, `${tool}：${viaVault.text}`).toBe(true);
        expect(viaVault.text).toMatch(new RegExp(`alias "${alias}" (はどの Vault にもありません|は見つかりませんでした)`));
      }
      // 共通の置き場の鍵は、今までどおり Project から使える（絞りすぎていない）
      const shared = await callAsAgent("vault-directory", "getPublicKey", { name: sharedAlias }, ctx);
      expect(shared.isError, shared.text).toBe(false);
      expect(await acceptedLogins(host), "Project の AI が実行場所の鍵で sshd に入った").toBe(loginsBeforeAgent);

      expect(pageErrors, "画面で例外が出た").toEqual([]);
    },
    { vaultAlias: alias, sharedVaultAlias: sharedAlias },
  );
});
