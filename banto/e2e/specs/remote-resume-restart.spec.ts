// **別のサーバの Project の待たない仕事は、コードの送り直しを伴う起こし直しをまたいで続く**（決定・2026-10-16、ユーザー。
// アーキ仕様 §2.5「2.」の「別のサーバの Module は繋がるまで待つ」、Backlog #324）。
//
// 2026-10-15・16 の実機：banto を更新すると別のサーバ（banto-dev-vm）へ新しい版のコードを送ってから Module を起こすので、
// 「続けるか」の問いが 120 秒に間に合わず、向こうで動き続けている Shell のコマンド・Subagent・Factory の仕事が「途中で
// 終わりました」になった。自前の host（`own-host.ts`）と SSH の相手（`ssh-host.ts`）で、待たずに流した Shell のコマンドが
// 走っている間に起こし直し、見るもの（規則14——届いたことだけでなく中身まで）：
//   1. 送り込みを遅らせて（相手の線を絞る）120 秒を越えさせても、繋がってから問い、Shell が続けると答える。待つ間も
//      札は「起こし直しのあと続けています」のまま、「途中で終わりました」は届かない。コマンドが終わると、その結果
//      （出力の末尾）が同じ Thread に届く
//   2. 相手に繋がらないまま上限（E2E は縮める）を越えたら、「途中で終わりました」に理由（<実行場所> に繋がらなかった）と
//      結果の場所（出力のファイル）と「繋がったら届け直す」が出る
//   3. そのあと繋がったら、その間に終わっていたコマンドの結果が「起こし直しで途切れたあとに終わっていました」として
//      同じ Thread に1回だけ届く。もう一度起こし直しても二度は届かない
//
// 「新しい版」の作り方は `remote-code-presend.spec.ts` と同じ——向こうの `current` を、いまの版とは違う名前の版に差し替える。
import { test, expect, type Page } from "../test-base.js";
import { readFileSync } from "node:fs";
import { runIncus } from "@banto/container";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";
import { remoteOwnerDirName } from "../../packages/core/dist/runtime/remote-ssh.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、コードを送る。起こし直しのあとは線を絞って 120 秒より長く送る
test.setTimeout(1_800_000);

const OLD_VERSION = "0000000000000000-1";
const LABEL_A = "起こし直しをまたぐ長いコマンド";
const LABEL_B = "繋がらない間に終わるコマンド";
// 出力にだけ出る語（コマンドの文字には無い）——届いたものがコマンドの出力を運んだことを見る
const COMMAND_A = "sleep 420; echo remote-resume-$((6*7))";
const COMMAND_B = "sleep 45; echo late-result-$((7*8))";

interface HostThread {
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string }>;
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

/** 向こうの版を「前の版」に差し替え、塗りも消す（起こし直したら全部送り直す——banto を更新したあとと同じ） */
async function makeRemoteStale(sshHost: SshHost, host: OwnHost): Promise<void> {
  const code = `~/.local/share/banto-remote/${remoteOwnerDirName(host.dataDir)}/code`;
  const current = (await sshHost.ssh(`cat ${code}/current`)).stdout.trim();
  expect(current, "向こうにコードの版が無い").toMatch(/^[0-9a-f]{16}-1$/);
  if (current === OLD_VERSION) return;
  const swapped = await sshHost.ssh(
    `rm -rf ${code}/${OLD_VERSION} && cp -a ${code}/${current} ${code}/${OLD_VERSION} && rm -rf ${code}/${current} ${code}/${current}.layers ${code}/layers && echo ${OLD_VERSION} > ${code}/current`,
  );
  expect(swapped.code, swapped.stderr).toBe(0);
}

