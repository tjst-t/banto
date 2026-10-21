// **今あるフォルダをリポジトリにする画面**（`folder-adopter`、Backlog #502、v4-architecture.md §2.2「チャット」の
// 「Project にする」・v4-modules.md §2.4「core との境目」）。
//
// 本物の Repositories（banto 本体で動く）・本物の git・偽の GitHub（`github-login-fixture.ts`）で、チャットのフォルダ
// （置き場の形 `<日付>-<短い id>` の、git でないフォルダ）を：
//   1. 「GitHub に上げる」→ git init・最初のコミット（.gitignore に従う）・台帳に入り、GitHub に非公開で作られて push される
//   2. 「手元だけ」→ git init・最初のコミット・台帳だけ（GitHub には何も作らない）
//   3. 「作らない」→ 何もしない
// 画面が見せる値（選べるもの・アカウント・行き先の1行・名前のぶつかり・手順・結果）と、押せるかの通知まで1つずつ見る。
//
// **core の側は、この試験の中の小さな host が務める**——「Project にする」の画面（チャットの画面、Backlog #500 番台の
// chat-frontend）はまだ無いので、その画面が話すのと同じ口（hostContext の `dev.banto/folder-adopter`・request
// `dev.banto/adopt-folder`・notification `dev.banto/folder-adopter-state`、`apps/frontend/lib/backend/canvas-folder-adopter.ts`）
// を、本物の banto の画面の上で、本物のサンドボックスの口（別オリジン）越しに話す。tool の呼び出しは banto の画面と
// 同じ core の口（`/api/ui-tool-call`）へ渡す。ModuleCanvas の側の受け口は chat-frontend の試験が画面から見る
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { E2E_GITHUB_PAT, E2E_GITHUB_PAT_LOGIN, setGithubLoginFixture } from "../github-login-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const SERVER = "repositories";
const RESOURCE = "ui://banto-repositories/adopt-folder";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
/**
 * **この機械の本物の置き場と同じ形**（レビュー・2026-10-21）：`~/banto` は banto を clone したリポジトリで、`chats/` は
 * 追っておらず .gitignore にも無い——`~/banto/chats/<日付>-<id>` で git に聞くと `~/banto` の中と答える。人の `~/banto` には
 * 書かず、同じ形を一時フォルダに作る
 */
const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-chathome-")));
const bantoClone = join(home, "banto");
const chats = join(bantoClone, "chats");
test.beforeAll(() => {
  mkdirSync(bantoClone, { recursive: true });
  writeFileSync(join(bantoClone, "README.md"), "banto\n");
  writeFileSync(join(bantoClone, ".gitignore"), "node_modules/\n");
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], { cwd: bantoClone, stdio: "ignore" });
  g("init", "-q");
  g("add", ".");
  g("commit", "-q", "-m", "banto");
  mkdirSync(chats);
});
/** この spec が PAT のアカウントを登録したか（前からあったものは外さない） */
let addedAccount = false;
// **台帳とアカウントを元に戻す**（repositories-github-read.spec.ts と同じ作法）。残すと、次の spec の「台帳が空」が崩れ、
// アカウントだけが残って、替わり目に test-base が消した PAT の alias を指したままになる（次の spec がそのアカウントを
// 「もうある」と見て使い、alias が見つからずに落ちる）
test.afterAll(async ({ request }) => {
  const call = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    const res = await request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server: SERVER, tool, arguments: args } });
    const body = (await res.json()) as { isError?: boolean; content?: Array<{ text?: string }> };
    const text = body.content?.[0]?.text ?? "";
    expect(res.ok() && !body.isError, `${tool}: ${res.status()} ${text}`).toBe(true);
    return text;
  };
  // 台帳の行のうち、この spec の一時フォルダの下のもの（足したのは adopt だけ。途中で落ちても足した分だけ外す）
  const rows = (JSON.parse(await call("list_repositories", {})) as { rows: Array<{ path: string }> }).rows;
  for (const row of rows.filter((r) => r.path.startsWith(`${home}/`))) await call("remove_repository", { path: row.path });
  if (addedAccount) await call("remove_github_account", { login: E2E_GITHUB_PAT_LOGIN });
  rmSync(home, { recursive: true, force: true });
});

