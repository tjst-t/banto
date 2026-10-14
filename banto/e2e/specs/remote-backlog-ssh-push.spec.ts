// **別のサーバの Project で、Backlog が Vault の SSH 鍵を借りて送る**（v4-modules.md §4.4「Vault の SSH 鍵で送る」、Backlog #296）。
// 相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`）。Backlog は向こうで動き、Vault は host で動く。
//
// 送り先（偽の git の送り先）は、相手の中の bare リポジトリを **ssh の URL で**指す（`banto-remote@127.0.0.1:…`）——入るのに
// 要るのは試験の鍵（相手の authorized_keys にある、Vault に預けたもの）で、向こうの git 自身は鍵を持たない。
// 向こうの known_hosts には相手自身の host 鍵を置く（接続先の host 鍵は向こうの known_hosts のまま、が仕様）。
//
// 見るもの（規則14——向こうの ref を SSH の外からも見る）：
//   1. 鍵を選ばない（既定）と、AI の createItem は書けるが送れず、理由に `Permission denied (publickey)` と
//      Repositories が引き受けなかったことが出る
//   2. 設定 Canvas の「送るときに使う SSH 鍵」は既定「使わない」で、選べるのは Vault の ssh-identity（試験の鍵）。選んで保存し、
//      開き直しても選んだままになっている
//   3. 鍵を選ぶと、次の書き込みで（前の分もまとめて）送れる——向こうの bare の backlog が手元と同じになり、listItems は
//      送っていない変更が無いと言う。秘密鍵は向こうのどこにも無い
import { test, expect, type Page } from "../test-base.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { openApp, openProjectSettings } from "../helpers.js";
import { withSshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコード（約 1GB）を送る
test.setTimeout(1_200_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { ...headers, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/**
 * AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ。Backlog → Repositories・Vault の中継は
 * 人の承認を待つので、その Project の判断待ちを許可しながら待つ（承認の画面は relay-cards.spec.ts で見ている）
 */
async function callAsAgent(
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean; structured?: Record<string, unknown> }> {
  const client = new Client({ name: "e2e-remote-backlog", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: { headers: { ...headers, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId } },
    }),
  );
  let done = false;
  const call = (
    client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 }) as Promise<{
      content: Array<{ text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    }>
  ).finally(() => (done = true));
  try {
    const answered = new Set<string>();
    while (!done) {
      const inbox = (await api<Array<{ id: string; kind: string; liveness?: string; projectId?: string; threadId?: string }>>("/api/inbox")).body;
      for (const item of inbox) {
        if (item.kind !== "judgment" || item.liveness !== "live" || answered.has(item.id)) continue;
        if (item.projectId !== ctx.projectId && item.threadId !== ctx.threadId) continue;
        answered.add(item.id);
        const res = await api(`/api/inbox/${item.id}/answer`, { method: "POST", body: { answer: { behavior: "allow" } } });
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      }
      await Promise.race([call.catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
    }
    const r = await call;
    return {
      text: r.content.map((c) => c.text ?? "").join(""),
      isError: r.isError === true,
      ...(r.structuredContent ? { structured: r.structuredContent } : {}),
    };
  } finally {
    await client.close();
  }
}

async function connectedModules(projectId: string): Promise<string[]> {
  const r = await api<{ connected?: string[] }>(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
  return r.body.connected ?? [];
}

async function openBacklogConfig(page: Page, projectId: string) {
  await openApp(page);
  await page.goto(`/p/${projectId}`);
  await openProjectSettings(page);
  await page.getByRole("button", { name: "Backlog", exact: true }).click();
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="backlog"]');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const config = canvas.locator("iframe").contentFrame().frameLocator("iframe");
  await expect(config.getByTestId("backlog-config-branch")).toHaveValue("backlog", { timeout: 60_000 });
  return config;
}

test.beforeAll(async () => {
  const res = await fetch(`${CORE_BASE_URL}/api/modules/catalog/backlog`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "backlog" }),
  });
  if (!res.ok && !(await res.text()).includes("その名前はもう使われています")) {
    throw new Error(`Backlog を目録から入れられませんでした: ${res.status}`);
  }
});

test.afterAll(async () => {
  await fetch(`${CORE_BASE_URL}/api/modules/backlog`, { method: "DELETE", headers });
});

