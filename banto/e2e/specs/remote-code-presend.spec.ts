// **banto を新しい版で起こし直したら、別のサーバへ新しい版のコードを先に送っておく**（Backlog #278
// `remote-code-presend-after-update`、`docs/specs/v4-security.md` §1「向こうに置くもの」）。
//
// 2026-10-12 の実機：banto を更新して起こし直したあと、別のサーバの Project の Module が数分繋がらず、「Subagent が死んだまま」
// に見えた。版が変わったので、次に使うとき新しい版のコード（約 850MB）を送り直していた。起きたときに、使っている Project が
// ある実行場所へ裏で先に送っておく。見るもの（規則14——出ていることだけでなく中身まで）：
//   1. 起こし直したら、Project を開く前に、設定の実行場所の行に「<名前> にコードを送っています（○MB / ○MB）」が出る
//   2. 送り終えたら消え、向こうの版が新しいものに切り替わっている（まだ Project を開いていない）
//   3. そのあと Project を開くと、会話に送り込みの行は出ず、Module がすぐ繋がる（送り直さない——版はそのまま）
//
// 起こし直すので、E2E の共有の core ではなく自前の host（`own-host.ts`）を使う。**「新しい版」の作り方**：host の
// コード（作業ツリー）を書き換えると共有の core や他の spec に響くので、代わりに向こうの `current` を、いまの版とは
// 違う名前の版（中身はそのまま写したもの）に差し替える——host から見ると「向こうは前の版のまま」で、banto を更新した
// あとと同じ食い違いになる。
import { test, expect, type Page } from "../test-base.js";
import { readFileSync } from "node:fs";
import { runIncus } from "@banto/container";
import { FRONTEND_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";
import { remoteOwnerDirName } from "../../packages/core/dist/runtime/remote-ssh.js";

test.describe.configure({ mode: "serial" });
// 線を絞った相手へ、縮めたコード（約 300MB）を送る——毎秒約5MB で1分強。土台を作る初めての回はさらに長い
test.setTimeout(900_000);

/** 向こうの「前の版」の名前（いまの版の鍵とは決して一致しない） */
const OLD_VERSION = "0000000000000000-1";

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

test("新しい版で起こし直したら、Project を開く前に別のサーバへコードを送り終え、開いたときは送り直さずに Module が繋がる", async ({ page }) => {
  const alias = `e2e-ps-${Date.now()}`;
  const name = "presend";
  await withSshHost(async (sshHost) => {
    await withOwnHost(async (host) => {
      await sshHost.ssh("mkdir -p ~/work/proj");
      // SSH の鍵を、この host の Vault に預ける（`withSshHost` の `vaultAlias` は共有の core の Vault に預けるので使わない）
      const stored = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>(host, "/api/ui-tool-call", {
        method: "POST",
        body: {
          server: "vault-directory",
          tool: "createAlias",
          arguments: { implementation: "vault-local", name: alias, kind: "ssh-identity", value: readFileSync(sshHost.identityFile, "utf8") },
        },
      });
      expect(stored.status, JSON.stringify(stored.body)).toBe(200);
      expect(stored.body.isError, JSON.stringify(stored.body)).toBeFalsy();

      // ---- 前の版：登録して Project を作り、向こうにコードを置く ----------------------------------------------
      const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>(host, "/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api(host, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const created = await api<{ id: string }>(host, "/api/projects", {
        method: "POST",
        body: { name: "E2E 先に送る", root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      // Module を起こす（登録したときに先に送り始めていれば、それを待つ）
      const first = await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" });
      expect(first.body.connected ?? [], JSON.stringify(first.body)).toEqual(expect.arrayContaining(["shell", "filesystem"]));
      const code = `~/.local/share/banto-remote/${remoteOwnerDirName(host.dataDir)}/code`;
      const current = async () => (await sshHost.ssh(`cat ${code}/current`)).stdout.trim();
      const newVersion = await current();
      expect(newVersion, "向こうにコードの版が無い").toMatch(/^[0-9a-f]{16}-1$/);

      // ---- banto を止め、向こうを「前の版のまま」にして、新しい版で起こし直す -----------------------------------
      await host.stop("SIGTERM");
      // 塗り（`code/layers`）も消す——残っていれば、無い塗りだけを送る決まり（Backlog #298）で何も送らずに組み直すだけになる。
      // ここで見たいのは送っている間の表示なので、依存と node も変わった更新（すべての塗りを送る）の形にする
      const swapped = await sshHost.ssh(
        `cp -a ${code}/${newVersion} ${code}/${OLD_VERSION} && rm -rf ${code}/${newVersion} ${code}/${newVersion}.layers ${code}/layers && echo ${OLD_VERSION} > ${code}/current`,
      );
      expect(swapped.code, swapped.stderr).toBe(0);
      // 実機（banto-dev-vm）と同じくらいの線にする：相手へ流れ込む向きを 40Mbit（毎秒約5MB）——送っている間を画面で見られる長さ
      const limited = await runIncus(["config", "device", "override", sshHost.name, "eth0", "limits.ingress=40Mbit"]);
      expect(limited.code, limited.stderr).toBe(0);
      await host.start();

      // ---- 1. Project を開く前に、設定の実行場所の行に送っている進み具合が出る --------------------------------------
      await login(page, host);
      await page.goto(`/settings?section=runtimes&bantoHost=${host.url}`);
      const row = page.getByTestId("runtimes-panel").getByTestId(`runtime-${name}`);
      const line = row.getByTestId("runtime-code-transfer");
      await expect(line, "起こし直したのに、先に送り始めていない").toBeVisible({ timeout: 60_000 });
      await expect(line).toHaveAttribute("data-state", "sending");
      const text = (await line.getByTestId("code-transfer-text").textContent()) ?? "";
      const m = new RegExp(`^${name} にコードを送っています（(\\d+)MB / (\\d+)MB）$`).exec(text.trim());
      expect(m, `進み具合の文が違う：${JSON.stringify(text)}`).not.toBeNull();
      expect(Number(m![2])).toBeGreaterThan(300);
      expect(Number(m![2])).toBeLessThan(1000);

      // ---- 2. 送り終えたら消え、向こうの版が新しいものに切り替わっている（Project はまだ開いていない） ---------------------
      await expect(line, "送り終えたのに進み具合が消えない").toBeHidden({ timeout: 600_000 });
      expect(await current(), "起こし直したあと、新しい版が先に届いていない").toBe(newVersion);
      const log = host.log();
      expect(log, "版が変わったので送ったと記録されていない").toMatch(/「presend」にコードを送りました（版が変わった/);

      // ---- 3. Project を開くと、送り直さずに Module がすぐ繋がる ------------------------------------------------
      await openApp(page, host.url);
      await page.goto(`/p/${projectId}?bantoHost=${host.url}`);
      const started = performance.now();
      const prepared = await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" });
      const tookMs = performance.now() - started;
      expect(prepared.body.connected ?? [], JSON.stringify(prepared.body)).toEqual(expect.arrayContaining(["shell", "filesystem"]));
      // 線を絞ったままなので、送り直していれば 1 分は越える
      expect(tookMs, `Module が繋がるまで ${Math.round(tookMs)}ms かかった（送り直している？）`).toBeLessThan(30_000);
      await expect(page.getByTestId("thread-code-transfer"), "開いた Project の会話に送り込みの行が出た").toHaveCount(0);
      expect(await current(), "開いたときに送り直した").toBe(newVersion);
      // 送ったのは起こし直したあとの1回だけ（Project を開いたときに2回目を送っていない）
      expect(host.log().slice(log.length)).not.toMatch(/「presend」にコードを送りました/);

      await api(host, `/api/projects/${projectId}/close`, { method: "POST" });
    });
  });
});