/** チャットの置き場の形のフォルダ（git でない・試作のファイル入り） */
function chatFolder(id: string): string {
  const dir = join(chats, `2026-10-21-${id}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<p>試作</p>\n");
  writeFileSync(join(dir, "src", "app.js"), "console.log(1);\n");
  writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
  writeFileSync(join(dir, "secret.txt"), "まだ見せない\n");
  return dir;
}

/** 画面が見せる形（home の下は `~/…`）。Module は home を同じ環境から読む */
function shown(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function callTool(page: Page, tool: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; text: string }> {
  const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server: SERVER, tool, arguments: args } });
  expect(res.ok(), `${tool}: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { isError?: boolean; content?: Array<{ text?: string }> };
  return { ...(body.isError ? { isError: true } : {}), text: body.content?.[0]?.text ?? "" };
}

/** 偽の GitHub の PAT のアカウントを登録しておく（前提——画面は repositories.spec.ts が見る）。もうあればそのまま */
async function ensurePatAccount(page: Page): Promise<void> {
  const listed = JSON.parse((await callTool(page, "list_github_accounts")).text) as { accounts: Array<{ login: string }> };
  if (listed.accounts.some((a) => a.login === E2E_GITHUB_PAT_LOGIN)) return;
  // 前の試験が Vault に残した PAT の alias があればそれを選ぶ（外しても PAT は残す決まり）、無ければ貼る
  const choices = JSON.parse((await callTool(page, "list_credential_aliases")).text) as {
    secrets: Array<{ name: string; implementation: string; group?: string }>;
  };
  const alias = choices.secrets.find((s) => s.name === `github-${E2E_GITHUB_PAT_LOGIN}-pat`);
  const added = await callTool(page, "add_github_account_with_pat", alias ? { patAlias: alias } : { pat: E2E_GITHUB_PAT });
  expect(added.isError, added.text).toBeFalsy();
  addedAccount = true;
}

interface Harness {
  canvas: FrameLocator;
  /** 画面が最後に言った「押せるか」 */
  state(): Promise<{ ready: boolean; choice: string; reason?: string } | undefined>;
  /** リポジトリの名前の案（・フォルダ）を替える——「Project にする」の画面で人が打ち替えたとき */
  setTarget(target: { path: string; name: string }): Promise<void>;
  /** 押す（core の画面の「Project にする」）。画面の答えか、断った理由 */
  adopt(target: { path: string; name: string }): Promise<{ result?: Record<string, unknown>; error?: string }>;
}

/**
 * banto の画面の上に、「Project にする」の画面と同じ口で話す小さな host を置く。サンドボックスの口は本物
 * （`/api/ui-config` の別オリジン）。画面の中の tool 呼び出しは core の `/api/ui-tool-call` へ（banto の画面と同じ）
 */
async function mountAdopter(page: Page, target: { path: string; name: string }): Promise<Harness> {
  await openApp(page);
  const config = (await (await page.request.get(`${CORE_BASE_URL}/api/ui-config`, { headers })).json()) as { sandboxUrl: string | null };
  expect(config.sandboxUrl, "サンドボックスの配信先が無い").toBeTruthy();
  const resource = (await (
    await page.request.get(`${CORE_BASE_URL}/api/ui-resource?server=${SERVER}&uri=${encodeURIComponent(RESOURCE)}`, { headers })
  ).json()) as { html: string };
  // 名乗りを core の一覧から確かめる（「Project にする」の画面はここから出す）
  const adopters = (await (await page.request.get(`${CORE_BASE_URL}/api/ui-folder-adopters`, { headers })).json()) as Array<{ server: string; resourceUri: string; name: string }>;
  expect(adopters).toEqual([{ server: SERVER, resourceUri: RESOURCE, name: "リポジトリ", description: expect.stringContaining("リポジトリ") }]);

  await page.exposeFunction("e2eCallTool", async (name: string, args: Record<string, unknown>) => {
    const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server: SERVER, tool: name, arguments: args } });
    return { ok: res.ok(), body: await res.json() };
  });
  await page.evaluate(
    ({ sandboxUrl, html, target }) => {
      const w = window as unknown as Record<string, unknown>;
      const frame = document.createElement("iframe");
      frame.id = "e2e-adopter";
      frame.src = `${sandboxUrl}/sandbox.html`;
      frame.style.cssText = "position:fixed;inset:40px;width:640px;height:600px;z-index:99999;background:white;border:1px solid #888";
      let context = { theme: "light", displayMode: "inline", "dev.banto/folder-adopter": target };
      const states: unknown[] = [];
      const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      let nextId = 1000;
      const post = (m: Record<string, unknown>) => frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...m }, new URL(sandboxUrl).origin);
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow) return;
        const msg = event.data as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
        if (msg.method === "ui/notifications/sandbox-proxy-ready") {
          post({ method: "ui/notifications/sandbox-resource-ready", params: { html, sandbox: "allow-scripts allow-same-origin allow-forms" } });
          return;
        }
        if (msg.method === "dev.banto/folder-adopter-state") { states.push(msg.params); return; }
        if (msg.id !== undefined && !msg.method) {
          const w8 = waiting.get(msg.id);
          waiting.delete(msg.id);
          if (msg.error) w8?.reject(new Error(msg.error.message));
          else w8?.resolve(msg.result);
          return;
        }
        if (msg.id === undefined) return;
        if (msg.method === "ui/initialize") {
          post({ id: msg.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "e2e", version: "0" }, hostCapabilities: {}, hostContext: context } });
          return;
        }
        if (msg.method === "tools/call") {
          const p = msg.params as { name: string; arguments?: Record<string, unknown> };
          const r = (await (w.e2eCallTool as (n: string, a: unknown) => Promise<{ ok: boolean; body: unknown }>)(p.name, p.arguments ?? {}));
          if (r.ok) post({ id: msg.id, result: r.body });
          else post({ id: msg.id, error: { code: -32000, message: JSON.stringify(r.body) } });
          return;
        }
        post({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      });
      w.e2eAdopter = {
        states,
        setTarget(next: { path: string; name: string }) {
          context = { ...context, "dev.banto/folder-adopter": next };
          post({ method: "ui/notifications/host-context-changed", params: { "dev.banto/folder-adopter": next } });
        },
        adopt(next: { path: string; name: string }) {
          const id = nextId++;
          post({ id, method: "dev.banto/adopt-folder", params: next });
          return new Promise((resolve, reject) => waiting.set(id, { resolve, reject })).then(
            (result) => ({ result }),
            (e: Error) => ({ error: e.message }),
          );
        },
      };
      document.body.appendChild(frame);
    },
    { sandboxUrl: config.sandboxUrl!, html: resource.html, target },
  );
  const canvas = page.frameLocator("#e2e-adopter").frameLocator("iframe");
  await expect(canvas.getByTestId("adopt-panel")).toBeVisible({ timeout: 30_000 });
  return {
    canvas,
    state: () => page.evaluate(() => {
      const s = ((window as unknown as { e2eAdopter: { states: unknown[] } }).e2eAdopter.states);
      return s[s.length - 1] as { ready: boolean; choice: string; reason?: string } | undefined;
    }),
    setTarget: (next) => page.evaluate((n) => (window as unknown as { e2eAdopter: { setTarget(t: unknown): void } }).e2eAdopter.setTarget(n), next),
    adopt: (next) =>
      page.evaluate((n) => (window as unknown as { e2eAdopter: { adopt(t: unknown): Promise<{ result?: Record<string, unknown>; error?: string }> } }).e2eAdopter.adopt(n), next),
  };
}

