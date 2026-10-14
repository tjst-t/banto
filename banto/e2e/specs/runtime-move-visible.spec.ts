// **移している最中の Project を開いたら、移していると分かる**（Backlog #270 runtime-move-visible、2026-10-12 ユーザー要望）。
// 移す本体は runtime-move.spec.ts、移す画面は runtime-move-ui.spec.ts が見ている。ここは移している間・移せなかったとき・
// 移し終えたときに、その Project の会話の面とサイドバーが何を出すかを見る。
//
// 見るもの（規則14——出ているかだけでなく、出している中身まで）：
//   1. 移している間：会話の面（Base・Fork とも）の上に帯——どこからどこへ・写した量／全体（進む）・会話が止まっていること。
//      入力欄は打てず送信も押せず、理由が出る。サイドバーのその Project の行に「移しています」の印（ほかの Project には出ない）
//   2. 携帯の幅でも、帯・止まった入力欄・ナビの中の印が出る
//   3. 移せなかったら、帯が「移せませんでした：理由。元の ○○ のまま動いています」に替わる（理由は受信箱の知らせと同じ文）。
//      入力欄は戻り、印は消える
//   4. 移し終えたら印が消え、入力欄が戻り、帯が「移しました：root は…。元は…に残っています」に替わる（人が閉じるまで残る。
//      携帯の幅でも。Backlog #293——移す小窓は押したら閉じるので、終わりの結果はここに出す）。各 Thread には「移した」の
//      知らせが届いている
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FRONTEND_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作る
test.setTimeout(1_800_000);

