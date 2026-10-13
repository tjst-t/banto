// **閉じた Project は実行場所を占めない**（Backlog `runtime-release-closed`、`docs/specs/v4-security.md` §1「閉じた Project は
// 数えない——閉じたら実行場所は空く」）。
//
// 自前の host（`own-host.ts`）に SSH で入れる相手（`ssh-host.ts`）を実行場所として登録し、そこに Project を置く。
//
// 見るもの（規則14——「断られた」「開いた」で終わらせず、向こうの systemd・登録・記録・画面の中身まで）：
//   1. 閉じると、向こうの Service の unit が止まって自動起動から外れる（登録は「動かしておきたい」のまま）。実行場所は空く
//      （一覧の使っている Project が空・選べない理由が無い）
//   2. 空いていれば今どおり再開でき、Service は登録から作り直されて動く。もう一度閉じる
//   3. 閉じている間に、同じ実行場所に別の Project を作れる
//   4. 元を再開すると理由つきで断られ（409・runtime-taken、記録は閉じたまま）、画面は「別の実行場所へ移す」を理由つきで開く。
//      先を取った実行場所は選べない。この機械のコンテナへ移し、「再開する」で再開できる——記録・根・写した中身まで見る
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { openApp, openNav } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコードを送る
test.setTimeout(2_400_000);