async function ledgerRow(page: Page, path: string): Promise<Record<string, unknown> | undefined> {
  const listing = JSON.parse((await callTool(page, "list_repositories")).text) as { rows: Array<Record<string, unknown>> };
  return listing.rows.find((r) => r.path === path);
}

test("「GitHub に上げる」：チャットのフォルダが git init・最初のコミット・台帳に入り、GitHub に非公開で作られて push される", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const suffix = Date.now().toString(36);
  const name = `chat-proto-${suffix}`;
  const taken = `taken-adopt-${suffix}`;
  const me = E2E_GITHUB_PAT_LOGIN;
  await setGithubLoginFixture({ addRepo: { owner: me, name: taken } });
  await ensurePatAccount(page);
  const dir = chatFolder(`gh${suffix}`);
  // 前提：本物の置き場と同じく、チャットのフォルダは上の banto のリポジトリの中と読まれる（追ってはいない）
  expect(gitOut(dir, "rev-parse", "--show-toplevel")).toBe(bantoClone);
  // .gitignore にも入っていない（check-ignore は入っていなければ 1 で終わる）
  expect(() => execFileSync("git", ["check-ignore", "-q", dir], { cwd: bantoClone, stdio: "ignore" }), "前提：chats は .gitignore に無い").toThrow();
  const parentHead = gitOut(bantoClone, "rev-parse", "HEAD");

  const h = await mountAdopter(page, { path: dir, name });
  const panel = h.canvas.getByTestId("adopt-panel");
  // 選べるもの：git でないフォルダなので「手元だけ（git init）」。GitHub に作れるアカウントがあるので、既定は GitHub
  const choices = panel.getByTestId("adopt-choice");
  await expect(choices).toHaveText(["GitHub に上げる", "手元だけ（git init）", "作らない"]);
  await expect(panel.locator('[data-testid="adopt-choice"][data-value="github"]')).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(panel.getByTestId("adopt-account-one")).toContainText(`${me} で作ります`, { timeout: 30_000 });
  await expect(panel.locator('[data-testid="adopt-visibility"][data-value="private"]')).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("adopt-github-note")).toHaveText(`github.com/${me}/${name} を非公開で作り、今あるファイルを最初のコミットにして上げます。`);
  await expect.poll(() => h.state()).toEqual({ ready: true, choice: "github" });
  await expect(panel.getByTestId("adopt-refusal")).toHaveCount(0);
  await expect(panel.getByTestId("adopt-nested-note")).toHaveText(
    `${shown(bantoClone)} のリポジトリの中ですが、そちらはこのフォルダを追っていないので、別のリポジトリとして作ります（${shown(bantoClone)} の履歴は変えません）。`,
  );

  // 人が「Project にする」の画面で名前を打ち替えた——GitHub にもうある名前なら、押せないと言う
  await h.setTarget({ path: dir, name: taken });
  await expect(panel.getByTestId("adopt-name-taken")).toContainText(`${me} には、もう ${taken} があります`, { timeout: 15_000 });
  await expect(panel.getByTestId("adopt-github-note")).toHaveText(`github.com/${me}/${taken} を非公開で作り、今あるファイルを最初のコミットにして上げます。`);
  await expect.poll(() => h.state()).toEqual({ ready: false, choice: "github", reason: `${me} には、もう ${taken} があります` });
  await h.setTarget({ path: dir, name });
  await expect(panel.getByTestId("adopt-name-taken")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => h.state()).toEqual({ ready: true, choice: "github" });

  // 押す（core の画面の「Project にする」）——上げ終わるまで待って結果を返す
  const out = await h.adopt({ path: dir, name });
  expect(out.error).toBeUndefined();
  expect(out.result).toMatchObject({
    choice: "github",
    path: dir,
    initialized: true,
    committed: true,
    summary: `github.com/${me}/${name} に非公開で上げました`,
    github: { owner: me, name },
  });
  const steps = panel.getByTestId("adopt-steps").locator("li");
  await expect(steps).toHaveText(["git init して、最初のコミットを作りました・一覧に足しました", `GitHub に ${me}/${name} を作って上げました`]);
  await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
  await expect(steps.nth(1)).toHaveAttribute("data-state", "done");
  await expect(panel.getByTestId("adopt-done")).toHaveText(` github.com/${me}/${name} に非公開で上げました`);
  // 終わったあとは選び直せない（もう一度押しても、もうしたと言う）
  await expect(panel.locator('[data-testid="adopt-choice"][data-value="local"]')).toBeDisabled();
  expect((await h.adopt({ path: dir, name })).error).toBe("もうリポジトリにしました");

  // フォルダ：入れ子の、自分のリポジトリ。最初のコミットは .gitignore に従った中身、いまのブランチは origin/main を追う
  expect(gitOut(dir, "rev-parse", "--show-toplevel")).toBe(dir);
  // 上の banto のリポジトリは変わらない
  expect(gitOut(bantoClone, "rev-parse", "HEAD")).toBe(parentHead);
  expect(gitOut(bantoClone, "ls-files").split("\n").sort()).toEqual([".gitignore", "README.md"]);
  expect(gitOut(dir, "log", "--format=%s")).toBe("Initial commit");
  expect(gitOut(dir, "ls-files").split("\n").sort()).toEqual([".gitignore", "index.html", "src/app.js"]);
  expect(gitOut(dir, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
  expect(gitOut(dir, "remote", "get-url", "origin")).toMatch(new RegExp(`/${me}/${name}\\.git$`));
  // 偽の GitHub が受けたもの：その持ち主・非公開
  expect((await setGithubLoginFixture({})).created.filter((c) => c.name === name)).toEqual([{ owner: me, name, private: true, by: me }]);
  // 台帳：GitHub の場所と扱うアカウント
  const row = await ledgerRow(page, dir);
  expect(row?.remote).toMatchObject({ kind: "github", owner: me, name });
  expect(row?.account).toEqual({ login: me, registered: true });
  expect(pageErrors).toEqual([]);
});

