// **banto は動いたまま、別のサーバの Module との接続だけが切れても、待たないコマンドの結果は届く**（決定・2026-10-17、
// Backlog #362。アーキ仕様 §2.5「2.」の「banto は動いたまま、Module との接続だけが切れたとき」）。
//
// 2026-10-17 の実機：host から別のサーバ（banto-dev-vm）への経路が約2分途切れ、SSH が閉じた瞬間に cli.ts の onclose が
// Shell の待たないコマンド（npm ci・build・E2E）の札をみな「途中で終わりました」にした——コマンドは向こうのユーザーの
// systemd で最後まで走り、ログも残っていたのに、結果は届かなかった。自前の host（`own-host.ts`）と SSH の相手
// （`ssh-host.ts`）で、待たずに流したコマンドが走っている間に、相手の側で SSH の接続を切り（sshd を止めて、いまの接続も
// 落とす——経路が途切れたのと同じく、host から見ると接続が閉じる）、見るもの（規則14——届いたことだけでなく中身まで）：
//   1. 上限の内に繋がり直したら、札は「途中で終わりました」にならず、待つ間は「接続が切れたあと続けています」。繋がり
//      直した Shell に続けるかを問い、コマンドが終わると結果（出力の末尾）が同じ Thread に届く
//   2. 繋がらないまま上限（E2E は縮める）を越えたら、「途中で終わりました」に理由（<実行場所> に繋がらなかった）と結果の
//      場所（出力のファイル）と「繋がったら届け直す」が出る
//   3. そのあと繋がったら、その間に終わっていたコマンドの結果が「接続が途切れたあとに終わっていました」として同じ
//      Thread に1回だけ届く
import { test, expect, type Page } from "../test-base.js";
import { readFileSync } from "node:fs";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、コードを送る。上限を越える回は 90 秒切ったまま、繋がり直すのも試し直しの間を待つ
test.setTimeout(1_800_000);

// 繋がり直すのを待つ上限（本番は 30 分）。上限の内の回は 10 秒だけ切る——試し直しの間（5 秒→10 秒）で繋がり直す
const CONNECT_LIMIT_MS = 90_000;
const LABEL_A = "接続が切れても続くコマンド";
const LABEL_B = "繋がらない間に終わるコマンド";
// 出力にだけ出る語（コマンドの文字には無い）——届いたものがコマンドの出力を運んだことを見る
const COMMAND_A = "sleep 60; echo cut-resume-$((6*7))";
const COMMAND_B = "sleep 30; echo cut-late-$((7*8))";

interface HostThread {
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string; keptAfter?: string }>;
  lastTurn?: { outcome?: string };
}

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

/**
 * **SSH の接続を相手の側で切る**：sshd を止め（新しく繋がれない）、いまの接続も落とす（`sshd: <user>` のプロセス）。
 * host から見ると接続が閉じる——経路が途切れて SSH が閉じたときと同じ。コマンドは向こうのユーザーの systemd で動き続ける
 * （linger を入れておく——無いとログインが閉じた 10 秒後に user@ ごと止められる。`remote-resume-restart.spec.ts` と同じ）
 */
async function cutSsh(sshHost: SshHost): Promise<void> {
  const lingered = await sshHost.rootExec(`mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/${sshHost.user}`);
  expect(lingered.code, lingered.stderr).toBe(0);
  // 型は先頭に留める（`^sshd`）——留めないと、この `sh -c` 自身の引数に同じ文字があって自分まで落とす
  const stopped = await sshHost.rootExec(
    `systemctl stop ssh.socket ssh.service 2>/dev/null; systemctl stop ssh.service; pkill -KILL -f '^sshd(-session)?: ${sshHost.user}' || true`,
  );
  expect(stopped.code, stopped.stderr).toBe(0);
}

async function restoreSsh(sshHost: SshHost): Promise<void> {
  const started = await sshHost.rootExec("systemctl start ssh.service");
  expect(started.code, started.stderr).toBe(0);
}

