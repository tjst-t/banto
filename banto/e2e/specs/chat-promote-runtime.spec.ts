// **チャットを Project にするとき、実行場所を選ぶ**（決定・2026-10-24、ユーザー要望。v4-frontend.md §6.53、アーキ仕様 §2.2
// 「Project にする」）。この機械のチャットを、「Project にする」の小窓から別のサーバ（machine）へ移す。写す・切り替えるのは
// 今の移す流れ（runtime-move-ui.spec.ts が設定の画面から見ている）——ここは小窓の形と、promote と移すのつながりを見る。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る値と、host の記録・向こうのファイルまで）：
//   1. 「どこで動かすか」は既定「この機械のコンテナ」で、今の欄（フォルダとリポジトリの名前・置き場へ移す／今の場所のまま）が出る
//   2. 別のサーバを選ぶと、その説明に替わり、フォルダの欄が向こうのフォルダを選ぶ形になる（今の欄は消え、リポジトリは
//      「ここでは作りません」）。根を選ぶまで押せない。「新しいフォルダ」は名前を決めるだけ（選んだだけでは作らない）
//   3. 移せない根（空でないフォルダ）を選んで押すと、理由が出て小窓は開いたまま。チャットのまま（名前も変わらない）
//   4. 選び直して押すと小窓が閉じ、Project の一覧へ移り（チャットの欄から消える）、会話の帯に移している様子→終わりに root と
//      元の場所。host の記録（kind が無い・名前・実行場所・根）と向こうのファイル、元は残る
import { test, expect, type Page } from "../test-base.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { RUNTIME_KEYS_GROUP, withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作る
test.setTimeout(1_800_000);

interface HostProject {
  id: string;
  name: string;
  root: string;
  kind?: "chat";
  runtime?: string;
  move?: unknown;
}

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

