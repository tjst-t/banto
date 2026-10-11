// **実行場所——別のサーバで Module を動かす**（Backlog `remote-runtime-ssh`、`docs/specs/v4-security.md` §1「向こうに置くもの」
// 「前提の確かめ」「向こうとの道」）。相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`。専用のユーザー・sudo できない・
// linger は無い）。tmux は外しておく（「特定の Module だけが使う道具が無い」相手）。
//
// 見るもの（規則14——呼べたで終わらせず、向こうで本当にそうなったかを SSH の外（incus exec）からも見る）：
//   1. 向こうで Module が動く：Shell（作業場所・ユーザー・ホーム）・FileSystem（書いたものが向こうのフォルダにある）・
//      Service（向こうのユーザーの systemd で動く）・待たない形のコマンド（向こうで終わる）
//   2. サブエージェントが Claude の中継（偽の API）を通る。中継（/relay）もトンネル越しに通る（listAgents が Vault の一覧を引ける）
//   3. tmux が無いのは断らず注意だけ（受信箱）。Terminal を開くと理由と入れ方つきで断る（画面にも出る）。linger の注意も出る
//   4. トンネルの先では /api/* に届かない・合言葉なしの /relay は断る
//   5. 向こうの ps に合言葉（中継・Claude の中継）が出ない
//   6. 向こうのコードを書き換え、SSH が黙って切れる（向こうの sshd を止めて host の接続を落とす）と：繋ぎ直したときに
//      前の Module が止まってから起き直し（二重に動かない）、コードは新しい置き場に送り直される（前の版は1つ残る）
//   7. 前提が欠けた相手（ログインシェルが出力する）では、欠けたものを名指しして断る
import { test, expect, type Page } from "../test-base.js";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { openApp } from "../helpers.js";
import { withSshHost, type SshHost } from "../ssh-host.js";

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

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId?: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-remote-runtime", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: {
        headers: {
          ...headers,
          "x-banto-project-id": ctx.projectId,
          ...(ctx.threadId ? { "x-banto-thread-id": ctx.threadId } : {}),
        },
      },
    }),
  );
  try {
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180_000 })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

async function run(projectId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const r = await callTool(`shell-${projectId}`, "runCommand", { command }, { projectId });
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text) as { stdout: string; stderr: string; exitCode: number | null };
}