test("別のサーバの Module との接続が切れても、待たないコマンドは上限の内なら続いて結果が届き、上限を越えたら理由と場所を出して繋がったあと1回だけ届け直す", async ({ page }) => {
  const alias = `e2e-rd-${Date.now()}`;
  const name = "rdisconnect";
  await withSshHost(async (sshHost) => {
    await withOwnHost(
      async (host) => {
        await sshHost.ssh("mkdir -p ~/work/proj");
        const stored = await api<{ isError?: boolean }>(host, "/api/ui-tool-call", {
          method: "POST",
          body: {
            server: "vault-directory",
            tool: "createAlias",
            arguments: { implementation: "vault-local", name: alias, kind: "ssh-identity", value: readFileSync(sshHost.identityFile, "utf8") },
          },
        });
        expect(stored.status, JSON.stringify(stored.body)).toBe(200);
        expect(stored.body.isError, JSON.stringify(stored.body)).toBeFalsy();
        const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
        const scanned = await api<{ hostKey: { type: string; key: string } }>(host, "/api/runtimes/scan", { method: "POST", body: target });
        expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
        const registered = await api(host, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
        expect(registered.status, JSON.stringify(registered.body)).toBe(201);
        const created = await api<{ id: string }>(host, "/api/projects", {
          method: "POST",
          body: { name: "E2E 接続が切れる別のサーバ", root: "~/work/proj", runtime: `remote:${name}` },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const projectId = created.body.id;
        const prepare = async () => (await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" })).body.connected ?? [];
        expect(await prepare()).toEqual(expect.arrayContaining(["shell"]));
        // API で作った Project には Base の会話がまだ無い——作る（remote-resume-restart と同じ）
        const threadId = (await api<{ id: string }>(host, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const thread = async () => (await api<HostThread>(host, `/api/threads/${threadId}`)).body;
        const fromShell = async () => (await thread()).messages.filter((m) => m.origin?.from === "shell").map((m) => m.origin!.title);

        await login(page, host);
        await openApp(page, host.url);
        await page.goto(`/p/${projectId}?bantoHost=${host.url}`);

        /** 待たずに流す（AI のターン）。返った outputFile を返す */
        const runInBackground = async (command: string, label: string): Promise<string> => {
          const before = (await thread()).messages.length;
          const composer = page.getByPlaceholder(/に送る/);
          await composer.fill(
            "長いコマンドを待たずに流して。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command, runInBackground: true, label } }] }),
          );
          await composer.press("Enter");
          await expect.poll(async () => (await thread()).messages.length, { timeout: 120_000 }).toBeGreaterThan(before + 1);
          await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
          const reply = (await thread()).messages.filter((m) => m.role === "assistant").at(-1)!;
          const started = JSON.parse(reply.text) as { status: string; outputFile: string };
          expect(started.status).toBe("running");
          return started.outputFile;
        };

        // ---- 1. 上限の内に繋がり直したら、続いて結果が届く ------------------------------------------------------
        await runInBackground(COMMAND_A, LABEL_A);
        expect((await thread()).awaitingReplies?.map((r) => r.moduleName)).toEqual(["shell"]);
        const logStart = host.log().length;
        await cutSsh(sshHost);
        // 接続が閉じた：札は待つ（「途中で終わりました」にしない）
        await expect
          .poll(async () => (await thread()).awaitingReplies?.map((r) => r.keptAfter), { timeout: 60_000, message: "接続が切れた札が待たない" })
          .toEqual(["disconnect"]);
        expect(host.log().slice(logStart)).toMatch(/shell-[^ ]+ との接続が切れました——続けられる札 1 件は、繋がり直すのを待ちます/);
        const workLine = page.locator('[data-sidebar="sidebar"]').getByTestId("thread-background");
        await expect(workLine).toHaveText(LABEL_A, { timeout: 30_000 });
        await workLine.click();
        const item = page.getByTestId("background-list").getByTestId("background-item");
        await expect(item).toHaveCount(1);
        await expect(item.getByTestId("background-item-kept")).toHaveText(/^接続が切れたあと続けています（(いま|\d+分前)から）$/);
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 10_000));
        expect(await fromShell(), "切れている間に「途中で終わりました」が届いた").toEqual([]);
        await restoreSsh(sshHost);
        // 繋がり直した Shell に問う（host が自分で起こし直す——画面の外から起こさない）
        await expect
          .poll(() => /接続が切れたあとの返事待ち（shell・Thread [^）]+）→ (続けると答えた|途中で終わりました)/.exec(host.log().slice(logStart))?.[1], {
            timeout: CONNECT_LIMIT_MS,
            intervals: [2_000],
            message: "繋がり直した Shell に続けるかを聞いていない",
          })
          .toBe("続けると答えた");
        await expect.poll(fromShell, { timeout: 180_000, intervals: [5_000], message: "続けたコマンドの結果が届かない" }).toEqual([`コマンドが終わりました：${LABEL_A}`]);
        const deliveredA = (await thread()).messages.find((m) => m.origin?.from === "shell")!;
        expect(deliveredA.text).toContain("cut-resume-42");
        expect(deliveredA.text).toContain('"exitCode":0');
        await expect.poll(async () => (await thread()).awaitingReplies ?? [], { timeout: 30_000 }).toEqual([]);
        const cardA = page.getByTestId("delivered-message").filter({ hasText: `コマンドが終わりました：${LABEL_A}` });
        await expect(cardA, "届いた結果が画面に出ない").toHaveCount(1, { timeout: 60_000 });
        await cardA.getByRole("button", { name: "届いた中身をすべて見る" }).click();
        await expect(cardA.getByTestId("delivered-body")).toContainText("cut-resume-42");

        // ---- 2. 繋がらないまま上限を越えたら、理由と結果の場所つきで「途中で終わりました」 -----------------------------
        // 繋がり直したばかりの Shell に流す（前の回で起こし直したものが答えるまで待つ）
        await expect.poll(prepare, { timeout: 300_000, intervals: [5_000] }).toEqual(expect.arrayContaining(["shell"]));
        const outputB = await runInBackground(COMMAND_B, LABEL_B);
        await cutSsh(sshHost);
        const lostTitle = "shell の仕事は途中で終わりました";
        await expect
          .poll(fromShell, { timeout: CONNECT_LIMIT_MS + 60_000, intervals: [5_000], message: "上限を越えても「途中で終わりました」が届かない" })
          .toEqual([`コマンドが終わりました：${LABEL_A}`, lostTitle]);
        const lostB = (await thread()).messages.filter((m) => m.origin?.from === "shell").at(-1)!;
        expect(lostB.text).toMatch(new RegExp(`Module との接続が切れたため（別のサーバ「${name}」に 90 秒繋がりませんでした：`));
        expect(lostB.text).toContain(`結果の場所：${outputB}（別のサーバ「${name}」の中）`);
        expect(lostB.text).toContain("shell に繋がったら、そのときまでに終わっていた結果をこの会話に届け直します");
        expect((await thread()).awaitingReplies ?? []).toEqual([]);
        const lostCard = page.getByTestId("delivered-message").filter({ hasText: lostTitle });
        await expect(lostCard).toHaveCount(1, { timeout: 60_000 });
        await lostCard.getByRole("button", { name: "届いた中身をすべて見る" }).click();
        await expect(lostCard.getByTestId("delivered-body")).toContainText(`別のサーバ「${name}」に 90 秒繋がりませんでした`);
        await expect(lostCard.getByTestId("delivered-body")).toContainText(`結果の場所：${outputB}`);

        // ---- 3. 繋がったら、終わっていた結果が1回だけ届く --------------------------------------------------------------
        await expect
          .poll(async () => (await sshHost.rootExec(`cat ${outputB.replace(/^~/, `/home/${sshHost.user}`)} 2>/dev/null || true`)).stdout, { timeout: 120_000 })
          .toContain("cut-late-56");
        await restoreSsh(sshHost);
        await expect.poll(prepare, { timeout: 300_000, intervals: [5_000] }).toEqual(expect.arrayContaining(["shell"]));
        const late = `接続が途切れたあとに終わっていました：コマンドが終わりました：${LABEL_B}`;
        await expect.poll(fromShell, { timeout: 120_000, message: "終わっていた結果が届け直されない" }).toEqual([
          `コマンドが終わりました：${LABEL_A}`,
          lostTitle,
          late,
        ]);
        expect((await thread()).messages.filter((m) => m.origin?.from === "shell").at(-1)!.text).toContain("cut-late-56");
        const lateCard = page.getByTestId("delivered-message").filter({ hasText: late });
        await expect(lateCard, "届け直した結果が画面に出ない").toHaveCount(1, { timeout: 60_000 });
        await expect(lateCard.getByTestId("delivered-title")).toHaveText(late);
        await expect.poll(async () => (await thread()).awaitingReplies ?? [], { timeout: 30_000 }).toEqual([]);
        // もう一度繋がっても二度は届かない
        await new Promise((r) => setTimeout(r, 10_000));
        expect(await fromShell(), "届け直した結果がもう一度届いた").toEqual([`コマンドが終わりました：${LABEL_A}`, lostTitle, late]);

        await api(host, `/api/projects/${projectId}/close`, { method: "POST" });
      },
      { env: { BANTO_RESUME_CONNECT_LIMIT_MS: String(CONNECT_LIMIT_MS) } },
    );
  });
});