test("別のサーバの待たないコマンドは、送り込みが 120 秒を越える起こし直しをまたいで続き、繋がらないまま打ち切ったら理由と場所を出して繋がったあと1回だけ届け直す", async ({ page }) => {
  const alias = `e2e-rr-${Date.now()}`;
  const name = "rresume";
  await withSshHost(async (sshHost) => {
    await withOwnHost(async (host) => {
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
        body: { name: "E2E 起こし直しをまたぐ別のサーバ", root: "~/work/proj", runtime: `remote:${name}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id;
      const prepared = await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" });
      expect(prepared.body.connected ?? [], JSON.stringify(prepared.body)).toEqual(expect.arrayContaining(["shell"]));
      // API で作った Project には Base の会話がまだ無い——作る（remote-backlog-ssh-push と同じ）
      const threadId = (await api<{ id: string }>(host, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
      const thread = async () => (await api<HostThread>(host, `/api/threads/${threadId}`)).body;
      const fromShell = async () => (await thread()).messages.filter((m) => m.origin?.from === "shell").map((m) => m.origin!.title);

      /** 待たずに流す（AI のターン）。返った outputFile を返す */
      const runInBackground = async (command: string, label: string): Promise<string> => {
        await login(page, host);
        await openApp(page, host.url);
        await page.goto(`/p/${projectId}?bantoHost=${host.url}`);
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

      // ---- 1. 送り込みが 120 秒を越える起こし直しをまたいで続く ---------------------------------------------------
      await runInBackground(COMMAND_A, LABEL_A);
      expect((await thread()).awaitingReplies?.map((r) => r.moduleName)).toEqual(["shell"]);
      await host.stop("SIGTERM");
      await makeRemoteStale(sshHost, host);
      // 相手へ流れ込む向きを 12Mbit（毎秒約 1.5MB）に絞る——縮めたコード（約 300MB）を送るのに 120 秒を越える
      const limited = await runIncus(["config", "device", "override", sshHost.name, "eth0", "limits.ingress=12Mbit"]);
      expect(limited.code, limited.stderr).toBe(0);
      const restartedAt = performance.now();
      await host.start();
      const logStart = host.log().length;
      // 送っている間：札は「起こし直しのあと続けています」、「途中で終わりました」は届かない
      await expect
        .poll(async () => (await thread()).awaitingReplies?.map((r) => Boolean(r.keptAt)), { timeout: 60_000, message: "待つ間に「続けています」にならない" })
        .toEqual([true]);
      // Shell が続けると答えた（送り終えて繋がってから）
      await expect
        .poll(() => /前の走行の返事待ち（shell・Thread [^）]+）→ (続けると答えた|途中で終わりました)/.exec(host.log().slice(logStart))?.[1], {
          timeout: 900_000,
          intervals: [5_000],
          message: "Shell に続けるかを聞いていない",
        })
        .toBe("続けると答えた");
      const answeredAfterMs = performance.now() - restartedAt;
      expect(answeredAfterMs, `答えまで ${Math.round(answeredAfterMs / 1000)} 秒——送り込みが 120 秒を越えていない（試験の前提が崩れた）`).toBeGreaterThan(120_000);
      expect(host.log().slice(logStart)).toMatch(/「rresume」にコードを送りました/);
      expect(await fromShell(), "「途中で終わりました」が届いた").toEqual([]);
      await runIncus(["config", "device", "unset", sshHost.name, "eth0", "limits.ingress"]);
      // コマンドが終わると、出力の末尾が同じ Thread に届く
      await expect.poll(fromShell, { timeout: 600_000, intervals: [5_000], message: "続けたコマンドの結果が届かない" }).toEqual([
        `コマンドが終わりました：${LABEL_A}`,
      ]);
      const deliveredA = (await thread()).messages.find((m) => m.origin?.from === "shell")!;
      expect(deliveredA.text).toContain("remote-resume-42");
      expect(deliveredA.text).toContain('"exitCode":0');
      await expect.poll(async () => (await thread()).awaitingReplies ?? [], { timeout: 30_000 }).toEqual([]);

      // ---- 2. 繋がらないまま上限を越えたら、理由と結果の場所つきで「途中で終わりました」 -----------------------------
      const outputB = await runInBackground(COMMAND_B, LABEL_B);
      await host.stop("SIGTERM");
      // 向こうの sshd を止める（経路が途切れた）。コマンドは向こうのユーザーの systemd で動き続ける
      // 本番の別のサーバと同じく linger を入れておく——無いと sshd を止めてログインが閉じた 10 秒後に user@ ごと止められ、
      // 待たないコマンドも止まる（#295 と同じ形。印のファイルを直に置けば入れ子でも効く）
      const lingered = await sshHost.rootExec(`mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/${sshHost.user}`);
      expect(lingered.code, lingered.stderr).toBe(0);
      const sshdStopped = await sshHost.rootExec("systemctl stop ssh.service");
      expect(sshdStopped.code, sshdStopped.stderr).toBe(0);
      await host.start({ BANTO_RESUME_CONNECT_LIMIT_MS: "20000" });
      await expect
        .poll(fromShell, { timeout: 120_000, message: "打ち切ったのに「途中で終わりました」が届かない" })
        .toEqual([`コマンドが終わりました：${LABEL_A}`, "shell の仕事は途中で終わりました"]);
      const lostB = (await thread()).messages.filter((m) => m.origin?.from === "shell").at(-1)!;
      expect(lostB.text).toMatch(new RegExp(`別のサーバ「${name}」に 20 秒繋がりませんでした：`));
      expect(lostB.text).toContain(`結果の場所：${outputB}（別のサーバ「${name}」の中）`);
      expect(lostB.text).toContain("shell に繋がったら、そのときまでに終わっていた結果をこの会話に届け直します");
      expect((await thread()).awaitingReplies ?? []).toEqual([]);
      // 画面にも同じ理由と場所が出る
      await login(page, host);
      await openApp(page, host.url);
      await page.goto(`/p/${projectId}?bantoHost=${host.url}`);
      const lostCard = page.getByTestId("delivered-message").filter({ hasText: "shell の仕事は途中で終わりました" });
      await expect(lostCard).toHaveCount(1, { timeout: 60_000 });
      await expect(lostCard.getByTestId("delivered-title")).toHaveText("shell の仕事は途中で終わりました");
      await lostCard.getByRole("button", { name: "届いた中身をすべて見る" }).click();
      const lostBody = lostCard.getByTestId("delivered-body");
      await expect(lostBody).toContainText(`別のサーバ「${name}」に 20 秒繋がりませんでした`);
      await expect(lostBody).toContainText(`結果の場所：${outputB}`);

      // ---- 3. 繋がったら、終わっていた結果が1回だけ届く --------------------------------------------------------------
      // 向こうでコマンドが終わるのを待つ（出力のファイルに結果の語が出る——SSH の外から見る）
      await expect
        .poll(async () => (await sshHost.rootExec(`cat ${outputB.replace(/^~/, `/home/${sshHost.user}`)} 2>/dev/null || true`)).stdout, { timeout: 120_000 })
        .toContain("late-result-56");
      const sshdStarted = await sshHost.rootExec("systemctl start ssh.service");
      expect(sshdStarted.code, sshdStarted.stderr).toBe(0);
      // 次に Module を起こしたとき（ここでは画面の外から起こす）に届け直す
      await expect
        .poll(async () => (await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" })).body.connected ?? [], {
          timeout: 300_000,
          intervals: [5_000],
        })
        .toEqual(expect.arrayContaining(["shell"]));
      const late = `起こし直しで途切れたあとに終わっていました：コマンドが終わりました：${LABEL_B}`;
      await expect.poll(fromShell, { timeout: 120_000, message: "終わっていた結果が届け直されない" }).toEqual([
        `コマンドが終わりました：${LABEL_A}`,
        "shell の仕事は途中で終わりました",
        late,
      ]);
      const redelivered = (await thread()).messages.filter((m) => m.origin?.from === "shell").at(-1)!;
      expect(redelivered.text).toContain("late-result-56");
      const lateCard = page.getByTestId("delivered-message").filter({ hasText: late });
      await expect(lateCard, "届け直した結果が画面に出ない").toHaveCount(1, { timeout: 60_000 });
      await expect(lateCard.getByTestId("delivered-title")).toHaveText(late);
      await lateCard.getByRole("button", { name: "届いた中身をすべて見る" }).click();
      await expect(lateCard.getByTestId("delivered-body")).toContainText("late-result-56");
      await expect.poll(async () => (await thread()).awaitingReplies ?? [], { timeout: 30_000 }).toEqual([]);

      // もう一度起こし直しても、二度は届かない
      await host.stop("SIGTERM");
      await host.start();
      await expect
        .poll(async () => (await api<{ connected?: string[] }>(host, `/api/projects/${projectId}/modules/prepare`, { method: "POST" })).body.connected ?? [], {
          timeout: 300_000,
          intervals: [5_000],
        })
        .toEqual(expect.arrayContaining(["shell"]));
      await new Promise((r) => setTimeout(r, 10_000));
      expect(await fromShell(), "届け直した結果がもう一度届いた").toEqual([`コマンドが終わりました：${LABEL_A}`, "shell の仕事は途中で終わりました", late]);

      await api(host, `/api/projects/${projectId}/close`, { method: "POST" });
    });
  });
});