interface HostProject {
  id: string;
  name: string;
  root: string;
  status: "active" | "closed";
  runtime?: string;
  move?: unknown;
}
interface HostRuntime {
  name: string;
  usedBy: Array<{ id: string; name: string }>;
  unavailableReason?: string;
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
  const client = new Client({ name: "e2e-runtime-release-closed", version: "0.0.0" }, { capabilities: {} });
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

test("別のサーバの Project を閉じると Service の自動起動が切れて実行場所が空き、別の Project を作れる。元の再開は断られて移す画面が開き、移して再開できる", async ({ page }) => {
  const name = `rel-${randomBytes(3).toString("hex")}`;
  const service = `tick-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-rel-${Date.now()}`;
  // この機械のコンテナへ移す先（ホームの下・まだ無いフォルダ）
  const backRoot = join(dirname(realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-release-")))), `banto-e2e-release-back-${randomBytes(3).toString("hex")}`);
  try {
    await withSshHost(async (sshHost: SshHost) => {
      const remoteHome = `/home/${sshHost.user}`;
      const firstRoot = `${remoteHome}/work/${name}-first`;
      const secondRoot = `${remoteHome}/work/${name}-second`;
      await sshHost.ssh(`mkdir -p ${firstRoot} ${secondRoot} && echo 向こうで書いた > ${firstRoot}/hello.txt`);
      const unit = `banto-${service}.service`;
      const systemctl = (args: string) =>
        sshHost.ssh(`XDG_RUNTIME_DIR=/run/user/${sshHost.uid} systemctl --user ${args} 2>&1 || true`);
      await withOwnHost(async (own) => {
        // ---- 実行場所と Project（登録の画面は remote-runtime-registry.spec.ts で見ている） --------------------
        await uiToolCall(own, "vault-directory", "createAlias", {
          implementation: "vault-local",
          name: alias,
          kind: "ssh-identity",
          value: readFileSync(sshHost.identityFile, "utf8"),
          note: "E2E の SSH の相手",
        });
        const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
        const scanned = await api<{ hostKey: unknown }>(own, "/api/runtimes/scan", { method: "POST", body: target });
        expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
        const registered = await api(own, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
        expect(registered.status, JSON.stringify(registered.body)).toBe(201);
        expect((await api(own, "/api/modules/catalog/service", { method: "POST", body: { name: "service" } })).status).toBeLessThan(300);

        const firstName = `E2E 先に閉じる ${name}`;
        const created = await api<HostProject>(own, "/api/projects", {
          method: "POST",
          body: { name: firstName, root: firstRoot, runtime: `remote:${name}` },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const projectId = created.body.id;
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const ctx = { projectId, threadId };
        const project = async (id = projectId) => (await api<HostProject[]>(own, "/api/projects")).body.find((p) => p.id === id)!;
        const runtime = async () => (await api<HostRuntime[]>(own, "/api/runtimes")).body.find((r) => r.name === name)!;
        const listServices = async () => {
          const r = await callTool(own, `service-${projectId}`, "listServices", {}, ctx);
          expect(r.isError, r.text).toBe(false);
          return (JSON.parse(r.text) as { services: Array<{ name: string; desired: string; state: string }> }).services.map(
            (s) => `${s.name}:${s.desired}:${s.state}`,
          );
        };
        /** 向こうの Service の登録（Module の置き場の services.json） */
        const registration = async () => {
          const r = await sshHost.ssh(
            `cat ${remoteHome}/.local/share/banto-remote/*/modules/service-${projectId}/services.json`,
          );
          expect(r.code, r.stderr).toBe(0);
          return (JSON.parse(r.stdout) as { services: Record<string, { desired: string }> }).services[service]?.desired;
        };

        // 向こうで Service を動かす（初回は向こうへコードを送る）
        const started = await callTool(own, `service-${projectId}`, "startService", { name: service, command: "while true; do sleep 1; done" }, ctx);
        expect(started.isError, started.text).toBe(false);
        await expect.poll(listServices, { timeout: 60_000 }).toEqual([`${service}:running:running`]);
        expect((await systemctl(`is-enabled ${unit}`)).stdout.trim()).toBe("enabled");
        expect((await runtime()).usedBy.map((p) => p.name)).toEqual([firstName]);

        // ---- 1. 閉じる：向こうの Service が止まり、自動起動から外れる。登録はそのまま。実行場所は空く --------------
        const closeFirst = async () => {
          const closed = await api<{ ok: boolean }>(own, `/api/projects/${projectId}/close`, { method: "POST" });
          expect(closed.status, JSON.stringify(closed.body)).toBe(200);
          expect((await project()).status).toBe("closed");
          const enabled = (await systemctl(`is-enabled ${unit}`)).stdout.trim();
          expect(enabled, "閉じたのに自動起動に残っている").not.toBe("enabled");
          expect((await systemctl(`is-active ${unit}`)).stdout.trim(), "閉じたのに動いている").not.toBe("active");
          expect(await registration(), "閉じたときに登録を変えた").toBe("running");
          const rt = await runtime();
          expect(rt.usedBy, "閉じたのに実行場所が空かない").toEqual([]);
          expect(rt.unavailableReason).toBeUndefined();
        };
        await closeFirst();

        // ---- 2. 空いていれば今どおり再開でき、Service は登録から作り直されて動く ------------------------------------
        const reopened = await api(own, `/api/projects/${projectId}/reopen`, { method: "POST" });
        expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
        expect((await project()).status).toBe("active");
        await expect.poll(listServices, { timeout: 120_000 }).toEqual([`${service}:running:running`]);
        expect((await systemctl(`is-enabled ${unit}`)).stdout.trim(), "再開したのに自動起動に戻らない").toBe("enabled");
        await closeFirst();

        // ---- 3. 閉じている間に、同じ実行場所に別の Project を作れる --------------------------------------------
        const secondName = `E2E あとから来た ${name}`;
        const second = await api<HostProject>(own, "/api/projects", {
          method: "POST",
          body: { name: secondName, root: secondRoot, runtime: `remote:${name}` },
        });
        expect(second.status, JSON.stringify(second.body)).toBe(201);
        expect((await runtime()).usedBy.map((p) => p.name)).toEqual([secondName]);

        // ---- 4. 元を再開すると断られる（API） ---------------------------------------------------------------
        const takenReason =
          `実行場所「${name}」は、閉じている間に Project「${secondName}」が使い始めました（1つの実行場所に Project は1つ）。` +
          "別の実行場所へ移してから再開してください";
        const refused = await api<{ error: string; code: string }>(own, `/api/projects/${projectId}/reopen`, { method: "POST" });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual(expect.objectContaining({ code: "runtime-taken", error: takenReason }));
        expect((await project()).status, "断ったのに開いた").toBe("closed");

        // ---- 画面：履歴から再開 → 断られて「別の実行場所へ移す」が理由つきで開く ---------------------------------
        await login(page, own);
        await openApp(page, own.url);
        await page.goto(`/p/${second.body.id}?bantoHost=${own.url}`);
        await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
        await openNav(page);
        await page.getByRole("button", { name: "履歴", exact: true }).first().click();
        await page.getByTestId("archive-tab-projects").click();
        const archive = page.getByRole("dialog");
        await archive.getByText(firstName, { exact: true }).click();
        await expect(archive.getByText(firstRoot), "閉じた Project の根が出ていない").toBeVisible();
        await archive.getByRole("button", { name: "再度開く" }).click();

        const dialog = page.getByTestId("move-runtime-dialog");
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await expect(dialog).toContainText(`Project「${firstName}」のフォルダと Module の状態を写して`);
        await expect(dialog.getByTestId("move-reason")).toHaveText(`再開できませんでした${takenReason}`);
        expect((await project()).status, "断ったのに開いた").toBe("closed");

        // 移す先：いまの（先を取られた）実行場所は出ず、この機械のコンテナを選べる
        await dialog.getByTestId("move-to-select").click();
        const option = (rt: string) => page.locator(`[data-testid="move-to-option"][data-runtime="${rt}"]`);
        await expect(option("host-container")).toBeVisible({ timeout: 15_000 });
        await expect(option(`remote:${name}`), "先を取られた実行場所が移す先に出ている").toHaveCount(0);
        await option("host-container").click();
        await dialog.locator("#move-path").fill(backRoot);
        await dialog.getByTestId("move-next").click();
        const review = dialog.getByTestId("move-review");
        await expect(review).toBeVisible({ timeout: 120_000 });
        // 向こうで動いているのはあとから来た Project のもの——閉じた Project の「動いているもの」に数えない
        await expect(review.getByTestId("move-blockers")).toHaveCount(0);
        await expect(review.getByTestId("move-route")).toHaveText(`${name}${firstRoot}この機械のコンテナ${backRoot}`);
        await expect(dialog.getByTestId("move-start")).toBeEnabled();
        await dialog.getByTestId("move-start").click();
        const done = dialog.getByTestId("move-done");
        await expect(done).toBeVisible({ timeout: 900_000 });
        await expect(done.getByTestId("move-done-root")).toHaveText(backRoot);
        const moved = await project();
        expect(moved.runtime ?? "host-container").toBe("host-container");
        expect(moved.root).toBe(backRoot);
        expect(moved.status, "移しただけで開いた").toBe("closed");
        expect(readFileSync(join(backRoot, "hello.txt"), "utf8")).toBe("向こうで書いた\n");

        // 「再開する」で開き、その Project の画面へ
        await dialog.getByTestId("move-reopen").click();
        await page.waitForURL(new RegExp(`/p/${projectId}`), { timeout: 30_000 });
        await expect(dialog).toHaveCount(0);
        await expect.poll(async () => (await project()).status).toBe("active");
        // あとから来た Project はそのまま使っている。元の向こうのフォルダは残る
        expect((await runtime()).usedBy.map((p) => p.name)).toEqual([secondName]);
        expect((await project(second.body.id)).status).toBe("active");
        expect((await sshHost.ssh(`cat ${firstRoot}/hello.txt`)).stdout).toBe("向こうで書いた\n");
        // 設定「一般」の実行場所の欄も新しい場所
        await page.goto(`/settings?project=${projectId}&section=project-general&bantoHost=${own.url}`);
        await expect(page.getByTestId("project-runtime")).toHaveAttribute("data-runtime", "host-container", { timeout: 30_000 });
        await expect(page.getByTestId("project-runtime-where")).toHaveText("この機械のコンテナで動いています");
      });
    });
  } finally {
    rmSync(backRoot, { recursive: true, force: true });
  }
});
