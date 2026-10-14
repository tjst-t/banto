// **Project を別の実行場所へ移す——画面**（Backlog `runtime-move-ui`、`docs/specs/v4-security.md` §1「Project を別の実行場所へ
// 移す」の流れ 1・3・8）。本体（写す・切り替え・途中で落ちたときの片づけ）は runtime-move.spec.ts が API で見ている。ここは
// Project の設定「一般」の「別の実行場所へ移す…」から、人が画面で移せることを見る。
//
// 見るもの（規則14——押せたで終わらせず、画面が出している値と、本当にそうなったかまで）：
//   1. 移す先：いまの実行場所は出ない。ほかの Project が使っている別のサーバは理由つきで選べない
//   2. 移す先のフォルダ：向こうのフォルダを選べ、「新しいフォルダ」で名前を決めてその中へ入れる。/ や .. の名前・同じ名前は断る。
//      選んだだけでは作らない
//   3. 押す前の画面：経路・写す大きさ・会話の記録の件数・移らないもの・閉じ込めの注意。動いている Service があれば並べて押せない
//   4. 止めれば押せ、押したら小窓は閉じる（画面を止めない。Backlog #293）。設定の欄に段と写した量／全体が出て、移している
//      間もほかの Project の会話へ移って発言できる。移している Project の会話の面には帯。終わると帯と設定の欄に新しい root と
//      元の場所が出る。host の記録・向こうのファイル・設定の実行場所の欄と根が新しい場所になる。もう一度開くと、移す先に
//      「この機械のコンテナ」が出る
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作る
test.setTimeout(1_800_000);

