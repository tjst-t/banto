// **別のサーバへのソケットの転送**（Backlog `remote-runtime-sockets`、`docs/specs/v4-security.md` §1「ソケットの転送」）。
// 相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`）。Module は向こうで動き、Vault は host で動く。
//
// 見るもの（規則14——向こうで本当にそうなったかを SSH の外（incus exec）からも見る）：
//   1. Shell の sshIdentity：向こうのコマンドに渡る SSH_AUTH_SOCK が向こうの置き場の `s` を指し、ssh-agent に預けた鍵が見え、
//      その鍵で実際に SSH で入れる。窓口は host の Vault のもの（host の側にソケットがある）。秘密鍵は向こうのどこにも無い
//   2. Vault が窓口を閉じる（値の置き換えで agent を落とす）と、向こうの窓口も消える。もう一度頼めば張り直して使える
//   3. 流れの口：向こうで動く試験用の Module（こだま）の画面を入口から開き、挨拶（刻印つき）と文字のこだまが往復する
import { test, expect, type Page } from "../test-base.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { openApp } from "../helpers.js";
import { coreSocketDir, moduleSocketDir } from "../../packages/core/dist/runtime/socket-dir.js";
import { withSshHost, type SshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコード（約 1GB）を送る
test.setTimeout(1_200_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const ECHO = "echo";
const ECHO_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/stream-echo-module/server.js");

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { ...headers, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-remote-sockets", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: { headers: { ...headers, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId } },
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

/**
 * sshIdentity つきでコマンドを流す。Shell → Vault の中継は人の承認を待つので、その Project の判断待ちを許可しながら待つ
 * （承認の画面は relay-approval.spec.ts で見ている。ここは受信箱の口で答える）
 */
async function runWithIdentity(
  ctx: { projectId: string; threadId: string },
  command: string,
  identity: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let done = false;
  const call = callTool(`shell-${ctx.projectId}`, "runCommand", { command, sshIdentity: identity }, ctx).finally(() => (done = true));
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
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text) as { stdout: string; stderr: string; exitCode: number | null };
}

async function connectedModules(projectId: string): Promise<string[]> {
  const r = await api<{ connected?: string[] }>(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
  return r.body.connected ?? [];
}

const echoFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

/** 向こうの、そのパスのファイルの種類（root で見る。無ければ「無い」） */
async function remoteKind(host: SshHost, path: string): Promise<string> {
  return (await host.rootExec(`stat -c '%U %a %F' ${JSON.stringify(path)} 2>/dev/null || echo 無い`)).stdout.trim();
}

test.afterAll(async () => {
  await fetch(`${CORE_BASE_URL}/api/modules/${ECHO}`, { method: "DELETE", headers });
});

test("別のサーバの Project で、Vault の鍵の窓口と流れの口がソケットの転送で使える——秘密鍵は向こうに出ない", async ({ page }) => {
  const alias = `e2e-rsock-${Date.now()}`;
  const name = `rk-${randomBytes(3).toString("hex")}`;
  await withSshHost(
    async (host) => {
      await host.ssh("mkdir -p ~/work/proj");
      const target = { name, host: host.address, user: host.user, port: host.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api("/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const created = await api<{ id: string }>("/api/projects", {
        method: "POST",
        body: { name: `E2E ソケットの転送 ${name}`, root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      const threadId = (await api<{ id: string }>(`/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
      const ctx = { projectId, threadId };
      await expect
        .poll(() => connectedModules(projectId), { timeout: 600_000, message: "向こうで Module が繋がるまで（初回はコードを送る）" })
        .toEqual(expect.arrayContaining(["shell"]));
      const owner = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 12);
      const base = `/home/${host.user}/.local/share/banto-remote/${owner}`;

      // ---- 1. sshIdentity：向こうのコマンドが host の Vault の ssh-agent を使い、その鍵で SSH で入れる ---------------
      const keyBody = host.publicKey.split(" ")[1]!;
      const loginCmd =
        'echo "sock=$SSH_AUTH_SOCK"; ssh-add -L; ' +
        `ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR ${host.user}@127.0.0.1 'echo 窓口で入れた'`;
      const first = await runWithIdentity(ctx, loginCmd, alias);
      expect(first.exitCode, first.stderr).toBe(0);
      const sock = /^sock=(.*)$/m.exec(first.stdout)?.[1] ?? "";
      expect(sock, "SSH_AUTH_SOCK が向こうの置き場の s を指していない").toMatch(new RegExp(`^${base}/s/a-[0-9a-f]{12}$`));
      expect(first.stdout, "ssh-agent に預けた鍵が見えない").toContain(keyBody);
      expect(first.stdout, "その鍵で SSH に入れない").toContain("窓口で入れた");
      // 向こうの窓口は向こうのユーザーだけのソケット。host の側には Vault が立てた窓口がある（鍵を持つのは host の ssh-agent）
      expect(await remoteKind(host, sock)).toBe(`${host.user} 600 socket`);
      // host の側の窓口は core の短い置き場の下の、Module ごとのフォルダ（runtime/socket-dir.ts。置き場が深い E2E では
      // /run/user/<uid>/banto-<ハッシュ> に逃げる）
      const hostSocketDir = moduleSocketDir(coreSocketDir(DATA_DIR), join(DATA_DIR, "modules", `shell-${projectId}`));
      const hostAgents = readdirAgents(hostSocketDir);
      expect(hostAgents.length, `host の側に Vault の窓口が無い（${hostSocketDir}）`).toBe(1);
      expect(createHash("sha256").update(join(hostSocketDir, hostAgents[0]!)).digest("hex").slice(0, 12)).toBe(sock.slice(-12));
      // 秘密鍵は向こうのどこにも無い（中身の1行で探す。SSH の外から root で）
      const secretLine = readFileSync(host.identityFile, "utf8").split("\n")[2]!;
      expect(secretLine.length).toBeGreaterThan(40);
      const leaked = await host.rootExec(`grep -rlF -- ${JSON.stringify(secretLine)} /home /tmp /var/tmp /run/user 2>/dev/null || true`);
      expect(leaked.stdout.trim(), "秘密鍵が向こうに出ている").toBe("");

      // 同じ窓口をもう一度頼んでも、同じ転送を使う（増やさない）
      const again = await runWithIdentity(ctx, 'echo "sock=$SSH_AUTH_SOCK"; ssh-add -L', alias);
      expect(again.stdout).toContain(`sock=${sock}`);
      expect(again.stdout).toContain(keyBody);

      // ---- 2. Vault が窓口を閉じたら、向こうの窓口も消える。頼み直せば張り直す --------------------------------------
      const replaced = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>("/api/ui-tool-call", {
        method: "POST",
        body: { server: "vault-local", tool: "replaceSecretValue", arguments: { name: alias, value: readFileSync(host.identityFile, "utf8") } },
      });
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
      expect(replaced.body.isError, JSON.stringify(replaced.body)).not.toBe(true);
      await expect.poll(() => existsSync(join(hostSocketDir, hostAgents[0]!)), { timeout: 15_000, message: "Vault が窓口を閉じない" }).toBe(false);
      await expect.poll(() => remoteKind(host, sock), { timeout: 30_000, message: "Vault が閉じたのに、向こうの窓口が残っている" }).toBe("無い");
      const third = await runWithIdentity(ctx, loginCmd, alias);
      expect(third.exitCode, third.stderr).toBe(0);
      expect(third.stdout).toContain("窓口で入れた");
      const sock3 = /^sock=(.*)$/m.exec(third.stdout)?.[1] ?? "";
      expect(sock3).toMatch(new RegExp(`^${base}/s/a-[0-9a-f]{12}$`));
      expect(await remoteKind(host, sock3)).toBe(`${host.user} 600 socket`);

      // ---- 3. 流れの口：向こうで動くこだまの Module の画面が、挨拶と文字のこだまを往復させる ---------------------------
      // 試験用の Module は送るコードに入らないので、Project のフォルダに置き、banto のコードの node_modules を辿らせる
      const codeDir = `${base}/code/${(await host.ssh(`cat ${base}/code/current`)).stdout.trim()}`;
      const echoDir = `/home/${host.user}/work/proj/.e2e-echo`;
      const echoB64 = readFileSync(ECHO_SOURCE).toString("base64");
      const placed = await host.ssh(
        `mkdir -p ${echoDir} && ln -sfn ${codeDir}/node_modules ${echoDir}/node_modules && echo ${echoB64} | base64 -d > ${echoDir}/server.mjs`,
      );
      expect(placed.code, placed.stderr).toBe(0);
      const added = await api("/api/modules", {
        method: "POST",
        body: { mcpServers: { [ECHO]: { command: "${nodeExec}", args: [`${echoDir}/server.mjs`, "${projectRoot}"] } } },
      });
      expect(added.status, JSON.stringify(added.body)).toBeLessThan(400);
      await expect.poll(() => connectedModules(projectId), { timeout: 120_000 }).toEqual(expect.arrayContaining([ECHO]));

      await openApp(page);
      // **その Project の URL へ直接行く**（2026-10-16、Backlog #310）。`/?project=` は `/` が読まない——`/` は先頭の Project へ
      // `router.replace` で飛ばす（測った：`/?project=<2つ目>` は `/p/<先頭>` に着く）。別の Project のパレットを、飛ぶ途中に開いていた
      await page.goto(`/p/${projectId}`);
      await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "検索（Command Palette）" }).click();
      const entry = page.getByRole("option", { name: /流れのこだま/ });
      await expect(entry, "試験用の Module の入口が出ない").toBeVisible({ timeout: 120_000 });
      await entry.click();
      const echo = echoFrame(page);
      await expect(echo.locator("#state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 60_000 });
      await expect(echo.getByTestId("hello")).toHaveText(/^#1 [0-9a-f]{8} echo \{"greeting":"こんにちは"\} human=true project=yes$/, { timeout: 15_000 });
      for (const text of ["向こうへ", "もう一度"]) {
        await echo.locator("#text").fill(text);
        await echo.locator("#send").click();
        await expect(echo.locator("#log li").filter({ hasText: new RegExp(`^echo:${text}$`) })).toHaveCount(1, { timeout: 15_000 });
      }
      await expect(echo.locator("#log li")).toHaveText(["echo:向こうへ", "echo:もう一度"]);
      // 向こうで動いている（向こうの Module の待ち受けに、短い symlink 越しに繋いでいる）
      expect((await host.rootExec("ps -eo args")).stdout).toContain(`${echoDir}/server.mjs`);
      expect(await remoteKind(host, `${base}/modules/${ECHO}-${projectId}/s/stream.sock`)).toMatch(new RegExp(`^${host.user} \\d+ socket$`));
      await page.keyboard.press("Escape");

      await api(`/api/projects/${projectId}/close`, { method: "POST" });
    },
    { vaultAlias: alias },
  );
});

/** host の側の、Vault が立てた窓口（`a-…`）の名前 */
function readdirAgents(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("a-"));
}