test("別のサーバの Project で、設定で選んだ Vault の SSH 鍵を借りて backlog ブランチを ssh の origin へ送る", async ({ page }) => {
  const alias = `e2e-bkssh-${Date.now()}`;
  const name = `bk-${randomBytes(3).toString("hex")}`;
  await withSshHost(
    async (host) => {
      // ---- 向こう：Project の根（コードのコミット1つ）と、ssh の URL で指す bare の送り先 ------------------------------
      const home = `/home/${host.user}`;
      const prepared = await host.ssh(
        [
          "set -e",
          "mkdir -p ~/work/proj",
          "git init -q --bare ~/origin.git",
          "cd ~/work/proj",
          "git init -q -b main",
          "git -c user.name=e2e -c user.email=e2e@example.com commit -q --allow-empty -m code",
          `git remote add origin ${host.user}@127.0.0.1:${home}/origin.git`,
          // 接続先の host 鍵は向こうの known_hosts のまま（仕様）——相手自身の host 鍵を置いておく
          "ssh-keyscan -t ed25519 127.0.0.1 >> ~/.ssh/known_hosts 2>/dev/null",
          "test -s ~/.ssh/known_hosts",
        ].join(" && "),
      );
      expect(prepared.code, prepared.stderr).toBe(0);
      const ref = async (gitDir: string) => (await host.rootExec(`git --git-dir ${gitDir} rev-parse --verify -q refs/heads/backlog || echo 無い`)).stdout.trim();

      const target = { name, host: host.address, user: host.user, port: host.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api("/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const created = await api<{ id: string }>("/api/projects", {
        method: "POST",
        body: { name: `E2E Backlog の SSH ${name}`, root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      const threadId = (await api<{ id: string }>(`/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
      const ctx = { projectId, threadId };
      await expect
        .poll(() => connectedModules(projectId), { timeout: 600_000, message: "向こうで Backlog が繋がるまで（初回はコードを送る）" })
        .toEqual(expect.arrayContaining(["backlog"]));
      const conn = `backlog-${projectId}`;

      // ---- 1. 鍵を選ばない（既定）：書けるが送れない。理由は向こうの git の言ったこと --------------------------------
      const first = await callAsAgent(conn, "createItem", { kind: "task", title: "Before key" }, ctx);
      expect(first.isError, first.text).toBe(false);
      expect(first.text).toContain("書き込みは済みましたが、origin に送れませんでした");
      expect(first.text).toContain("Permission denied (publickey)");
      expect(first.text).not.toContain("SSH 鍵");
      const localAfterFirst = await ref(`${home}/work/proj/.git`);
      expect(localAfterFirst).toMatch(/^[0-9a-f]{40}$/);
      expect(await ref(`${home}/origin.git`)).toBe("無い");

      // ---- 2. 設定 Canvas：既定は「使わない」、選べるのは Vault の ssh-identity。選んで保存し、開き直しても残る ----------
      let config = await openBacklogConfig(page, projectId);
      const select = config.getByTestId("backlog-config-ssh");
      await expect(select).toHaveValue("");
      await expect(config.getByTestId("backlog-config-ssh-note")).not.toHaveText(/読んでいます|読めませんでした/, { timeout: 60_000 });
      const options = await select.locator("option").allTextContents();
      expect(options[0]).toBe("使わない");
      expect(options).toContain(alias);
      await select.selectOption(alias);
      await config.getByTestId("backlog-config-save").click();
      await expect(config.getByTestId("backlog-config-note")).toHaveText(`保存しました（backlog・SSH 鍵 ${alias}）`, { timeout: 30_000 });
      await expect(config.getByTestId("backlog-config-branch-state")).toHaveText(/^backlog ブランチに 1 件あります。$/);
      await page.reload();
      config = await openBacklogConfig(page, projectId);
      await expect(config.getByTestId("backlog-config-ssh")).toHaveValue(alias, { timeout: 30_000 });

      // ---- 3. 鍵を選ぶと、次の書き込みで前の分もまとめて送れる ------------------------------------------------------
      const second = await callAsAgent(conn, "createItem", { kind: "task", title: "After key" }, ctx);
      expect(second.isError, second.text).toBe(false);
      expect(second.text, "鍵を選んだのに送れていない").not.toContain("origin に送れませんでした");
      const local = await ref(`${home}/work/proj/.git`);
      expect(local).not.toBe(localAfterFirst);
      expect(await ref(`${home}/origin.git`), "向こうの送り先に backlog が届いていない").toBe(local);
      const onOrigin = JSON.parse((await host.rootExec(`git --git-dir ${home}/origin.git show refs/heads/backlog:tasks.json`)).stdout) as {
        items: Array<{ id: string }>;
      };
      expect(onOrigin.items.map((i) => i.id)).toEqual(["before-key", "after-key"]);
      const listed = await callAsAgent(conn, "listItems", {}, ctx);
      expect(listed.isError, listed.text).toBe(false);
      expect(listed.text).not.toContain("送っていない変更");
      expect(listed.structured?.sync).toMatchObject({ origin: true, ahead: 0 });

      // 秘密鍵は向こうのどこにも無い（中身の1行で探す。SSH の外から root で）
      const secretLine = readFileSync(host.identityFile, "utf8").split("\n")[2]!;
      expect(secretLine.length).toBeGreaterThan(40);
      const leaked = await host.rootExec(`grep -rlF -- ${JSON.stringify(secretLine)} /home /tmp /var/tmp /run/user 2>/dev/null || true`);
      expect(leaked.stdout.trim(), "秘密鍵が向こうに出ている").toBe("");

      await api(`/api/projects/${projectId}/close`, { method: "POST" });
    },
    { vaultAlias: alias },
  );
});