async function connectedModules(projectId: string): Promise<string[]> {
  const r = await api<{ connected?: string[] }>(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
  return r.body.connected ?? [];
}

async function inboxFor(projectId: string): Promise<Array<{ title?: string; detail?: string }>> {
  return (await api<Array<{ title?: string; detail?: string; projectId?: string }>>("/api/inbox")).body.filter((n) => n.projectId === projectId);
}

/** 向こうで、そのパスを引数に持つプロセスの pid（root で見る） */
async function remotePids(host: SshHost, needle: string): Promise<number[]> {
  const r = await host.rootExec(`pgrep -u ${host.user} -f -- ${JSON.stringify(needle)} || true`);
  return r.stdout.split("\n").filter(Boolean).map(Number);
}

/** host の、その実行場所への SSH の親の接続（`-M`） */
function masterPids(name: string): number[] {
  const cm = `cm-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
  const ps = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout;
  return ps
    .split("\n")
    .filter((l) => l.includes(" -M ") && l.includes(cm))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

// Terminal・Service は banto 全体の宣言に入る（目録から入れる）——ほかの spec に残さない
test.afterAll(async () => {
  await fetch(`${CORE_BASE_URL}/api/modules/terminal`, { method: "DELETE", headers });
  await fetch(`${CORE_BASE_URL}/api/modules/service`, { method: "DELETE", headers });
});

const termFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

test("別のサーバで Module が動き、中継はトンネルだけを通り、切れても二重に動かず、コードの書き換えは送り直される", async ({ page }) => {
  const alias = `e2e-rs-${Date.now()}`;
  const name = `rs-${randomBytes(3).toString("hex")}`;
  await withSshHost(
    async (host) => {
      // 道具：tmux を外す（特定の Module だけが使う道具が無い相手）。作業場所を作る
      await host.rootExec("mv /usr/bin/tmux /usr/bin/tmux.off");
      await host.ssh("mkdir -p ~/work/proj");

      // ---- 登録（画面は remote-runtime-registry.spec.ts で見ている。ここは API で） -------------------------
      const target = { name, host: host.address, user: host.user, port: host.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      expect(`${scanned.body.hostKey.type} ${scanned.body.hostKey.key}`).toBe(host.hostKey);
      const registered = await api<{ checks: Array<{ id: string; status: string }> }>("/api/runtimes", {
        method: "POST",
        body: { runtime: target, hostKey: scanned.body.hostKey },
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      expect(registered.body.checks.find((c) => c.id === "tmux")?.status).toBe("warn");

      const created = await api<{ id: string; root: string; runtime: string }>("/api/projects", {
        method: "POST",
        body: { name: `E2E 別のサーバで動かす ${name}`, root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      const root = `/home/${host.user}/work/proj`;
      expect(created.body.root).toBe(root);
      const thread = await api<{ id: string }>(`/api/projects/${projectId}/threads`, { method: "POST" });
      const threadId = thread.body.id;
      // Terminal・Service を目録から入れる（Project ごとの Module——この Project でも向こうで起きる）
      expect((await api("/api/modules/catalog/terminal", { method: "POST", body: { name: "terminal" } })).status).toBeLessThan(300);
      expect((await api("/api/modules/catalog/service", { method: "POST", body: { name: "service" } })).status).toBeLessThan(300);

      // ---- 1. 向こうで Module が動く ------------------------------------------------------------------
      await expect
        .poll(() => connectedModules(projectId), { timeout: 600_000, message: "向こうで Module が繋がるまで（初回はコードを送る）" })
        .toEqual(expect.arrayContaining(["shell", "filesystem", "service", "subagent", "terminal"]));
      const owner = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 12);
      const base = `/home/${host.user}/.local/share/banto-remote/${owner}`;
      const firstVersion = (await host.ssh(`cat ${base}/code/current`)).stdout.trim();
      expect(firstVersion, "向こうにコードの版が無い").toMatch(/^[0-9a-f]{16}-1$/);

      const where = await run(projectId, 'pwd; id -un; echo "home=$HOME"');
      expect(where.exitCode, where.stderr).toBe(0);
      expect(where.stdout.split("\n").slice(0, 2)).toEqual([root, host.user]);
      expect(where.stdout).toContain(`home=${base}/modules/shell-${projectId}/home`);
      // Shell のホームに人の設定が届いている（E2E の写し元の .gitconfig。資格情報の取り出し役は外し、無視の設定は向こうの
      // ホームへ向け直す）
      const git = await run(projectId, "git config --global user.name; git config --global --get-regexp '^credential' || echo no-credential; cat ~/.config/git/ignore");
      expect(git.stdout.split("\n").slice(0, 3)).toEqual(["E2E Taro", "no-credential", "*.e2e-ignored"]);

      const wrote = await callTool(`filesystem-${projectId}`, "writeFile", { path: "made-by-fs.txt", content: "向こうに書いた\n" }, { projectId });
      expect(wrote.isError, wrote.text).toBe(false);
      expect((await host.ssh(`cat ${root}/made-by-fs.txt`)).stdout).toBe("向こうに書いた\n");

      const svc = await callTool(
        `service-${projectId}`,
        "startService",
        { name: "ticker", command: "while true; do date +%s > ticker.out; sleep 1; done" },
        { projectId, threadId },
      );
      expect(svc.isError, svc.text).toBe(false);
      await expect
        .poll(async () => (await host.ssh(`cat ${root}/ticker.out 2>/dev/null || true`)).stdout.trim(), { timeout: 60_000 })
        .toMatch(/^\d+$/);
      const units = await host.ssh(
        `XDG_RUNTIME_DIR=/run/user/${host.uid} systemctl --user list-units --no-legend --plain 'banto-*' | awk '{print $1, $3}'`,
      );
      expect(units.stdout, "Service が向こうのユーザーの systemd で動いていない").toMatch(/banto-ticker\.service active/);
      expect(units.stdout, "Module が向こうの systemd の単位に包まれていない").toContain(`banto-mod-shell-${projectId}.service active`);

      const bg = await callTool(
        `shell-${projectId}`,
        "runCommand",
        { command: "sleep 1; echo 待たずに流した > bg.out", runInBackground: true, label: "向こうで待たない" },
        { projectId, threadId },
      );
      expect(bg.isError, bg.text).toBe(false);
      await expect
        .poll(async () => (await host.ssh(`cat ${root}/bg.out 2>/dev/null || true`)).stdout.trim(), { timeout: 60_000 })
        .toBe("待たずに流した");

      // ---- 2. サブエージェントが Claude の中継（偽の API）を通る・/relay もトンネル越しに通る -------------------
      // 本体のログインを使うエージェント（fake-host）——既定の鍵を Vault に聞かないので、人への承認が出ない
      const sub = await callTool(`subagent-${projectId}`, "runSubagent", { agent: "fake-host", prompt: "[anthropic /v1/messages]" }, { projectId, threadId });
      expect(sub.isError, sub.text).toBe(false);
      // 返り値は JSON（エージェントの返答は text の中の文字列）——偽の API が受けた本物の資格情報まで見る
      const reply = (JSON.parse(sub.text) as { text: string }).text;
      expect(reply).toContain("anthropic: 200");
      expect(reply).toContain('"fakeUpstream":true');
      expect(reply).toContain('"auth":"Bearer e2e-not-a-token"');
      const agents = await api<{ content: Array<{ text: string }>; isError?: boolean }>(`/api/projects/${projectId}/ui-tool-call`, {
        method: "POST",
        body: { server: "subagent", tool: "listAgents", arguments: {} },
      });
      expect(agents.status, JSON.stringify(agents.body)).toBe(200);
      const listed = JSON.parse(agents.body.content[0]!.text) as { agents: Array<{ id: string; keysError?: string; hostLogin?: { loggedIn: boolean } }> };
      expect(listed.agents.filter((a) => a.keysError).map((a) => a.keysError), "中継（/relay）がトンネル越しに通らない").toEqual([]);
      expect(listed.agents.find((a) => a.hostLogin)?.hostLogin?.loggedIn, "Claude の中継の住所が入っていない").toBe(true);

      // ---- 3. tmux・linger の注意。Terminal は開くと理由と入れ方つきで断る ----------------------------------
      await expect
        .poll(async () => (await inboxFor(projectId)).map((n) => n.title).sort(), { timeout: 30_000 })
        .toEqual([`別のサーバ「${name}」：SSH を閉じても動き続ける設定（linger）`, `別のサーバ「${name}」：tmux（Terminal が使う）`].sort());
      const term = await api<{ content: Array<{ text: string }>; isError?: boolean }>(`/api/projects/${projectId}/ui-tool-call`, {
        method: "POST",
        body: { server: "terminal", tool: "listSessions", arguments: {} },
      });
      expect(term.body.isError).toBe(true);
      expect(term.body.content[0]!.text).toContain("この実行場所には tmux がありません。Terminal は tmux を使います");
      expect(term.body.content[0]!.text).toContain("sudo apt install tmux");
      // 画面でも：入口から開くと、理由が出る
      await openApp(page);
      await page.goto(`/?project=${projectId}`);
      await page.getByRole("button", { name: "検索（Command Palette）" }).click();
      const entry = page.locator('[role="option"][data-value^="launcher:terminal:"]');
      await expect(entry, "Terminal の入口が出ない").toContainText("ターミナル", { timeout: 120_000 });
      await entry.click();
      await expect(termFrame(page).locator("#error")).toContainText("この実行場所には tmux がありません", { timeout: 60_000 });
      await expect(termFrame(page).locator("#error")).toContainText("sudo apt install tmux");
      await page.keyboard.press("Escape");
      // 向こうで sudo していない（sudo の記録が無い）
      const sudoLog = await host.rootExec(`journalctl --no-pager -o cat | grep -c 'sudo.*${host.user}' || true`);
      expect(Number(sudoLog.stdout.trim()), "向こうで sudo を試みた").toBe(0);

      // ---- 4. トンネルの先では /api/* に届かない ----------------------------------------------------------
      const tunnel = await run(
        projectId,
        'b="${ANTHROPIC_BASE_URL%/claude-login}"; echo "$b"; ' +
          'curl -s -o /dev/null -w "api=%{http_code}\\n" "$b/api/projects"; ' +
          'curl -s -o /dev/null -w "healthz=%{http_code}\\n" "$b/healthz"; ' +
          'curl -s -o /dev/null -w "relay=%{http_code}\\n" -X POST -H "content-type: application/json" -d "{}" "$b/relay"',
      );
      expect(tunnel.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/m);
      expect(tunnel.stdout).toContain("api=404");
      expect(tunnel.stdout).toContain("healthz=404");
      expect(tunnel.stdout).toContain("relay=401");

      // ---- 5. 向こうの ps に合言葉が出ない ----------------------------------------------------------------
      const [shellPid] = await remotePids(host, `packages/modules/shell/dist/server.js`);
      expect(shellPid, "向こうに Shell のプロセスが無い").toBeTruthy();
      const environ = (await host.rootExec(`tr '\\0' '\\n' < /proc/${shellPid}/environ`)).stdout;
      const relayToken = /^BANTO_HOST_MCP_TOKEN=(.+)$/m.exec(environ)?.[1] ?? /^BANTO_[A-Z_]*TOKEN=(.+)$/m.exec(environ)?.[1];
      const claudeToken = /^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m.exec(environ)?.[1];
      expect(relayToken, `Shell に中継の合言葉が渡っていない：${environ.split("\n").map((l) => l.split("=")[0]).join(",")}`).toBeTruthy();
      expect(claudeToken, "Shell に Claude の中継の合言葉が渡っていない").toBeTruthy();
      const ps = (await host.rootExec("ps -eo args")).stdout;
      expect(ps).toContain("banto-launcher.mjs");
      expect(ps.includes(relayToken!), "向こうの ps に中継の合言葉が出ている").toBe(false);
      expect(ps.includes(claudeToken!), "向こうの ps に Claude の中継の合言葉が出ている").toBe(false);

      // ---- 6. コードを書き換え、SSH が黙って切れる → 前の Module を止めてから起き直し、コードは送り直される -----------
      const shellJs = `${base}/code/${firstVersion}/packages/modules/shell/dist/server.js`;
      await host.ssh(`echo '// 書き換えた' >> ${shellJs}`);
      // 向こうの sshd を止める（回線が黙って切れた形——向こうは切れたことに気づかず、前の Module は生き続ける）
      const sshdPids = (await host.rootExec(`pgrep -u ${host.user} -x sshd || pgrep -u ${host.user} sshd || true`)).stdout.split("\n").filter(Boolean);
      expect(sshdPids.length, "向こうの SSH のセッションが見つからない").toBeGreaterThan(0);
      await host.rootExec(`kill -STOP ${sshdPids.join(" ")}`);
      try {
        const masters = masterPids(name);
        expect(masters.length, "host に SSH の親の接続が無い").toBe(1);
        process.kill(masters[0]!, "SIGKILL");
        // 繋ぎ直して起き直す（前の Shell は止まっていた sshd の下で生きていた）
        await expect
          .poll(
            async () => {
              const now = await remotePids(host, "packages/modules/shell/dist/server.js");
              return now.length === 1 && now[0] !== shellPid ? "起き直した" : `いま ${now.join(",")}（前 ${shellPid}）`;
            },
            { timeout: 300_000, intervals: [1000] },
          )
          .toBe("起き直した");
        await expect.poll(() => connectedModules(projectId), { timeout: 120_000 }).toEqual(expect.arrayContaining(["shell", "filesystem"]));
        expect((await remotePids(host, "packages/modules/shell/dist/server.js")).length, "Shell が二重に動いている").toBe(1);
        const alive = await host.rootExec(`kill -0 ${shellPid} 2>/dev/null && echo alive || echo gone`);
        expect(alive.stdout.trim(), "前の Shell が止まっていない").toBe("gone");
        expect(masterPids(name).length, "親の接続が1本でない").toBe(1);
      } finally {
        await host.rootExec(`kill -CONT ${sshdPids.join(" ")} 2>/dev/null || true`);
      }
      const secondVersion = (await host.ssh(`cat ${base}/code/current`)).stdout.trim();
      expect(secondVersion, "書き換えたのに送り直されていない").toBe(firstVersion.replace(/-1$/, "-2"));
      expect((await host.ssh(`grep -c '書き換えた' ${base}/code/${secondVersion}/packages/modules/shell/dist/server.js || true`)).stdout.trim()).toBe("0");
      expect((await host.ssh(`cat ${base}/code/previous`)).stdout.trim(), "前の版が残っていない").toBe(firstVersion);
      expect((await host.ssh(`ls ${base}/code`)).stdout.split("\n").filter((l) => /^[0-9a-f]{16}-\d+$/.test(l)).sort()).toEqual(
        [firstVersion, secondVersion].sort(),
      );
      // 新しい Shell も新しい版のコードで動く
      expect((await host.rootExec("ps -eo args")).stdout).toContain(`${base}/code/${secondVersion}/packages/modules/shell/dist/server.js`);
      const again = await run(projectId, "cat made-by-fs.txt");
      expect(again.stdout).toBe("向こうに書いた\n");

      // ---- 7. 前提が欠けた相手では、欠けたものを名指しして断る ------------------------------------------------
      await host.ssh(`sed -i '1i echo こんにちは' ~/.bashrc`);
      process.kill(masterPids(name)[0]!, "SIGKILL");
      await expect
        .poll(
          async () =>
            (await inboxFor(projectId))
              .filter((n) => n.title === "shell を繋げませんでした")
              .map((n) => n.detail ?? "")
              .join("\n"),
          { timeout: 300_000, intervals: [2000] },
        )
        .toContain("ログインしたときに何も出力しない");
      const refused = (await inboxFor(projectId)).find((n) => n.title === "shell を繋げませんでした")!.detail!;
      expect(refused).toContain(`別のサーバ「${name}」で Module を起こせません——前提が足りません`);
      expect(refused).toContain("こんにちは");
      expect(refused).toContain("case $- in *i*)");
      expect(await connectedModules(projectId)).not.toEqual(expect.arrayContaining(["shell"]));
      await host.ssh(`sed -i '1d' ~/.bashrc`);

      // 片づけ：Service を消す（向こうの unit を残さない）
      await api(`/api/projects/${projectId}/close`, { method: "POST" });
    },
    { vaultAlias: alias },
  );
});