test("チャットを Project にするとき別のサーバを選ぶと、向こうの根を選んで、Project にしてから移す——移せない根なら何もしない", async ({ page }) => {
  const name = `cpr-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-cpr-${Date.now()}`;
  const projectName = `E2E 向こうで続ける ${name}`;
  await withSshHost(async (sshHost: SshHost) => {
    const remoteHome = `/home/${sshHost.user}`;
    const occupied = `${remoteHome}/occupied-${name}`;
    const newRoot = `${remoteHome}/promoted-${name}`;
    await sshHost.ssh(`mkdir -p ${occupied} && echo 先に居る > ${occupied}/f.txt`);
    await withOwnHost(
      async (own) => {
        // ---- 実行場所を1つ ---------------------------------------------------------------------------
        const vault = await api<{ isError?: boolean }>(own, "/api/ui-tool-call", {
          method: "POST",
          body: {
            server: "vault-directory",
            tool: "createAlias",
            arguments: {
              implementation: "vault-local",
              name: alias,
              kind: "ssh-identity",
              group: RUNTIME_KEYS_GROUP,
              value: readFileSync(sshHost.identityFile, "utf8"),
              note: "E2E の SSH の相手",
            },
          },
        });
        expect(vault.status, JSON.stringify(vault.body)).toBe(200);
        expect(vault.body.isError, JSON.stringify(vault.body)).not.toBe(true);
        const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
        const scanned = await api<{ hostKey: unknown }>(own, "/api/runtimes/scan", { method: "POST", body: target });
        expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
        const registered = await api(own, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
        expect(registered.status, JSON.stringify(registered.body)).toBe(201);

        // ---- チャットを1つ（会話1回・試作のファイル）。移している間を帯で見るため、写すのに少し掛かる大きさ ----------
        const created = await api<HostProject>(own, "/api/projects", { method: "POST", body: { kind: "chat" } });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const chatId = created.body.id;
        const chatRoot = created.body.root;
        writeFileSync(join(chatRoot, "plan.md"), "# 試作\n");
        writeFileSync(join(chatRoot, "big.bin"), randomBytes(1024 * 1024));
        const threadId = (await api<{ id: string }>(own, `/api/projects/${chatId}/threads`, { method: "POST" })).body.id;
        const turn = await fetch(`${own.apiUrl}/api/threads/${threadId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${own.token}`, "content-type": "application/json" },
          body: JSON.stringify({ prompt: `電力を見たい。${fakeTurn({ say: "受信機はありますか" })}` }),
        });
        const turnText = await turn.text();
        expect(turn.status, turnText).toBe(200);
        expect(turnText, "ターンが失敗した").not.toContain('"type":"error"');
        const project = async () => (await api<HostProject[]>(own, "/api/projects")).body.find((p) => p.id === chatId)!;

        await login(page, own);
        await openApp(page, own.url);
        await page.goto(`/p/${chatId}?bantoHost=${own.url}`);
        await expect(page.locator('[data-role="assistant"]').getByText("受信機はありますか")).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "Thread の操作" }).click();
        await page.getByRole("menuitem", { name: "Project にする…" }).click();
        const dialog = page.getByTestId("promote-dialog");
        await expect(dialog).toBeVisible();
        await dialog.locator("#promote-name").fill(projectName);

        // ---- 1. 既定はこの機械のコンテナ（今の欄が出る） --------------------------------------------------------
        const select = dialog.getByTestId("promote-runtime-select");
        await expect(select).toHaveText("この機械のコンテナ");
        await expect(dialog.getByTestId("promote-runtime-note")).toHaveText("今のまま、banto と同じ機械の、この Project 専用のコンテナで動かします。");
        await expect(dialog.getByTestId("promote-slug-note")).toBeVisible();
        await expect(dialog.locator('[data-testid="promote-folder-choice"][data-value="move"]')).toHaveAttribute("aria-checked", "true");
        await expect(dialog.getByTestId("promote-repo-remote")).toHaveCount(0);

        // ---- 2. 別のサーバを選ぶ：説明・フォルダの欄が替わる --------------------------------------------------
        await select.click();
        const option = page.locator(`[data-testid="promote-runtime-option"][data-runtime="${name}"]`);
        await expect(option).toBeVisible({ timeout: 15_000 });
        await expect(option).not.toHaveAttribute("aria-disabled", "true");
        await option.click();
        await expect(dialog.getByTestId("promote-runtime-note")).toHaveText(
          `Project にしてから、フォルダの中身と Module の状態を ${name} へ写して切り替えます（元はこの機械に残します）。` +
            `${name} のサーバ丸ごとがこの Project の箱になり、AI はそこで ${sshHost.user} ができることを全部できます（コンテナの閉じ込めはありません）。`,
        );
        await expect(dialog.getByTestId("promote-slug-note"), "別のサーバなのにフォルダの名前の欄が出ている").toHaveCount(0);
        await expect(dialog.getByTestId("promote-folder-choice"), "別のサーバなのに「置き場へ移す／今の場所のまま」が出ている").toHaveCount(0);
        await expect(dialog.getByTestId("module-surface"), "別のサーバなのにリポジトリの画面が出ている").toHaveCount(0);
        await expect(dialog.getByTestId("promote-repo-remote")).toHaveText(
          "リポジトリはここでは作りません（Repositories は banto の機械のフォルダしか扱えません）。移したあと、AI に頼んでください。",
        );
        await expect(dialog.getByText(`フォルダ（${name} の上。まだ無いか空のフォルダ）`)).toBeVisible();
        await expect(dialog.getByTestId("promote-remote-root-note")).toHaveText(
          `${chatRoot} の中身をここへ写します。banto の置き場・ほかの Project の根と重なるフォルダは選べません。`,
        );
        const submit = dialog.getByTestId("promote-submit");
        await expect(submit, "根を選ぶ前に押せる").toBeDisabled();

        // ---- 3. 移せない根（空でない）：理由が出て、チャットのまま ------------------------------------------------
        await dialog.locator("#promote-remote-root").fill(occupied);
        await expect(submit).toBeEnabled();
        await submit.click();
        await expect(dialog.getByTestId("promote-error")).toHaveText(
          `移す先のフォルダ ${occupied} は空ではありません（まだ無いか空のフォルダか、この Project が前に居た場所を選んでください）`,
          { timeout: 60_000 },
        );
        await expect(dialog).toBeVisible();
        const refused = await project();
        expect(refused.kind, "移せないのに Project になった").toBe("chat");
        expect(refused.name).not.toBe(projectName);
        expect(refused.runtime).toBeUndefined();
        expect(refused.move).toBeUndefined();

        // ---- 向こうのフォルダを選ぶ：「新しいフォルダ」は名前を決めるだけ（「選ぶ」は欄のパスから開くので、空にして home から）---
        await dialog.locator("#promote-remote-root").fill("");
        await expect(submit).toBeDisabled();
        await dialog.getByRole("button", { name: "選ぶ" }).click();
        const picker = page.getByTestId("path-picker");
        await expect(picker.getByRole("heading", { name: `${name} のフォルダを選ぶ` })).toBeVisible();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(remoteHome, { timeout: 60_000 });
        await picker.getByTestId("path-picker-new-folder").click();
        await expect(picker.getByTestId("path-picker-new-folder-note")).toHaveText(`${remoteHome} の中に作ります。実際に作るのは、移すのを押したときです。`);
        await picker.getByTestId("path-picker-new-folder-name").fill(`promoted-${name}`);
        await picker.getByTestId("path-picker-new-folder-create").click();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(`${newRoot}（新しく作る）`);
        await picker.getByRole("button", { name: "ここにする" }).click();
        await expect(picker).toHaveCount(0);
        await expect(dialog.locator("#promote-remote-root")).toHaveValue(newRoot);
        expect((await sshHost.ssh(`test -e ${newRoot} && echo ある || echo 無い`)).stdout.trim(), "選んだだけで作った").toBe("無い");

        // ---- 4. 押す：Project にしてから移す ------------------------------------------------------------
        await submit.click();
        await expect(dialog, "押しても小窓が閉じない").toHaveCount(0, { timeout: 60_000 });
        await expect(page).toHaveURL(new RegExp(`/p/${chatId}`));
        await expect(page.getByText(`「${projectName}」を Project にしました。${name} へ移しています`)).toBeVisible();
        // チャットの欄から Project の一覧へ
        await expect(page.locator(`[data-testid="sidebar-chat"][data-project-id="${chatId}"]`)).toHaveCount(0);
        await expect(page.getByTestId("sidebar-project-list").getByText(projectName)).toBeVisible();
        const promoted = await project();
        expect(promoted.kind).toBeUndefined();
        expect(promoted.name).toBe(projectName);
        // 会話の帯：移している→終わり
        const banner = page.getByTestId("runtime-move-banner").first();
        await expect(banner).toHaveAttribute("data-state", "moving", { timeout: 30_000 });
        await expect(banner.getByTestId("runtime-move-banner-route")).toHaveText(
          `この Project を この機械のコンテナ から 別のサーバ「${name}」 へ移しています`,
        );
        const doneBanner = page.locator('[data-testid="runtime-move-banner"][data-state="done"]').first();
        await expect(doneBanner).toBeVisible({ timeout: 900_000 });
        await expect(doneBanner).toHaveText(
          `別のサーバ「${name}」 へ移しました。root は ${newRoot} です。元は この機械のコンテナ の ${chatRoot} に残っています。要らなくなったら消してください。`,
        );
        await expect(page.getByTestId("sidebar-project-moving")).toHaveCount(0);

        // 本当にそうなったか：host の記録・向こうのファイル・元は残る
        const moved = await project();
        expect(moved.move, "移している途中のまま").toBeUndefined();
        expect(moved.kind).toBeUndefined();
        expect(moved.name).toBe(projectName);
        expect(moved.runtime).toBe(`remote:${name}`);
        expect(moved.root).toBe(newRoot);
        expect((await sshHost.ssh(`cat ${newRoot}/plan.md`)).stdout).toBe("# 試作\n");
        expect(readFileSync(join(chatRoot, "plan.md"), "utf8"), "元が消えた").toBe("# 試作\n");
        expect((await sshHost.ssh(`cat ${occupied}/f.txt`)).stdout, "断った移す先を触った").toBe("先に居る\n");
        // 同じ会話が続く（前の発言が見える）
        await expect(page.locator('[data-role="assistant"]').getByText("受信機はありますか")).toBeVisible();
      },
      // 移している間を帯で見るために、写す速さを抑える（1 MiB ほど・10秒ほど）
      { chats: true, env: { BANTO_TEST_RUNTIME_MOVE_BYTES_PER_SEC: String(96 * 1024) } },
    );
  });
});