interface HostProject {
  id: string;
  root: string;
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

async function uiToolCall(host: OwnHost, server: string, tool: string, args: Record<string, unknown>): Promise<void> {
  const r = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>(host, "/api/ui-tool-call", {
    method: "POST",
    body: { server, tool, arguments: args },
  });
  expect(r.status, `${server} の ${tool}：${JSON.stringify(r.body).slice(0, 500)}`).toBe(200);
  expect(r.body.isError, `${server} の ${tool}：${r.body?.content?.[0]?.text ?? ""}`).not.toBe(true);
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(
  host: OwnHost,
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-runtime-move-ui", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${host.apiUrl}/agent-relay/${connName}`), {
      requestInit: {
        headers: { authorization: `Bearer ${host.token}`, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId },
      },
    }),
  );
  try {
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** 「（1.2 MB / 8.0 MB）」から写した量と全体を読む（単位をそろえて比べる） */
function parseSize(text: string): { copied: number; total: number } | undefined {
  const m = text.match(/^（([\d.]+) (B|KB|MB|GB) \/ ([\d.]+) (B|KB|MB|GB)）$/);
  if (!m) return undefined;
  const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
  return { copied: Number(m[1]) * unit[m[2] as keyof typeof unit], total: Number(m[3]) * unit[m[4] as keyof typeof unit] };
}

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

test("Project の設定「一般」から別の実行場所へ移せる——選べない移す先は理由つき、新しいフォルダを選べ、動いているものがあれば押せず、終わりに root と元の場所が出る", async ({ page }) => {
  const name = `mvu-${randomBytes(3).toString("hex")}`;
  const other = `mvo-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-mvu-${Date.now()}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-ui-")));
  writeFileSync(join(root, "hello.txt"), "画面から移す\n");
  // 写している間を画面で見る・その間にほかの Project で話すために、写すのに時間が掛かる大きさ（縮まない中身）。速さは下で抑える
  writeFileSync(join(root, "big.bin"), randomBytes(4 * 1024 * 1024));
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "最初"]);
  try {
    await withSshHost(async (sshHost: SshHost) => {
      const remoteHome = `/home/${sshHost.user}`;
      const newRoot = `${remoteHome}/work/moved-ui`;
      await sshHost.ssh("mkdir -p ~/work/occupied");
      await withOwnHost(async (own) => {
        const claudeDir = join(dirname(own.dataDir), "claude");
        // ---- 実行場所を2つ（同じ相手に別の名前で）。片方はほかの Project が使う ---------------------------------
        await uiToolCall(own, "vault-directory", "createAlias", {
          implementation: "vault-local",
          name: alias,
          kind: "ssh-identity",
          value: readFileSync(sshHost.identityFile, "utf8"),
          note: "E2E の SSH の相手",
        });
        for (const n of [name, other]) {
          const target = { name: n, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
          const scanned = await api<{ hostKey: unknown }>(own, "/api/runtimes/scan", { method: "POST", body: target });
          expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
          const registered = await api(own, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
          expect(registered.status, JSON.stringify(registered.body)).toBe(201);
        }
        expect((await api(own, "/api/modules/catalog/service", { method: "POST", body: { name: "service" } })).status).toBeLessThan(300);
        const occupantName = `E2E 先に使っている ${other}`;
        const occupant = await api<HostProject>(own, "/api/projects", {
          method: "POST",
          body: { name: occupantName, root: "~/work/occupied", runtime: `remote:${other}` },
        });
        expect(occupant.status, JSON.stringify(occupant.body)).toBe(201);
        const projectName = `E2E 画面から移す ${name}`;
        const created = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: projectName, root } });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const projectId = created.body.id;
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        // 移している間に話す、もう1つの Project
        const chatRoot = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-ui-chat-")));
        const chat = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: `E2E 移す間に話す ${name}`, root: chatRoot } });
        expect(chat.status, JSON.stringify(chat.body)).toBe(201);
        expect((await api(own, `/api/projects/${chat.body.id}/threads`, { method: "POST" })).status).toBeLessThan(300);
        const ctx = { projectId, threadId };
        const project = async () => (await api<HostProject[]>(own, "/api/projects")).body.find((p) => p.id === projectId)!;

        await login(page, own);

        // 会話を1つ（見積もりの「会話の記録の件数」に出る）。偽の Runner は記録を書かないので、置き場に置く
        await sendTurn(own, threadId, `はじめまして。${fakeTurn({ say: "はじめまして。" })}`);
        const session = (await api<{ resumePoint?: string }>(own, `/api/threads/${threadId}`)).body.resumePoint!;
        expect(session, "会話の id ができていない").toBeTruthy();
        mkdirSync(join(claudeDir, "projects", encode(root)), { recursive: true });
        writeFileSync(join(claudeDir, "projects", encode(root), `${session}.jsonl`), '{"note":"会話の記録"}\n');

        // 動いている Service（入れ子のコンテナでは logind に繋がらない——ユーザーの systemd を root で起こす。e2e の罠）
        const um = await callTool(own, `shell-${projectId}`, "runCommand", { command: "sudo -n systemctl start user@$(id -u).service" }, ctx);
        expect(um.isError, um.text).toBe(false);
        const ticker = await callTool(own, `service-${projectId}`, "startService", { name: "ticker", command: "while true; do sleep 1; done" }, ctx);
        expect(ticker.isError, ticker.text).toBe(false);

        // ---- 設定「一般」の実行場所の欄 --------------------------------------------------------------------
        await openApp(page, own.url);
        await page.goto(`/settings?project=${projectId}&section=project-general&bantoHost=${own.url}`);
        const runtimeBox = page.getByTestId("project-runtime");
        await expect(runtimeBox).toHaveAttribute("data-runtime", "host-container", { timeout: 30_000 });
        await expect(runtimeBox.getByTestId("project-runtime-where")).toHaveText("この機械のコンテナで動いています");
        await runtimeBox.getByTestId("project-runtime-move").click();
        const dialog = page.getByTestId("move-runtime-dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(`Project「${projectName}」のフォルダと Module の状態を写して`);

        // ---- 1. 移す先 ----------------------------------------------------------------------------------
        await dialog.getByTestId("move-to-select").click();
        const option = (runtime: string) => page.locator(`[data-testid="move-to-option"][data-runtime="${runtime}"]`);
        await expect(option(`remote:${name}`)).toBeVisible({ timeout: 15_000 });
        await expect(option("host-container"), "いまの実行場所が移す先に出ている").toHaveCount(0);
        await expect(option(`remote:${other}`)).toHaveAttribute("aria-disabled", "true");
        await expect(option(`remote:${other}`).getByTestId("move-to-reason")).toHaveText(
          `Project「${occupantName}」が使っています（1つの実行場所に Project は1つ）`,
        );
        await expect(option(`remote:${name}`)).not.toHaveAttribute("aria-disabled", "true");
        await option(`remote:${name}`).click();

        // ---- 2. 移す先のフォルダ（向こうのフォルダ・新しいフォルダ） ------------------------------------------
        await expect(dialog.getByText(`移す先のフォルダ（${name} の上。まだ無いか空のフォルダ）`)).toBeVisible();
        await dialog.getByRole("button", { name: "選ぶ" }).click();
        const picker = page.getByTestId("path-picker");
        await expect(picker.getByRole("heading", { name: `${name} のフォルダを選ぶ` })).toBeVisible();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(remoteHome, { timeout: 60_000 });
        await picker.getByTestId("path-picker-entry").filter({ hasText: /^work$/ }).click();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(`${remoteHome}/work`, { timeout: 60_000 });
        await expect(picker.getByTestId("path-picker-entry").filter({ hasText: /^occupied$/ })).toBeVisible();

        await picker.getByTestId("path-picker-new-folder").click();
        const folderName = picker.getByTestId("path-picker-new-folder-name");
        const note = picker.getByTestId("path-picker-new-folder-note");
        const create = picker.getByTestId("path-picker-new-folder-create");
        await expect(note).toHaveText(`${remoteHome}/work の中に作ります。実際に作るのは、移すのを押したときです。`);
        await folderName.fill("a/b");
        await expect(note).toHaveText("名前に / や .. は使えません");
        await expect(create).toBeDisabled();
        await folderName.fill("..");
        await expect(note).toHaveText("名前に / や .. は使えません");
        await folderName.fill("occupied");
        await expect(note).toHaveText("同じ名前のフォルダがあります");
        await expect(create).toBeDisabled();
        await folderName.fill("moved-ui");
        await create.click();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(`${newRoot}（新しく作る）`);
        await expect(picker).toContainText("この中にフォルダはありません");
        // 上へ戻ると、作る予定のフォルダが一覧に並ぶ。入り直せる
        await picker.getByRole("button", { name: "上へ" }).click();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(`${remoteHome}/work`, { timeout: 60_000 });
        const pendingEntry = picker.getByTestId("path-picker-entry").filter({ hasText: "moved-ui" });
        await expect(pendingEntry).toContainText("新しく作る");
        await pendingEntry.click();
        await expect(picker.getByTestId("path-picker-current")).toHaveText(`${newRoot}（新しく作る）`);
        await picker.getByRole("button", { name: "ここにする" }).click();
        await expect(picker).toHaveCount(0);
        await expect(dialog.locator("#move-path")).toHaveValue(newRoot);
        expect((await sshHost.ssh(`test -e ${newRoot} && echo ある || echo 無い`)).stdout.trim(), "選んだだけで作った").toBe("無い");

        // ---- 3. 押す前の画面：動いている Service があれば押せない ----------------------------------------------
        await dialog.getByTestId("move-next").click();
        const review = dialog.getByTestId("move-review");
        await expect(review).toBeVisible({ timeout: 120_000 });
        await expect(review.getByTestId("move-route")).toHaveText(`この機械のコンテナ${root}${name}${newRoot}`);
        await expect(review.getByTestId("move-blocker")).toHaveText(["動いているものがあります（止めてから移してください）"]);
        await expect(review.getByTestId("move-running-item")).toHaveText(["Service「ticker」が動いています"]);
        await expect(dialog.getByTestId("move-start")).toBeDisabled();
        await expect(dialog.getByTestId("move-start")).toHaveText(`${name} へ移す`);
        await expect(review.getByTestId("move-size")).toHaveText(/^Project のフォルダと Module の状態：[\d.]+ (B|KB|MB|GB)（[\d,]+ ファイル）——\.git ごと、未コミットの変更も$/);
        await expect(review.getByTestId("move-records")).toHaveText("会話の記録 1 件——続きから話せます");
        await expect(review.getByTestId("move-not-moved")).toContainText("Docker のイメージ");
        await expect(review.getByTestId("move-not-moved")).toContainText("Service は止めた状態で移ります");
        await expect(review.getByTestId("move-confinement")).toContainText(`${name} では閉じ込めがありません`);
        await expect(review.getByTestId("move-confinement")).toContainText("コンテナの閉じ込めはありません");
        await expect(review.getByTestId("move-confinement")).toContainText(`${sshHost.user} ができることを全部できます`);
        await expect(review).toContainText(`元のフォルダと Module の状態は残します（この機械のコンテナ の ${root}）`);

        // 止めて、開き直す（開き直すと初めから）
        const stopped = await callTool(own, `service-${projectId}`, "stopService", { name: "ticker" }, ctx);
        expect(stopped.isError, stopped.text).toBe(false);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await runtimeBox.getByTestId("project-runtime-move").click();
        await expect(dialog.getByTestId("move-next")).toBeDisabled();
        await dialog.getByTestId("move-to-select").click();
        await option(`remote:${name}`).click();
        await dialog.locator("#move-path").fill(newRoot);
        await dialog.getByTestId("move-next").click();
        await expect(review).toBeVisible({ timeout: 120_000 });
        await expect(review.getByTestId("move-blockers")).toHaveCount(0);
        await expect(dialog.getByTestId("move-start")).toBeEnabled();

        // ---- 4. 移す：押したら小窓は閉じる。進み具合は設定の欄と帯、その間もほかの Project で話せる → 終わり -------------
        await dialog.getByTestId("move-start").click();
        await expect(dialog, "押しても小窓が閉じない").toHaveCount(0);
        const movingBox = page.getByTestId("project-runtime-moving");
        await expect(movingBox).toBeVisible();
        await expect(movingBox).toContainText(`この機械のコンテナ から 別のサーバ「${name}」（${newRoot}）へ移しています`);
        await expect(runtimeBox.getByTestId("project-runtime-move"), "移している間に「移す」を押せる").toBeDisabled();
        // 段と、写した量／全体（進む）
        await expect(movingBox.getByTestId("project-runtime-moving-phase")).toContainText("写しています…", { timeout: 120_000 });
        const sizeOf = async () => parseSize(await movingBox.getByTestId("project-runtime-moving-size").innerText());
        let firstSize: { copied: number; total: number } | undefined;
        await expect
          .poll(async () => {
            firstSize = await sizeOf();
            return firstSize ? firstSize.copied > 0 && firstSize.total >= 4 * 1024 * 1024 : "まだ出ていない";
          }, { timeout: 120_000 })
          .toBe(true);
        await expect.poll(async () => ((await sizeOf())?.copied ?? 0) > firstSize!.copied, { timeout: 60_000, message: "写した量が進まない" }).toBe(true);

        // 画面は止まっていない：サイドバーから、移している Project の会話へ（設定が閉じる）→ 帯と印
        const projectLink = (id: string) => page.locator(`[data-slot="sidebar"] a[href^="/p/${id}"]`).first();
        await projectLink(projectId).click();
        await expect(page).toHaveURL(new RegExp(`/p/${projectId}`));
        const banner = page.getByTestId("runtime-move-banner").first();
        await expect(banner).toHaveAttribute("data-state", "moving");
        await expect(banner.getByTestId("runtime-move-banner-route")).toHaveText(
          `この Project を この機械のコンテナ から 別のサーバ「${name}」 へ移しています`,
        );
        await expect(banner.getByTestId("runtime-move-banner-phase")).toHaveText(/^——(写しています|写したものを確かめています|切り替えています)$/);
        await expect(page.getByTestId("sidebar-project-moving")).toHaveCount(1);

        // ほかの Project の会話へ移って発言できる（移している最中に）
        await projectLink(chat.body.id).click();
        await expect(page).toHaveURL(new RegExp(`/p/${chat.body.id}`));
        const composer = page.getByPlaceholder(/に送る/);
        await expect(composer).toBeEditable({ timeout: 30_000 });
        await composer.fill(`移している間に話す。${fakeTurn({ say: "移している間も話せます。" })}`);
        await composer.press("Enter");
        await expect(page.locator('[data-role="assistant"]').last()).toContainText("移している間も話せます。", { timeout: 60_000 });
        expect((await project()).move, "発言し終える前に移し終えた（移している最中に話せたかを見られていない）").toBeTruthy();

        // 移している Project の会話へ戻り、終わりを待つ：帯に新しい root と元の場所
        await projectLink(projectId).click();
        const doneBanner = page.locator('[data-testid="runtime-move-banner"][data-state="done"]').first();
        await expect(doneBanner).toBeVisible({ timeout: 900_000 });
        await expect(doneBanner).toHaveText(
          `別のサーバ「${name}」 へ移しました。root は ${newRoot} です。元は この機械のコンテナ の ${root} に残っています。要らなくなったら消してください。`,
        );
        await expect(doneBanner.getByTestId("runtime-move-banner-root")).toHaveText(newRoot);
        await expect(doneBanner.getByTestId("runtime-move-banner-previous")).toHaveText(root);
        await expect(page.getByTestId("sidebar-project-moving")).toHaveCount(0);
        await expect(page.getByPlaceholder(/に送る/).first()).toBeEditable();

        // 設定「一般」の実行場所の欄にも同じ結果（読み込み直さずに開く）
        await page.locator('[data-slot="sidebar"]').getByRole("link", { name: "設定", exact: true }).click();
        await page.getByRole("button", { name: "一般", exact: true }).click();
        const movedBox = page.getByTestId("project-runtime-moved");
        await expect(movedBox).toBeVisible();
        await expect(movedBox.getByTestId("project-runtime-moved-root")).toHaveText(newRoot);
        await expect(movedBox.getByTestId("project-runtime-moved-previous")).toHaveText(root);
        await expect(page.getByTestId("project-runtime-moving")).toHaveCount(0);
        await expect(runtimeBox.getByTestId("project-runtime-move")).toBeEnabled();

        // 本当にそうなったか：host の記録・向こうのファイル・元は残る
        const moved = await project();
        expect(moved.move, "移している途中のまま").toBeUndefined();
        expect(moved.runtime).toBe(`remote:${name}`);
        expect(moved.root).toBe(newRoot);
        expect((await sshHost.ssh(`cat ${newRoot}/hello.txt`)).stdout).toBe("画面から移す\n");
        expect((await sshHost.ssh(`git -C ${newRoot} log --format=%s`)).stdout.trim()).toBe("最初");
        expect(readFileSync(join(root, "hello.txt"), "utf8"), "元が消えた").toBe("画面から移す\n");

        // 設定の欄が新しい場所になる（読み直さずに）
        await expect(runtimeBox).toHaveAttribute("data-runtime", `remote:${name}`);
        await expect(runtimeBox.getByTestId("project-runtime-where")).toContainText(`${name} ${sshHost.user}@${sshHost.address}`);
        await expect(page.getByTestId("project-root-readonly")).toHaveText(newRoot);
        await expect(page.getByTestId("project-container-section")).toHaveCount(0);
        // 読み直しても同じ
        await page.reload();
        await expect(runtimeBox).toHaveAttribute("data-runtime", `remote:${name}`, { timeout: 30_000 });
        await expect(page.getByTestId("project-root-readonly")).toHaveText(newRoot);

        // もう一度開くと、移す先に「この機械のコンテナ」が出て、いまの実行場所は出ない
        await runtimeBox.getByTestId("project-runtime-move").click();
        await dialog.getByTestId("move-to-select").click();
        await expect(option("host-container")).toBeVisible();
        await expect(option(`remote:${name}`)).toHaveCount(0);
        await page.keyboard.press("Escape");
        // 一覧が閉じ切ってから（閉じる動きの間は、2つ目の Escape を閉じかけの一覧が受ける）
        await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        rmSync(chatRoot, { recursive: true, force: true });
      },
      // 写している間を画面で見るために、写す速さを抑える（.git の中の写しと合わせて 8 MiB ほど・1分ほど）
      { env: { BANTO_TEST_RUNTIME_MOVE_BYTES_PER_SEC: String(128 * 1024) } });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