test("「手元だけ」は git init・最初のコミット・台帳だけ（GitHub には作らない）、「作らない」は何もしない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const suffix = Date.now().toString(36);
  const name = `chat-local-${suffix}`;
  await ensurePatAccount(page);
  const dir = chatFolder(`lo${suffix}`);
  expect(gitOut(dir, "rev-parse", "--show-toplevel"), "前提：上の banto のリポジトリの中").toBe(bantoClone);
  const createdBefore = (await setGithubLoginFixture({})).created.length;

  const h = await mountAdopter(page, { path: dir, name });
  const panel = h.canvas.getByTestId("adopt-panel");
  await expect(panel.getByTestId("adopt-account-one")).toBeVisible({ timeout: 30_000 });
  await panel.locator('[data-testid="adopt-choice"][data-value="local"]').click();
  await expect(panel.locator('[data-testid="adopt-choice"][data-value="local"]')).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("adopt-local-note")).toHaveText("git init して、今あるファイルを最初のコミットにします。GitHub にはあとで Repositories から上げられます。");
  await expect(panel.getByTestId("adopt-github-note")).toHaveCount(0);
  await expect.poll(() => h.state()).toEqual({ ready: true, choice: "local" });

  const out = await h.adopt({ path: dir, name });
  expect(out.error).toBeUndefined();
  expect(out.result).toMatchObject({ choice: "local", path: dir, initialized: true, committed: true, summary: `${shown(dir)} をリポジトリにしました` });
  expect(out.result?.github).toBeUndefined();
  await expect(panel.getByTestId("adopt-steps").locator("li")).toHaveText(["git init して、最初のコミットを作りました・一覧に足しました"]);
  await expect(panel.getByTestId("adopt-done")).toHaveText(` ${shown(dir)} をリポジトリにしました`);
  expect(gitOut(dir, "log", "--format=%s")).toBe("Initial commit");
  expect(gitOut(dir, "ls-files").split("\n").sort()).toEqual([".gitignore", "index.html", "src/app.js"]);
  expect(gitOut(dir, "rev-parse", "--show-toplevel")).toBe(dir);
  expect(gitOut(dir, "remote")).toBe("");
  expect((await setGithubLoginFixture({})).created.length, "GitHub に何か作った").toBe(createdBefore);
  const row = await ledgerRow(page, dir);
  expect(row?.remote).toEqual({ kind: "none" });

  // 上の banto のリポジトリが中のファイルを追っているフォルダは断る——選べるものは出さず、理由を出し、「作らない」で押せる
  const tracked = chatFolder(`tr${suffix}`);
  execFileSync("git", ["add", "--", tracked], { cwd: bantoClone, stdio: "ignore" });
  await page.close();
  const page3 = await page.context().newPage();
  page3.on("pageerror", (err) => pageErrors.push(err.message));
  const h3 = await mountAdopter(page3, { path: tracked, name: `chat-tracked-${suffix}` });
  const panel3 = h3.canvas.getByTestId("adopt-panel");
  await expect(panel3.getByTestId("adopt-refusal")).toHaveText(
    `${shown(tracked)} はリポジトリにできません：${shown(bantoClone)} のリポジトリが、このフォルダの中のファイルを追っています（入れ子のリポジトリにすると、同じファイルを2つのリポジトリが追うことになります）`,
    { timeout: 30_000 },
  );
  await expect(panel3.getByTestId("adopt-choice")).toHaveCount(0);
  await expect.poll(() => h3.state()).toEqual({ ready: true, choice: "none" });
  expect(existsSync(join(tracked, ".git"))).toBe(false);
  execFileSync("git", ["rm", "-q", "-r", "--cached", "--", tracked], { cwd: bantoClone, stdio: "ignore" });
  await page3.close();

  // 「作らない」——押しても何もしない
  const plain = chatFolder(`no${suffix}`);
  const page2 = await page.context().newPage();
  const h2 = await mountAdopter(page2, { path: plain, name: `chat-none-${suffix}` });
  const panel2 = h2.canvas.getByTestId("adopt-panel");
  await panel2.locator('[data-testid="adopt-choice"][data-value="none"]').click();
  await expect(panel2.getByTestId("adopt-none-note")).toHaveText("git を使わない Project にします（調べもの・書きものなど）。");
  await expect.poll(() => h2.state()).toEqual({ ready: true, choice: "none" });
  const none = await h2.adopt({ path: plain, name: `chat-none-${suffix}` });
  expect(none).toEqual({ result: { choice: "none", summary: "リポジトリは作りませんでした" } });
  expect(existsSync(join(plain, ".git"))).toBe(false);
  expect(await ledgerRow(page2, plain)).toBeUndefined();
  expect(pageErrors).toEqual([]);
});
