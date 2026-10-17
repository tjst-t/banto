// **別のサーバの Project で会話する**（Backlog `remote-runtime-host-side`、`docs/specs/v4-security.md` §1「Project の記録に
// 実行場所を持つ」「host が Project のフォルダに直接触っていたもの」）。
//
// 起こし直しを見るので、自前の host（`own-host.ts`）を使い、そこに SSH で入れる相手（`ssh-host.ts`）を実行場所として
// 登録する。Project の根は、host にも同じパスのフォルダ（git のリポジトリ）がある場所にする——同じ文字列を同じフォルダと
// 見なしていないかを見るため。
//
// 見るもの（規則14——吹き出しが出たで終わらせず、記録と向こうの git の中身まで見る）：
//   1. 会話ができる：Runner は host の Project ごとの空のフォルダで走り（向こうのパスで走らない）、system prompt の root は
//      向こうのパスと実行場所の名前。Module（Backlog）の tool が向こうで動く
//   2. Backlog が向こうから origin へ push する（Repositories は引き受けない——向こうの git の設定のまま）。host の同じパスの
//      リポジトリには何も書かない
//   3. Repositories の一覧：host の同じパスのフォルダは「Project はまだ無い」のまま（別のサーバの Project と突き合わせない）
//   4. ターンの途中で banto が落ちて起き直すと、切れたターンが続き、最後まで走る（続きも host のフォルダで走る）
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { RUNTIME_KEYS_GROUP, withSshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコード（約 1GB）を送る
test.setTimeout(1_500_000);

const LINES = Array.from({ length: 20 }, (_, i) => `[${i + 1}]`);

interface HostThread {
  messages: Array<{ seq: number; role: string; text: string; origin?: { from: string; title: string } }>;
  lastTurn?: { attempt: number; cause: string; outcome?: string };
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

/** 人の管理操作（banto 全体の Module を画面と同じ口で呼ぶ） */
async function uiToolCall(host: OwnHost, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>(host, "/api/ui-tool-call", {
    method: "POST",
    body: { server, tool, arguments: args },
  });
  const text = r.body?.content?.[0]?.text ?? "";
  expect(r.status, `${server} の ${tool}：${JSON.stringify(r.body).slice(0, 500)}`).toBe(200);
  expect(r.body.isError, `${server} の ${tool}：${text}`).not.toBe(true);
  return text;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

test("別のサーバの Project で会話ができ、Backlog は向こうから push し、Repositories は突き合わせず、起こし直しても切れたターンが続く", async ({ page }) => {
  const name = `rh-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-rh-${Date.now()}`;
  // host にも同じパスのリポジトリを置く（Repositories の台帳に入れる）。向こうにも同じパスで作る
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-remote-host-side-"));
  git(root, ["init", "-q"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "host の側"]);
  const origin = `${root}/.git/e2e-origin.git`;
  try {
    await withSshHost(async (sshHost) => {
      const remoteGit = (args: string) => `git -c user.name=e2e -c user.email=e2e@example.com -c init.defaultBranch=main ${args}`;
      // 向こうの /home/ubuntu は相手のユーザーから辿れない（0750）——上のフォルダを辿れるようにする（試験の相手だけ）
      const made = await sshHost.rootExec(
        `set -e; d='${root}'; mkdir -p "$d"; chown ${sshHost.user}: "$d"; while [ "$d" != / ]; do d=$(dirname "$d"); chmod o+x "$d"; done`,
      );
      expect(made.code, made.stderr).toBe(0);
      const prepared = await sshHost.ssh(
        `set -e; cd '${root}'; ${remoteGit("init -q")}; ${remoteGit("commit -q --allow-empty -m 向こうの側")}; ` +
          `${remoteGit(`init -q --bare '${origin}'`)}; ${remoteGit(`remote add origin '${origin}'`)}`,
      );
      expect(prepared.code, prepared.stderr).toBe(0);

      await withOwnHost(async (own) => {
        // ---- 実行場所の登録と Project（画面は remote-runtime-registry.spec.ts で見ている。ここは API で） ---------------
        await uiToolCall(own, "vault-directory", "createAlias", {
          implementation: "vault-local",
          name: alias,
          kind: "ssh-identity",
          group: RUNTIME_KEYS_GROUP,
          value: readFileSync(sshHost.identityFile, "utf8"),
          note: "E2E の SSH の相手",
        });
        const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
        const scanned = await api<{ hostKey: { type: string; key: string } }>(own, "/api/runtimes/scan", { method: "POST", body: target });
        expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
        const registered = await api(own, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
        expect(registered.status, JSON.stringify(registered.body)).toBe(201);
        const projectName = `E2E 向こうで会話 ${name}`;
        const created = await api<{ id: string; root: string; runtime: string }>(own, "/api/projects", {
          method: "POST",
          body: { name: projectName, root, runtime: `remote:${name}` },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.root).toBe(root);
        const projectId = created.body.id;
        // 画面から作るときと同じく Base Thread を立てる（API の Project の作成は立てない）
        expect((await api(own, `/api/projects/${projectId}/threads`, { method: "POST" })).status).toBeLessThan(300);
        expect((await api(own, "/api/modules/catalog/backlog", { method: "POST", body: { name: "backlog" } })).status).toBeLessThan(300);
        // host の同じパスのリポジトリを Repositories の台帳に入れる
        await uiToolCall(own, "repositories", "import_repository", { path: root });

        const thread = async (): Promise<HostThread> => {
          const [t] = (await api<Array<{ id: string }>>(own, `/api/projects/${projectId}/threads`)).body;
          return (await api<HostThread>(own, `/api/threads/${t!.id}`)).body;
        };
        const runnerCwd = join(own.dataDir, "runner-cwd", projectId);

        await login(page, own);
        await openApp(page, own.url);
        await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
        const composer = page.getByPlaceholder(/に送る/).first();
        await expect(composer).toBeVisible({ timeout: 30_000 });

        // ---- 1・2. 会話ができ、Backlog の tool が向こうで動き、向こうから origin へ push する -------------------------
        const ITEM = "向こうの会話から足したタスク";
        await composer.fill(
          "タスクを足して。" +
            fakeTurn({
              say: "向こうの Project で足します。",
              sayCwd: true,
              saySystemPrompt: true,
              tools: [{ server: "backlog", name: "createItem", args: { kind: "task", title: ITEM } }],
              then: "足しました。",
            }),
        );
        await composer.press("Enter");
        // 承認を聞かれたら許す（Backlog の tool・Repositories への中継）。最後の発言が出るまで
        const allow = page.locator('[data-role="judgment-card"]').getByRole("button", { name: "許可する" });
        const done = page.getByText("足しました。", { exact: true });
        await expect
          .poll(
            async () => {
              if (await done.isVisible()) return "done";
              if ((await allow.count()) > 0) await allow.first().click().catch(() => undefined);
              return "waiting";
            },
            { timeout: 900_000, intervals: [1000], message: "向こうの Project の会話が終わらない（初回は向こうへコードを送る）" },
          )
          .toBe("done");
        await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 30_000 }).toBe("completed");
        const first = await thread();
        const said = first.messages.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
        expect(said, "Runner が host の Project ごとのフォルダで走っていない").toContain(`cwd=${runnerCwd}`);
        expect(said, "system prompt に向こうの root と実行場所が無い").toContain(
          `- root：${root}\n- 実行場所：別のサーバ「${name}」（root はそのサーバのパス。Module はそのサーバで動く）`,
        );
        // host の側の空のフォルダ（Runner の CLI の記録の鍵）。中に何も置かない
        expect(readdirSync(runnerCwd), "Runner のフォルダに何かを置いた").toEqual([]);

        // 向こう：一覧のブランチに足したものがあり、origin に送ってある
        const remoteHead = async (where: string) =>
          (await sshHost.ssh(`git -C '${where}' rev-parse --verify -q refs/heads/backlog || true`)).stdout.trim();
        await expect.poll(() => remoteHead(origin), { timeout: 60_000, message: "向こうの origin に送っていない" }).toMatch(/^[0-9a-f]{40}$/);
        expect(await remoteHead(origin)).toBe(await remoteHead(root));
        const tasks = (await sshHost.ssh(`git -C '${origin}' show refs/heads/backlog:tasks.json`)).stdout;
        expect((JSON.parse(tasks) as { items: Array<{ title: string }> }).items.map((i) => i.title)).toEqual([ITEM]);
        // host の同じパスのリポジトリには何も書いていない
        expect(git(root, ["for-each-ref", "--format=%(refname)"]).split("\n"), "host の同じパスに書いた").toEqual(["refs/heads/main"]);
        expect(existsSync(origin), "host の同じパスに origin ができた").toBe(false);

        // ---- 3. Repositories の一覧：host の同じパスのフォルダは、別のサーバの Project と突き合わせない -----------------
        const listed = JSON.parse(await uiToolCall(own, "repositories", "list_repositories", {})) as {
          rows: Array<{ path: string; section: string; projects?: Array<{ id: string }> }>;
          projectsError?: string;
        };
        expect(listed.projectsError).toBeUndefined();
        const row = listed.rows.find((r) => r.path === root);
        expect(row, "台帳に入れたフォルダが一覧に無い").toBeTruthy();
        expect(row!.section).toBe("unused");
        expect(row!.projects ?? []).toEqual([]);
        // 画面でも：「Project はまだ無い」の側に出て、「Project で使っている」には出ない
        await page.goto(`/settings?bantoHost=${own.url}`);
        await page.getByRole("button", { name: "Repositories", exact: true }).click();
        const pane = page.locator('[data-testid="module-settings-canvas"][data-module="repositories"]');
        await expect(pane).toBeVisible({ timeout: 30_000 });
        const inner = pane.locator("iframe").contentFrame().frameLocator("iframe");
        const repoRow = (group: string) => inner.locator(`[data-testid="repo-group"][data-group="${group}"] [data-testid="repo-item"][data-repo-path="${root}"]`);
        await expect(repoRow("unused"), "host のフォルダが「Project はまだ無い」に出ない").toBeVisible({ timeout: 30_000 });
        await expect(repoRow("used")).toHaveCount(0);
        await expect(inner.getByText(projectName)).toHaveCount(0);

        // ---- 4. ターンの途中で banto が落ちて起き直すと、切れたターンが続く --------------------------------------
        await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
        await expect(composer).toBeVisible({ timeout: 30_000 });
        const before = first.messages.length;
        await composer.fill("1 から 20 まで数えて。" + fakeTurn({ say: LINES.join("\n"), streamMs: 20_000, sayCwd: true }));
        await composer.press("Enter");
        await expect
          .poll(async () => (await thread()).messages.slice(before).find((m) => m.role === "assistant")?.text ?? "", {
            timeout: 120_000,
            message: "ターンが流れ始めない",
          })
          .toContain("[3]");
        expect((await thread()).lastTurn?.outcome, "落とす前にターンが終わった（試験の前提が崩れた）").toBeUndefined();

        await own.stop("SIGKILL");
        await own.start();

        await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 300_000, message: "続きのターンが終わらない" }).toBe("completed");
        const after = await thread();
        expect(after.lastTurn?.attempt, "続きのターンが attempt 1 で走っていない").toBe(1);
        const tail = after.messages.slice(before);
        expect(tail.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role))).toEqual(["user", "assistant", "delivered:banto", "assistant"]);
        expect(tail[1]!.text).toMatch(/\[3\][\s\S]*（起こし直しで切れました）$/);
        expect(tail[2]!.text).toContain("banto を起こし直したため");
        expect(tail[3]!.text).toContain("[20]");
        expect(tail[3]!.text, "続きのターンが host の Project ごとのフォルダで走っていない").toContain(`cwd=${runnerCwd}`);
        // 画面：切れた吹き出しの印と、続きが最後まで
        const assistants = page.locator('[data-role="assistant"]');
        await expect(assistants.last(), "続きが画面に出ない").toContainText("[20]", { timeout: 60_000 });
        await expect(assistants.filter({ hasText: "（起こし直しで切れました）" })).toHaveCount(1);
        await expect(page.getByTestId("delivered-message").last()).toHaveAttribute("data-from", "banto");
        // 会話を断る文言が出ていない（以前は別のサーバの Project のターンを断っていた）
        expect(after.messages.map((m) => m.text).join("\n")).not.toContain("会話（Runner）をまだ始められません");

        await api(own, `/api/projects/${projectId}/close`, { method: "POST" });
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