interface HostProject {
  id: string;
  name: string;
  root: string;
  runtime?: string;
  move?: { to: { runtime: string; root: string } };
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

/** 人のセッションで（移すのは人の画面だけ） */
async function human<T>(page: Page, host: OwnHost, method: "GET" | "POST", path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await page.context().request.fetch(`${host.url}${path}`, {
    method,
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : undefined) as T };
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** 帯の「（1.2 MB / 8.0 MB）」から写した量と全体を読む（単位をそろえて比べる） */
function parseSize(text: string): { copied: number; total: number } | undefined {
  const m = text.match(/^（([\d.]+) (B|KB|MB|GB) \/ ([\d.]+) (B|KB|MB|GB)）$/);
  if (!m) return undefined;
  const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
  return { copied: Number(m[1]) * unit[m[2] as keyof typeof unit], total: Number(m[3]) * unit[m[4] as keyof typeof unit] };
}

test("移している Project の会話の面に帯と進み具合が出て入力欄が止まり、サイドバーに印が出る。移せなければ理由、移し終えれば消える", async ({ page }) => {
  const name = `mvv-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-mvv-${Date.now()}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-visible-")));
  writeFileSync(join(root, "hello.txt"), "移しているのが見える\n");
  // 写すのに時間が掛かる大きさ（縮まない中身）。写す速さは下で抑える
  writeFileSync(join(root, "big.bin"), randomBytes(8 * 1024 * 1024));
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "最初"]);
  try {
    await withSshHost(async (sshHost: SshHost) => {
      const remoteRoot = `/home/${sshHost.user}/work/moved-visible`;
      await withOwnHost(
        async (own) => {
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

          const projectName = `E2E 移しているのが見える ${name}`;
          const created = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: projectName, root } });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          const projectId = created.body.id;
          // 印がほかの Project には出ないことを見るための、もう1つの Project
          const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-visible-other-")));
          const other = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: `E2E 移さない ${name}`, root: otherRoot } });
          expect(other.status, JSON.stringify(other.body)).toBe(201);
          const baseThreadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
          const forked = await api<{ id: string }>(own, `/api/threads/${baseThreadId}/fork`, { method: "POST", body: { title: "移す間の Fork", fresh: true } });
          expect(forked.status, JSON.stringify(forked.body)).toBe(201);
          const forkId = forked.body.id;
          const project = async () => (await api<HostProject[]>(own, "/api/projects")).body.find((p) => p.id === projectId)!;

          await login(page, own);
          await openApp(page, own.url);
          const base = `/p/${projectId}?bantoHost=${own.url}`;
          await page.goto(base);

          const banner = page.getByTestId("runtime-move-banner");
          const input = page.getByRole("textbox", { name: "Message input" });
          const send = page.getByRole("button", { name: "Send message" });
          const reason = page.getByTestId("composer-blocked-reason");
          const projectRow = (id: string) => page.locator("li").filter({ has: page.locator(`a[href^="/p/${id}"]`) }).first();
          const mark = page.getByTestId("sidebar-project-moving");

          // ---- 移す前：何も出ていない --------------------------------------------------------------------
          await expect(input).toBeEditable({ timeout: 30_000 });
          await expect(banner).toHaveCount(0);
          await expect(reason).toHaveCount(0);
          await expect(mark).toHaveCount(0);

          const startMove = async () => {
            const started = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, {
              runtime: `remote:${name}`,
              root: remoteRoot,
            });
            expect(started.status, JSON.stringify(started.body)).toBe(202);
          };
          /** 移している間の帯と入力欄。Fork を開いているときは右の面（最後の面）を見る */
          const expectMoving = async (surface: "first" | "last" = "first") => {
            const b = banner[surface]();
            await expect(b).toHaveAttribute("data-state", "moving", { timeout: 60_000 });
            await expect(b.getByTestId("runtime-move-banner-route")).toHaveText(
              `この Project を この機械のコンテナ から 別のサーバ「${name}」 へ移しています`,
            );
            await expect(b).toContainText("終わるまで会話は止まっています。届いたものは終わってから届きます");
            await expect(b.getByTestId("runtime-move-banner-phase")).toHaveText(
              /^——(用意しています|Service を止めて、Module を畳んでいます|写しています|写したものを確かめています|切り替えています)$/,
            );
            await expect(input[surface]()).toBeDisabled();
            await expect(send[surface]()).toBeDisabled();
            await expect(reason[surface]()).toHaveText("別の実行場所へ移している間は送れません。終わると送れるようになります");
          };

          // ---- 1回目：移せない（写している途中で移す先に余計なファイルを置く→確かめで合わない） ----------------------
          await startMove();
          await expectMoving();
          // 移す先の根は押したときに作られている。写し終えたあとの確かめで、件数が元と合わなくなる
          await sshHost.ssh(`touch ${remoteRoot}/stray-during-move.txt`);
          // サイドバーの印（その Project の行だけ）
          await expect(projectRow(projectId).getByTestId("sidebar-project-moving")).toBeVisible();
          await expect(projectRow(projectId).getByTestId("sidebar-project-moving")).toHaveAttribute("aria-label", `${projectName} を移しています`);
          await expect(projectRow(other.body.id).getByTestId("sidebar-project-moving")).toHaveCount(0);
          await expect(mark).toHaveCount(1);

          const failed = page.locator('[data-testid="runtime-move-banner"][data-state="failed"]');
          await expect(failed).toBeVisible({ timeout: 900_000 });
          // 理由は受信箱の知らせと同じ文
          const notices = (await api<Array<{ title?: string; detail?: string; projectId?: string }>>(own, "/api/inbox")).body.filter(
            (n) => n.projectId === projectId && /移せませんでした/.test(n.title ?? ""),
          );
          expect(notices.map((n) => n.title)).toEqual([`「${projectName}」を別のサーバ「${name}」へ移せませんでした`]);
          const why = notices[0]!.detail!;
          expect(why).toContain("中身が元と合いません");
          expect(why).toContain("切り替えていません（元の場所のまま）");
          await expect(failed.getByTestId("runtime-move-banner-reason")).toHaveText(why);
          await expect(failed).toHaveText(`移せませんでした：${why}元の この機械のコンテナ（${root}）のまま動いています`);
          // 会話は戻る・印は消える・元のまま
          await expect(input).toBeEditable();
          await expect(reason).toHaveCount(0);
          await expect(mark).toHaveCount(0);
          expect((await project()).runtime ?? "host-container").toBe("host-container");
          // 閉じられる
          await failed.getByRole("button", { name: "この知らせを閉じる" }).click();
          await expect(banner).toHaveCount(0);

          // ---- 2回目：移し終える。移している間を Base・Fork・携帯で見る -------------------------------------------
          await startMove();
          await expectMoving();
          // 進み具合：写した量／全体が出て、進む
          const sizeText = banner.getByTestId("runtime-move-banner-size");
          let first: { copied: number; total: number } | undefined;
          await expect
            .poll(async () => {
              first = parseSize(await sizeText.innerText());
              return first ? first.copied > 0 && first.total >= 8 * 1024 * 1024 : `まだ出ていない：${await sizeText.innerText()}`;
            }, { timeout: 120_000 })
            .toBe(true);
          await expect
            .poll(async () => (parseSize(await sizeText.innerText())?.copied ?? 0) > first!.copied, { timeout: 60_000, message: "写した量が進まない" })
            .toBe(true);
          await expect(projectRow(projectId).getByTestId("sidebar-project-moving")).toBeVisible();

          // Fork の面も同じ
          await page.goto(`${base}&fork=${forkId}`);
          await expect(page.getByPlaceholder("この Fork Thread に送る")).toBeVisible({ timeout: 30_000 });
          await expectMoving("last");
          // 開いている面の数だけ帯と止まった入力欄がある（Base が隠れていても数は合う）
          expect(await banner.count()).toBe(await page.getByTestId("composer-blocked-reason").count());

          // 携帯の幅：帯と止まった入力欄、ナビの中の印
          await page.setViewportSize({ width: 412, height: 860 });
          await page.goto(base);
          await expectMoving();
          await page.getByRole("button", { name: "Project と Thread の一覧を開く" }).first().click();
          await expect(projectRow(projectId).getByTestId("sidebar-project-moving")).toBeVisible();
          await page.keyboard.press("Escape");
          await page.setViewportSize({ width: 1280, height: 860 });
          await page.goto(base);

          // 移し終える：帯が「移しました」に替わり、印は消え、入力欄が戻る
          const done = page.locator('[data-testid="runtime-move-banner"][data-state="done"]');
          await expect(done).toBeVisible({ timeout: 900_000 });
          await expect(done).toHaveText(
            `別のサーバ「${name}」 へ移しました。root は ${remoteRoot} です。元は この機械のコンテナ の ${root} に残っています。要らなくなったら消してください。`,
          );
          await expect(page.locator('[data-testid="runtime-move-banner"][data-state="moving"]')).toHaveCount(0);
          const moved = await project();
          expect(moved.move).toBeUndefined();
          expect(moved.runtime).toBe(`remote:${name}`);
          expect(moved.root).toBe(remoteRoot);
          await expect(input).toBeEditable();
          await expect(reason).toHaveCount(0);
          await expect(mark).toHaveCount(0);
          // 携帯の幅でも同じ帯が出て、閉じられる（閉じたら出ない）
          await page.setViewportSize({ width: 412, height: 860 });
          await expect(done).toBeVisible();
          await expect(done.getByTestId("runtime-move-banner-root")).toHaveText(remoteRoot);
          await done.getByRole("button", { name: "この知らせを閉じる" }).click();
          await expect(banner).toHaveCount(0);
          await page.setViewportSize({ width: 1280, height: 860 });
          // 各 Thread には「移した」の知らせが届いている（次のターンの頭に積まれる）
          for (const id of [baseThreadId, forkId]) {
            const t = (await api<{ deliveries?: Array<{ from: string; title: string; text: string }> }>(own, `/api/threads/${id}`)).body;
            expect((t.deliveries ?? []).map((d) => d.title)).toEqual(["Project を別の実行場所へ移しました"]);
            expect(t.deliveries![0]!.text).toContain(`root は ${remoteRoot} になりました`);
          }
          rmSync(otherRoot, { recursive: true, force: true });
        },
        // 写している間を画面で見るために、写す速さを抑える（8 MiB で 30 秒ほど）
        { env: { BANTO_TEST_RUNTIME_MOVE_BYTES_PER_SEC: String(256 * 1024) } },
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
