// **別のサーバでも、新しい Project の始め方をこの機械と揃える**（Backlog #425 `project-clone`、`docs/specs/v4-frontend.md` §6.49）。
// 相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`、machine）。見るもの（規則14——画面の帯の中身と、向こうのフォルダの中身まで）：
//   1. 「新しいリポジトリ」：画面で置く場所と名前を選んで作ると、帯（Module を起こしています→）が出て消え、向こうの根に .git が
//      でき、既定のブランチは main
//   2. 「clone」：公開の https の URL（試験の偽の git の場所——向こうの /etc/gitconfig の insteadOf で向こうのフォルダの bare
//      リポジトリへ）。フォルダ名は URL から入る。中身（隠しファイルも）が根に来て、作業フォルダは残らない
//   3. 失敗：届かない URL なら帯に理由と「もう一度」「AI に頼む」。作業フォルダは消える。「AI に頼む」は入力欄に頼みを置き、
//      直してから「もう一度」を押すと中身が根に来て帯が閉じる
// machine は1つの実行場所に Project は1つ——1つ見終えたら閉じる（閉じた Project は数えない）
import { test, expect, type Locator, type Page } from "../test-base.js";
import { randomBytes } from "node:crypto";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { clickNewProject, openApp, openNav } from "../helpers.js";
import { withSshHost, type SshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコードを送る
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

/** 試験の偽の git の場所（向こうでは insteadOf で bare リポジトリへ。名前は引けない） */
const FAKE_URL = "https://git.e2e.invalid/e2e/hello.git";

async function openNewProject(page: Page, runtime: string): Promise<Locator> {
  await openNav(page);
  await clickNewProject(page);
  const dialog = page.getByRole("dialog", { name: "新しい Project" });
  await expect(dialog.getByTestId("new-project-runtime")).toBeVisible({ timeout: 15_000 });
  await dialog.getByTestId("new-project-runtime-select").click();
  await page.locator(`[data-testid="new-project-runtime-option"][data-runtime="${runtime}"]`).click();
  await expect(dialog.getByTestId("start-method-tab")).toHaveText(["手元のフォルダ", "clone", "新しいリポジトリ"]);
  return dialog;
}

/** 置く場所を向こうの ~/work にする（「選ぶ」の画面で） */
async function chooseParent(page: Page, dialog: Locator, host: SshHost): Promise<void> {
  await dialog.getByRole("button", { name: "選ぶ" }).click();
  const picker = page.getByTestId("path-picker");
  await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}`, { timeout: 60_000 });
  await picker.getByTestId("path-picker-entry").filter({ hasText: /^work$/ }).click();
  await expect(picker.getByTestId("path-picker-current")).toHaveText(`/home/${host.user}/work`, { timeout: 60_000 });
  await picker.getByRole("button", { name: "ここにする" }).click();
  await expect(dialog.getByLabel(/置く場所/)).toHaveValue(`/home/${host.user}/work`);
}

/** 作った Project の id（URL から）。前に開いていた Project の URL のままでは通さない */
async function createdProjectId(page: Page, before?: string): Promise<string> {
  const idOf = () => /\/p\/([^/?]+)/.exec(page.url())?.[1];
  await expect.poll(() => (idOf() !== before ? idOf() : undefined), { timeout: 120_000, message: "作った Project へ移らない" }).toBeTruthy();
  return idOf()!;
}

/** host の記録の始め方の状態（成功したときにだけ done になる——帯が「無い」だけを見ると、出る前に通ってしまう） */
async function startStatus(id: string): Promise<string | undefined> {
  const r = await api<Array<{ id: string; start?: { status: string; error?: string } }>>("/api/projects");
  const s = r.body.find((p) => p.id === id)?.start;
  return s ? `${s.status}${s.error ? `：${s.error}` : ""}` : undefined;
}

async function closeProject(id: string): Promise<void> {
  const r = await api(`/api/projects/${id}/close`, { method: "POST" });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

/** 向こうのユーザーで流す（SSH の外——incus exec）。落ちたら終了コードと stderr を添えて落とす（黙って空にしない） */
async function remote(host: SshHost, command: string): Promise<string> {
  const r = await host.rootExec(`su - ${host.user} -c ${JSON.stringify(command)}`);
  if (r.code !== 0) throw new Error(`向こうで ${command} が落ちました（${r.code}）：${r.stderr}`);
  return `${r.stdout}`.trim();
}

test("別のサーバで「新しいリポジトリ」「clone」から Project を作ると、向こうの根に .git・中身が来る。失敗したら帯に理由と「もう一度」", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const alias = `e2e-ps-${Date.now()}`;
  const name = `ps-${randomBytes(3).toString("hex")}`;
  await withSshHost(
    async (host) => {
      // 試験の偽の git の場所：向こうに1コミットの bare リポジトリ（隠しファイルも入れる）を置き、システムの git の設定で
      // FAKE_URL をそこへ向ける（banto は GIT_CONFIG_GLOBAL=/dev/null にするが、システムの設定は読む）
      const made = await host.rootExec(
        [
          "set -e",
          "d=$(mktemp -d)",
          "cd $d && git init -q -b main && echo 'hello from e2e' > README.md && echo 'x' > .hidden-file",
          "git -c user.name=e2e -c user.email=e2e@e2e.invalid add -A && git -c user.name=e2e -c user.email=e2e@e2e.invalid commit -q -m first",
          "mkdir -p /srv/e2e && git clone -q --bare $d /srv/e2e/hello.git",
          `chown -R ${host.user}:${host.user} /srv/e2e`,
          `git config --system url.file:///srv/e2e/hello.git.insteadOf ${FAKE_URL}`,
          `su - ${host.user} -c 'mkdir -p ~/work'`,
        ].join("\n"),
      );
      expect(made.code, made.stderr).toBe(0);

      const target = { name, host: host.address, user: host.user, port: host.port, identity: alias };
      const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: target });
      expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
      const registered = await api("/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);

      // この機械には start を渡せない（Repositories の画面が同じ役）
      const local = await api<{ error: string }>("/api/projects", { method: "POST", body: { name: "x", root: "/tmp", start: { kind: "init" } } });
      expect(local.status).toBe(400);
      // URL の断り（何も作らない）
      const refused = await api<{ error: string }>("/api/projects", {
        method: "POST",
        body: { name: "x", runtime: `remote:${name}`, parent: "~/work", folder: "refused", start: { kind: "clone", url: "file:///srv/e2e/hello.git" } },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain("file:// の URL は受けません");
      expect(await remote(host, "test -e ~/work/refused && echo yes || echo no")).toBe("no");

      await openApp(page);
      const opened = /\/p\/([^/?]+)/.exec(page.url())?.[1];

      // ---- 1. 新しいリポジトリ ---------------------------------------------------------------------
      let dialog = await openNewProject(page, name);
      await dialog.locator('[data-testid="start-method-tab"][data-method="core:init"]').click();
      await expect(dialog.getByTestId("start-method-description")).toHaveText("向こうのサーバにフォルダを作って git init します。");
      await chooseParent(page, dialog, host);
      await dialog.getByTestId("new-project-folder").fill("fresh");
      // Project 名は打つまでフォルダの名前
      await expect(dialog.getByLabel("Project 名")).toHaveValue("fresh");
      await dialog.getByTestId("new-project-submit").click();
      const initId = await createdProjectId(page, opened);
      const band = page.getByTestId("project-start-banner");
      // 初めての Module はコードを送ってから起きる——起こしている間の帯を見る
      await expect(band).toHaveAttribute("data-state", /waking|running/, { timeout: 30_000 });
      await expect(band.getByTestId("project-start-banner-text")).toContainText(/Module を起こしています|git init しています/);
      await expect.poll(() => startStatus(initId), { timeout: 900_000 }).toBe("done");
      await expect(band, "終わったのに帯が閉じない").toHaveCount(0);
      expect(await remote(host, "git -C ~/work/fresh symbolic-ref HEAD")).toBe("refs/heads/main");
      expect(await remote(host, "ls -A ~/work/fresh")).toBe(".git");
      const initRecord = await api<{ start?: { status: string; kind: string } }>(`/api/projects`);
      expect(JSON.stringify(initRecord.body)).toContain(`"kind":"init"`);
      await closeProject(initId);

      // ---- 2. clone（公開の https） -----------------------------------------------------------------
      dialog = await openNewProject(page, name);
      await dialog.locator('[data-testid="start-method-tab"][data-method="core:clone"]').click();
      await dialog.getByTestId("new-project-clone-url").fill(FAKE_URL);
      // フォルダの名前は URL の最後から .git を除いたもの。GitHub でないのでアカウントは出ない
      await expect(dialog.getByTestId("new-project-folder")).toHaveValue("hello");
      await expect(dialog.getByTestId("new-project-clone-account")).toHaveCount(0);
      await chooseParent(page, dialog, host);
      await dialog.getByTestId("new-project-submit").click();
      const cloneId = await createdProjectId(page, initId);
      await expect.poll(() => startStatus(cloneId), { timeout: 600_000 }).toBe("done");
      await expect(band, "clone が終わったのに帯が閉じない").toHaveCount(0);
      expect(await remote(host, "cat ~/work/hello/README.md")).toBe("hello from e2e");
      expect(await remote(host, "ls -A ~/work/hello | sort | tr '\\n' ' '")).toBe(".git .hidden-file README.md");
      expect(await remote(host, "git -C ~/work/hello log --format=%s")).toBe("first");
      await closeProject(cloneId);

      // ---- 3. 失敗 → 帯に理由と「もう一度」・「AI に頼む」 → 直してもう一度 -----------------------------------
      const missing = "https://git.e2e.invalid/e2e/later.git";
      dialog = await openNewProject(page, name);
      await dialog.locator('[data-testid="start-method-tab"][data-method="core:clone"]').click();
      await dialog.getByTestId("new-project-clone-url").fill(missing);
      await expect(dialog.getByTestId("new-project-folder")).toHaveValue("later");
      await chooseParent(page, dialog, host);
      await dialog.getByTestId("new-project-submit").click();
      const failId = await createdProjectId(page, cloneId);
      await expect(band).toHaveAttribute("data-state", "failed", { timeout: 300_000 });
      await expect(band).toContainText("clone できませんでした");
      await expect(band.getByTestId("project-start-banner-reason")).toContainText("git clone が失敗しました：");
      await expect(band.getByTestId("project-start-banner-reason")).toContainText("git.e2e.invalid");
      await expect(band.getByTestId("project-start-retry")).toBeVisible();
      // Project とフォルダは残り、作業フォルダは消えている
      expect(await remote(host, "ls -A ~/work/later | wc -l")).toBe("0");
      // 「AI に頼む」は入力欄に頼みを置く（送らない）
      await band.getByTestId("project-start-ask-ai").click();
      await expect(page.getByPlaceholder(/に送る/).first()).toHaveValue(new RegExp(`^${missing.replace(/[.]/g, "\\.")} を、この Project の Root（/home/${host.user}/work/later）に`));
      // 直して（偽の git の場所を足して）もう一度
      const fixed = await host.rootExec(`git config --system --add url.file:///srv/e2e/hello.git.insteadOf ${missing}`);
      expect(fixed.code, fixed.stderr).toBe(0);
      await band.getByTestId("project-start-retry").click();
      await expect.poll(() => startStatus(failId), { timeout: 300_000 }).toBe("done");
      await expect(band, "もう一度のあと帯が閉じない").toHaveCount(0);
      expect(await remote(host, "cat ~/work/later/README.md")).toBe("hello from e2e");
      expect(await remote(host, "ls -A ~/work/later | grep -c banto-clone || true")).toBe("0");
      await closeProject(failId);

      expect(pageErrors).toEqual([]);
    },
    { vaultAlias: alias },
  );
});
