// **別のサーバへ初めて繋ぐときのコードの送り込みが見える**（Backlog #269 `remote-code-transfer-visible`、
// `docs/specs/v4-security.md` §1「向こうに置くもの」）。
//
// 2026-10-12 の実機：最初のターンが、banto のコード（約 850MB）を VM へ送り終わるまで約4分、tool を1つも呼べずに
// 止まって見えた（毎秒約5MB）。相手の線を同じくらいに絞り（incus の `limits.ingress`）、次を見る（規則14——出ている
// ことだけでなく、出ている中身まで）：
//   1. 実行場所を登録したら、Project を作る前から送り始める（先に送っておく）——設定の実行場所の行に進み具合
//   2. 送っている間、サイドバーのその Project の行と、その Project の会話に「<名前> にコードを送っています（○MB / ○MB）」。
//      数字は進む（送った量が増え、分母は変わらない）
//   3. 途中で接続が切れたら、会話とサイドバーの同じ行が「送れませんでした（○MB / ○MB で止まりました）」と理由に変わり、
//      次に Module を起こそうとしたときに送り直す（修正・2026-10-12、レビュー——前は止めた瞬間に core が落ちるか、
//      最初のターンが永久に待った）
//   4. 送り終えたら3箇所とも消え、向こうにコードの版が1つでき、Module が起きる
import { test, expect, type Locator } from "../test-base.js";
import { createHash, randomBytes } from "node:crypto";
import { runIncus } from "@banto/container";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { openApp } from "../helpers.js";
import { withSshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 線を絞った相手へ、縮めたコード（約 300MB）を送る——毎秒約5MB で1分強。土台を作る初めての回はさらに長い
test.setTimeout(900_000);

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

/** 「<名前> にコードを送っています（120MB / 809MB）」を読む。形が違えば落とす */
async function progressOf(line: Locator, runtime: string): Promise<{ sent: number; total: number }> {
  const text = (await line.getByTestId("code-transfer-text").textContent()) ?? "";
  const m = new RegExp(`^${runtime} にコードを送っています（(\\d+)MB / (\\d+)MB）$`).exec(text.trim());
  expect(m, `進み具合の文が違う：${JSON.stringify(text)}`).not.toBeNull();
  return { sent: Number(m![1]), total: Number(m![2]) };
}

test("初めて繋ぐ別のサーバへコードを送っている間、設定・サイドバー・会話に進み具合が出て、送り終えたら消える", async ({ page }) => {
  const alias = `e2e-ct-${Date.now()}`;
  const name = `ct-${randomBytes(3).toString("hex")}`;
  await withSshHost(
    async (host) => {
      await host.ssh("mkdir -p ~/work/proj");
      // 実機（banto-dev-vm）と同じくらいの線にする：相手へ流れ込む向きを 40Mbit（毎秒約5MB）
      const limited = await runIncus(["config", "device", "override", host.name, "eth0", "limits.ingress=40Mbit"]);
      expect(limited.code, limited.stderr).toBe(0);

      await openApp(page);
      await page.goto("/settings?section=runtimes");
      const panel = page.getByTestId("runtimes-panel");
      await expect(panel.getByTestId("runtime-host-container")).toBeVisible({ timeout: 30_000 });

      // ---- 1. 登録したら、Project を作る前から送り始める ---------------------------------------------
      const target = { name, host: host.address, user: host.user, port: host.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api("/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      // 登録は画面の外（API）でしたので、一覧を読み直す
      await page.reload();
      const row = panel.getByTestId(`runtime-${name}`);
      const runtimeLine = row.getByTestId("runtime-code-transfer");
      await expect(runtimeLine, "登録したのに、先に送り始めていない").toBeVisible({ timeout: 60_000 });
      const first = await progressOf(runtimeLine, name);
      // 分母は縮める前の大きさ（Module に要るものだけ。node を含む）——数百 MB で、1GB は越えない
      expect(first.total).toBeGreaterThan(300);
      expect(first.total).toBeLessThan(1000);
      expect(first.sent).toBeLessThanOrEqual(first.total);

      // ---- 2. 送っている間、その Project のサイドバーと会話に出る ----------------------------------------
      const created = await api<{ id: string; baseThreadId?: string }>("/api/projects", {
        method: "POST",
        body: { name: `E2E コードを送る ${name}`, root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      await api(`/api/projects/${projectId}/threads`, { method: "POST" });
      await page.goto(`/p/${projectId}`);
      const sidebarRow = page.getByTestId("sidebar-code-transfer").and(page.locator(`[data-runtime="${name}"]`));
      const threadLine = page.getByTestId("thread-code-transfer");
      await expect(sidebarRow, "サイドバーの Project の行に進み具合が出ない").toBeVisible({ timeout: 30_000 });
      await expect(threadLine, "会話に進み具合が出ない").toBeVisible({ timeout: 30_000 });
      const inSidebar = await progressOf(sidebarRow, name);
      const inThread = await progressOf(threadLine, name);
      expect(inSidebar.total).toBe(first.total);
      expect(inThread.total).toBe(first.total);
      // 進む（送った量が増える。分母は変わらない）
      await expect
        .poll(async () => (await progressOf(threadLine, name)).sent, { timeout: 60_000, message: "送った量が増えない" })
        .toBeGreaterThan(inThread.sent);
      expect((await progressOf(threadLine, name)).total).toBe(first.total);

      // ---- 3. 途中で接続が切れたら「送れませんでした」と理由が残り、次に起こすときに送り直す ---------------------
      // 向こうの sshd のこのユーザーの接続を落とす（線が切れたのと同じ——host の ssh には「closed by remote host」）
      await host.rootExec(`pkill -f 'sshd: ${host.user}'`);
      await expect(threadLine, "接続が切れたのに、会話の行が「送れませんでした」にならない").toHaveAttribute("data-state", "failed", {
        timeout: 30_000,
      });
      const failedText = (await threadLine.getByTestId("code-transfer-text").textContent()) ?? "";
      const stopped = new RegExp(`^${name} にコードを送れませんでした（(\\d+)MB / (\\d+)MB で止まりました）$`).exec(failedText.trim());
      expect(stopped, `送れなかったときの文が違う：${JSON.stringify(failedText)}`).not.toBeNull();
      expect(Number(stopped![2])).toBe(first.total);
      expect(Number(stopped![1])).toBeGreaterThan(0);
      await expect(threadLine.getByTestId("code-transfer-reason")).toContainText("SSH の接続が途中で閉じました");
      await expect(sidebarRow).toHaveAttribute("data-state", "failed");
      // 次に Module を起こそうとすると（ターンが Module を要るときと同じ口）、送り直す——行は進み具合に戻る。
      // 失敗のあとは少しのあいだ起こし直さない（間を置く）ので、戻るまで何度か頼む（頼むのは待たない——送り終えるまで返らない）
      await expect
        .poll(
          async () => {
            void api(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
            return threadLine.getAttribute("data-state");
          },
          { timeout: 120_000, intervals: [2_000], message: "送れなかったあと、送り直さない" },
        )
        .toBe("sending");

      // ---- 4. 送り終えたら消え、Module が起きる -------------------------------------------------------
      // 消えるのは、向こうで確かめて切り替え終えたとき（失敗でも消えるので、消えたあと版ができていることまで見る）
      await expect(threadLine, "送り終えたのに会話の進み具合が消えない").toBeHidden({ timeout: 600_000 });
      await expect(sidebarRow, "送り終えたのにサイドバーの進み具合が消えない").toBeHidden();
      const owner = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 12);
      const version = (await host.ssh(`cat ~/.local/share/banto-remote/${owner}/code/current`)).stdout.trim();
      expect(version, "向こうにコードの版が無い").toMatch(/^[0-9a-f]{16}-1$/);
      const prepared = await api<{ connected?: string[] }>(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
      expect(prepared.body.connected ?? [], JSON.stringify(prepared.body)).toEqual(expect.arrayContaining(["shell", "filesystem"]));
      // 同じ版のまま繋ぎ直しても送り直さない（版は 1 のまま）
      expect((await host.ssh(`cat ~/.local/share/banto-remote/${owner}/code/current`)).stdout.trim()).toBe(version);

      // 片づけ：Project を畳む（向こうの Module を落とす）
      await api(`/api/projects/${projectId}/close`, { method: "POST" });
    },
    { vaultAlias: alias },
  );
});
